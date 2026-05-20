//! Export command — render the EDL to a final `.mp4`.
//!
//! For v1 the strategy is the simple "re-encode everything" path:
//!   ffmpeg -hwaccel videotoolbox <inputs> -filter_complex <concat> \
//!          -c:v h264_videotoolbox -b:v 8M -c:a aac -b:a 192k \
//!          -movflags +faststart -progress pipe:1 output.mp4
//!
//! Smart-cut (re-encode only at boundaries) is deferred to v1.1 per spec §6.7.

use crate::edl::{Chapter, ExportPreset, Project};
use crate::AppState;
use serde::Deserialize;
use std::fmt::Write as _;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;
use tokio::fs;

#[derive(Debug, Deserialize)]
pub struct ExportOpts {
    pub project: Project,
    #[serde(rename = "outputPath")]
    pub output_path: String,
    pub preset: ExportPreset,
    #[serde(rename = "videoBitrateKbps", default)]
    pub video_bitrate_kbps: Option<u32>,
    #[serde(rename = "audioBitrateKbps", default)]
    pub audio_bitrate_kbps: Option<u32>,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    #[serde(default)]
    pub fps: Option<f64>,
    #[serde(default)]
    pub codec: Option<String>,
}

#[tauri::command]
pub async fn export_video(
    app: AppHandle,
    state: State<'_, AppState>,
    opts: ExportOpts,
) -> Result<(), String> {
    // Build a list of (input_path, in, out) by walking the EDL in output order.
    let mut inputs: Vec<&String> = Vec::new();
    let mut clip_specs: Vec<(usize, f64, f64)> = Vec::new();
    for seg in &opts.project.segments {
        let media = opts
            .project
            .media
            .get(&seg.media_id)
            .ok_or_else(|| format!("unknown media: {}", seg.media_id))?;
        // Re-use the same input index when the same file appears multiple times.
        let idx = match inputs.iter().position(|p| **p == media.path) {
            Some(i) => i,
            None => {
                inputs.push(&media.path);
                inputs.len() - 1
            }
        };
        clip_specs.push((idx, seg.source_in, seg.source_out));
    }

    if clip_specs.is_empty() {
        return Err("nothing to export — EDL is empty".into());
    }

    // Compute total output duration up-front — needed both for the chapter
    // metadata and for progress reporting later.
    let total_duration = opts
        .project
        .segments
        .iter()
        .map(|s| (s.source_out - s.source_in).max(0.0))
        .sum::<f64>()
        .max(0.001);

    // Build the ffmetadata file (chapters) — only if any chapters exist.
    // The file is written to the system temp dir and removed after ffmpeg exits.
    let chapter_metadata = if opts.project.chapters.is_empty() {
        None
    } else {
        let path = tempfile_with_ext("ffmeta.txt");
        let body = build_chapter_ffmetadata(&opts.project.chapters, total_duration);
        if let Err(err) = fs::write(&path, body).await {
            log::warn!("failed to write chapter ffmetadata: {err}");
            None
        } else {
            Some(path)
        }
    };

    // Build the filter graph: trim each segment, then concat.
    let mut filter = String::new();
    let mut concat_inputs = String::new();
    let mut video_tail = String::new();
    if let (Some(w), Some(h)) = (opts.width, opts.height) {
        let _ = write!(video_tail, ",scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2");
    }
    if let Some(fps) = opts.fps {
        if fps > 0.0 {
            let _ = write!(video_tail, ",fps={fps}");
        }
    }

    for (i, (input_idx, sin, sout)) in clip_specs.iter().enumerate() {
        // Video and audio trims
        let _ = writeln!(
            filter,
            "[{input_idx}:v]trim=start={sin}:end={sout},setpts=PTS-STARTPTS{video_tail}[v{i}];\
             [{input_idx}:a]atrim=start={sin}:end={sout},asetpts=PTS-STARTPTS[a{i}];"
        );
        let _ = write!(concat_inputs, "[v{i}][a{i}]");
    }
    let _ = write!(
        filter,
        "{concat_inputs}concat=n={n}:v=1:a=1[outv][outa]",
        n = clip_specs.len()
    );

    // Build the argv
    let mut argv: Vec<String> = vec![
        "-y".into(),
        "-hide_banner".into(),
        "-hwaccel".into(),
        "videotoolbox".into(),
    ];
    for path in &inputs {
        argv.push("-i".into());
        argv.push(path.to_string());
    }
    // Chapter metadata is fed as one extra non-media input. -map_metadata <idx>
    // copies its global chapter info onto the output without disturbing video/audio.
    let chapter_input_index: Option<usize> = chapter_metadata.as_ref().map(|p| {
        let idx = inputs.len();
        argv.push("-i".into());
        argv.push(p.to_string_lossy().to_string());
        idx
    });
    argv.push("-filter_complex".into());
    argv.push(filter);

    // Map to outputs based on preset
    match opts.preset {
        ExportPreset::PodcastAudio => {
            argv.push("-map".into());
            argv.push("[outa]".into());
        }
        _ => {
            argv.push("-map".into());
            argv.push("[outv]".into());
            argv.push("-map".into());
            argv.push("[outa]".into());
        }
    }

    // After -map (which scopes the streams) but before codec args, copy the
    // chapter info onto the output. -map_metadata uses *file* index, hence the
    // index we recorded when we appended -i.
    if let Some(idx) = chapter_input_index {
        argv.push("-map_metadata".into());
        argv.push(idx.to_string());
    }

    // Preset → codec / bitrate
    let video_codec = match opts.codec.as_deref() {
        Some("hevc") => "hevc_videotoolbox",
        _ => "h264_videotoolbox",
    };

    match opts.preset {
        ExportPreset::Youtube1080p => {
            let vb = opts.video_bitrate_kbps.unwrap_or(8000);
            let ab = opts.audio_bitrate_kbps.unwrap_or(192);
            argv.extend([
                "-c:v".into(), video_codec.into(),
                "-b:v".into(), format!("{vb}k"),
                "-c:a".into(), "aac".into(),
                "-b:a".into(), format!("{ab}k"),
                "-movflags".into(), "+faststart".into(),
            ]);
        }
        ExportPreset::PodcastAudio => {
            let ab = opts.audio_bitrate_kbps.unwrap_or(128);
            argv.extend([
                "-vn".into(),
                "-c:a".into(), "aac".into(),
                "-b:a".into(), format!("{ab}k"),
            ]);
        }
        ExportPreset::Custom => {
            let vb = opts.video_bitrate_kbps.unwrap_or(8000);
            let ab = opts.audio_bitrate_kbps.unwrap_or(192);
            argv.extend([
                "-c:v".into(), video_codec.into(),
                "-b:v".into(), format!("{vb}k"),
                "-c:a".into(), "aac".into(),
                "-b:a".into(), format!("{ab}k"),
                "-movflags".into(), "+faststart".into(),
            ]);
        }
    }

    // Progress to stdout (machine-readable)
    argv.extend(["-progress".into(), "pipe:1".into()]);
    argv.push(opts.output_path.clone());

    log::info!("ffmpeg {}", argv.join(" "));

    // Spawn
    let shell = app.shell();
    let cmd = shell
        .sidecar("ffmpeg")
        .map_err(|e| format!("ffmpeg sidecar: {e}"))?
        .args(argv);
    let (mut rx, child) = cmd.spawn().map_err(|e| format!("spawn ffmpeg: {e}"))?;
    *state.export.child.lock().await = Some(child);

    // `total_duration` is computed earlier (chapters use it too).
    while let Some(ev) = rx.recv().await {
        match ev {
            CommandEvent::Stdout(buf) => {
                let s = String::from_utf8_lossy(&buf);
                for line in s.lines() {
                    if let Some(rest) = line.strip_prefix("out_time_ms=") {
                        if let Ok(us) = rest.trim().parse::<u64>() {
                            let secs = us as f64 / 1_000_000.0;
                            let progress = (secs / total_duration).clamp(0.0, 1.0);
                            let eta = if progress > 0.001 {
                                Some(((total_duration - secs).max(0.0)) as i64)
                            } else {
                                None
                            };
                            app.emit(
                                "export:progress",
                                serde_json::json!({
                                    "progress": progress,
                                    "outputTimeSec": secs,
                                    "etaSec": eta,
                                }),
                            )
                            .ok();
                        }
                    }
                }
            }
            CommandEvent::Stderr(_) => { /* ffmpeg writes a lot of stuff here; ignore */ }
            CommandEvent::Terminated(t) => {
                *state.export.child.lock().await = None;
                if let Some(p) = &chapter_metadata {
                    let _ = fs::remove_file(p).await;
                }
                if t.code != Some(0) {
                    return Err(format!("ffmpeg exited with code {:?}", t.code));
                }
                app.emit("export:progress", serde_json::json!({
                    "progress": 1.0, "outputTimeSec": total_duration, "etaSec": 0i64,
                })).ok();
                return Ok(());
            }
            _ => {}
        }
    }

    if let Some(p) = &chapter_metadata {
        let _ = fs::remove_file(p).await;
    }
    Ok(())
}

/// Build an FFmetadata file containing one [CHAPTER] block per chapter.
/// ffmpeg expects per-chapter START/END in TIMEBASE units; we use 1/1000 so
/// times are simply integer milliseconds. The exporter clamps end-of-file
/// using the total output duration so the last chapter gets a sensible END.
fn build_chapter_ffmetadata(chapters: &[Chapter], total_duration_sec: f64) -> String {
    // Sort defensively — the frontend already sorts, but a manually-edited
    // .scribe file could be out of order.
    let mut sorted: Vec<&Chapter> = chapters.iter().collect();
    sorted.sort_by(|a, b| a.output_time.partial_cmp(&b.output_time).unwrap_or(std::cmp::Ordering::Equal));

    let mut out = String::from(";FFMETADATA1\n");
    for (i, c) in sorted.iter().enumerate() {
        let start_ms = (c.output_time.max(0.0) * 1000.0).round() as u64;
        let end_ms = if i + 1 < sorted.len() {
            (sorted[i + 1].output_time.max(0.0) * 1000.0).round() as u64
        } else {
            (total_duration_sec.max(c.output_time) * 1000.0).round() as u64
        };
        // Chapter blocks need title on its own line; escape backslashes/=.
        let safe_title = c
            .title
            .replace('\\', "\\\\")
            .replace('=', "\\=")
            .replace(';', "\\;")
            .replace('#', "\\#")
            .replace('\n', " ");
        let _ = writeln!(out, "[CHAPTER]");
        let _ = writeln!(out, "TIMEBASE=1/1000");
        let _ = writeln!(out, "START={start_ms}");
        let _ = writeln!(out, "END={end_ms}");
        let _ = writeln!(out, "title={safe_title}");
    }
    out
}

fn tempfile_with_ext(ext: &str) -> std::path::PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!("scribe-{}.{}", uuid::Uuid::new_v4(), ext));
    p
}

#[tauri::command]
pub async fn cancel_export(state: State<'_, AppState>) -> Result<(), String> {
    let mut guard = state.export.child.lock().await;
    if let Some(child) = guard.take() {
        // kill() is synchronous in tauri-plugin-shell 2.x — no .await
        let _ = child.kill();
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests for the filter graph builder (broken out to make it testable)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use crate::edl::{ExportPreset, Project, ProjectSettings, Segment, SourceMedia, Word};
    use std::collections::HashMap;

    /// Sanity check: an EDL with two segments produces two trim filters and a
    /// concat with n=2. The real filter is computed inline in `export_video`;
    /// we replicate the relevant bit here to keep the test independent.
    fn build_filter_for_test(project: &Project) -> String {
        let mut filter = String::new();
        use std::fmt::Write as _;
        let mut inputs: Vec<&String> = Vec::new();
        let mut specs: Vec<(usize, f64, f64)> = Vec::new();
        for seg in &project.segments {
            let media = project.media.get(&seg.media_id).unwrap();
            let idx = match inputs.iter().position(|p| **p == media.path) {
                Some(i) => i,
                None => {
                    inputs.push(&media.path);
                    inputs.len() - 1
                }
            };
            specs.push((idx, seg.source_in, seg.source_out));
        }
        let mut concat_inputs = String::new();
        for (i, (idx, sin, sout)) in specs.iter().enumerate() {
            let _ = writeln!(
                filter,
                "[{idx}:v]trim=start={sin}:end={sout},setpts=PTS-STARTPTS[v{i}];[{idx}:a]atrim=start={sin}:end={sout},asetpts=PTS-STARTPTS[a{i}];"
            );
            let _ = write!(concat_inputs, "[v{i}][a{i}]");
        }
        let _ = write!(filter, "{concat_inputs}concat=n={n}:v=1:a=1[outv][outa]", n = specs.len());
        filter
    }

    fn fixture() -> Project {
        let mut media = HashMap::new();
        media.insert(
            "m".to_string(),
            SourceMedia {
                id: "m".into(),
                path: "/tmp/x.mp4".into(),
                duration: 10.0,
                fps: 30.0,
                width: 1920,
                height: 1080,
                audio_sample_rate: 48000,
                sha256: "deadbeef".into(),
            },
        );
        Project {
            version: 1,
            id: "p".into(),
            name: "p".into(),
            created_at: "x".into(),
            updated_at: "x".into(),
            media,
            segments: vec![
                Segment {
                    id: "s1".into(),
                    media_id: "m".into(),
                    words: vec![Word {
                        id: "w".into(),
                        text: "x".into(),
                        start: 0.0,
                        end: 1.0,
                        confidence: 1.0,
                        speaker: None,
                    }],
                    source_in: 0.0,
                    source_out: 2.0,
                },
                Segment {
                    id: "s2".into(),
                    media_id: "m".into(),
                    words: vec![],
                    source_in: 5.0,
                    source_out: 7.0,
                },
            ],
            settings: ProjectSettings {
                export_preset: ExportPreset::Youtube1080p,
                padding_ms: 80,
            },
            chapters: vec![],
        }
    }

    #[test]
    fn builds_two_segment_concat() {
        let filter = build_filter_for_test(&fixture());
        assert!(filter.contains("[0:v]trim=start=0:end=2"));
        assert!(filter.contains("[0:v]trim=start=5:end=7"));
        assert!(filter.contains("concat=n=2:v=1:a=1[outv][outa]"));
    }

    #[test]
    fn ffmetadata_emits_one_block_per_chapter_with_ms_timebase() {
        use crate::edl::Chapter;
        let chapters = vec![
            Chapter { id: "1".into(), output_time: 0.0, title: "Intro".into() },
            Chapter { id: "2".into(), output_time: 12.5, title: "Demo".into() },
        ];
        let text = super::build_chapter_ffmetadata(&chapters, 30.0);
        assert!(text.starts_with(";FFMETADATA1\n"));
        assert_eq!(text.matches("[CHAPTER]").count(), 2);
        assert!(text.contains("TIMEBASE=1/1000"));
        assert!(text.contains("START=0\nEND=12500"));
        assert!(text.contains("START=12500\nEND=30000"));
        assert!(text.contains("title=Intro"));
        assert!(text.contains("title=Demo"));
    }

    #[test]
    fn ffmetadata_escapes_special_characters_in_titles() {
        use crate::edl::Chapter;
        let chapters = vec![Chapter {
            id: "1".into(),
            output_time: 0.0,
            title: "a=b;c#d\\e".into(),
        }];
        let text = super::build_chapter_ffmetadata(&chapters, 10.0);
        assert!(text.contains("title=a\\=b\\;c\\#d\\\\e"));
    }
}
