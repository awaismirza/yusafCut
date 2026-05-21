//! Export command — render the EDL to a final `.mp4`.
//!
//! Two paths:
//!
//!   1. **Smart-cut** (`crate::smart_cut`) — stream-copy long interiors,
//!      re-encode only the few hundred frames either side of each cut. Used
//!      whenever the EDL is "simple" (single source, no codec / resolution /
//!      fps override, no music beds). 10-50× faster on long-form content.
//!
//!   2. **Full re-encode** — runs every frame through `h264_videotoolbox`
//!      via a filter_complex graph. Used as a fallback and whenever
//!      eligibility checks fail.
//!
//! Both paths share:
//!   * Job-queue registration so the UI shows a cancellable job entry.
//!   * `export:progress` events for the toolbar progress bar.
//!   * Chapter ffmetadata copy via `-map_metadata`.
//!   * Audio-track mixing under the main voice (full re-encode path only).

use crate::edl::{Chapter, ExportPreset, Project};
use crate::jobs::{JobHandle, JobKind};
use crate::smart_cut::{self, Chunk, ChunkKind};
use crate::AppState;
use serde::Deserialize;
use std::fmt::Write as _;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;
use tokio::fs;

#[derive(Debug, Deserialize, Clone)]
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
    /// If true, skip smart-cut and force the full re-encode path. Used by
    /// the UI's "Force re-encode" advanced toggle.
    #[serde(rename = "forceReencode", default)]
    pub force_reencode: bool,
}

#[tauri::command]
pub async fn export_video(
    app: AppHandle,
    state: State<'_, AppState>,
    opts: ExportOpts,
) -> Result<(), String> {
    // Create the job *before* acquiring the serialisation lock so a queued
    // second export shows up in the Jobs flyout immediately as "Queued"
    // rather than vanishing into a blocked await.
    let title = export_job_title(&opts);
    let job = state.jobs.create(&app, JobKind::Export, title).await;

    // Serialize: only one export at a time. The lock is per-kind so the
    // second export waits here until the first finishes.
    let _serial = state.jobs.serialise(JobKind::Export).await;
    job.mark_running().await;

    let result = run_export(&app, &state, &opts, &job).await;

    match &result {
        Ok(()) => job.mark_completed().await,
        Err(e) => {
            // If the user pressed cancel, we get an ffmpeg non-zero exit. Tag
            // that as cancelled rather than failed so the Jobs flyout reads
            // cleanly.
            if job.is_cancelled() {
                job.mark_cancelled().await;
            } else {
                job.mark_failed(e.clone()).await;
            }
        }
    }

    result
}

fn export_job_title(opts: &ExportOpts) -> String {
    let name = std::path::Path::new(&opts.output_path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("export.mp4");
    format!("Exporting → {name}")
}

async fn run_export(
    app: &AppHandle,
    state: &State<'_, AppState>,
    opts: &ExportOpts,
    job: &JobHandle,
) -> Result<(), String> {
    // Compute total duration up-front — used for chapter metadata + progress.
    let total_duration = opts
        .project
        .segments
        .iter()
        .map(|s| (s.source_out - s.source_in).max(0.0))
        .sum::<f64>()
        .max(0.001);

    if opts.project.segments.is_empty() {
        return Err("nothing to export — EDL is empty".into());
    }

    // Decide which path to take. Smart-cut needs a "clean" single-source EDL
    // with no codec/res/fps overrides and no music beds. Anything else falls
    // back to the full re-encode.
    let audio_only = matches!(opts.preset, ExportPreset::PodcastAudio);
    let eligible = !opts.force_reencode
        && smart_cut::is_eligible(
            &opts.project,
            opts.codec.as_deref(),
            opts.width,
            opts.height,
            opts.fps,
            audio_only,
        );

    let chapter_meta = build_chapter_metadata_file(&opts.project.chapters, total_duration).await;

    if eligible {
        match try_smart_cut(app, state, opts, job, total_duration, chapter_meta.as_ref()).await {
            Ok(()) => return Ok(()),
            Err(SmartCutError::Skip(reason)) => {
                log::warn!("smart-cut not viable ({reason}); falling back to full re-encode");
            }
            Err(SmartCutError::Hard(msg)) => return Err(msg),
        }
    }

    full_reencode(app, state, opts, job, total_duration, chapter_meta).await
}

// ---------------------------------------------------------------------------
// Chapter metadata helper
// ---------------------------------------------------------------------------

async fn build_chapter_metadata_file(
    chapters: &[Chapter],
    total_duration: f64,
) -> Option<PathBuf> {
    if chapters.is_empty() {
        return None;
    }
    let path = tempfile_with_ext("ffmeta.txt");
    let body = build_chapter_ffmetadata(chapters, total_duration);
    if let Err(err) = fs::write(&path, body).await {
        log::warn!("failed to write chapter ffmetadata: {err}");
        return None;
    }
    Some(path)
}

// ---------------------------------------------------------------------------
// Smart-cut path
// ---------------------------------------------------------------------------

enum SmartCutError {
    /// Eligibility passed but something prevented smart-cut at runtime (no
    /// keyframes, ffprobe failed, etc). Caller falls back to full re-encode.
    Skip(String),
    /// Unrecoverable — error out instead of falling back.
    Hard(String),
}

impl From<String> for SmartCutError {
    fn from(s: String) -> Self {
        SmartCutError::Hard(s)
    }
}

async fn try_smart_cut(
    app: &AppHandle,
    state: &State<'_, AppState>,
    opts: &ExportOpts,
    job: &JobHandle,
    total_duration: f64,
    chapter_meta: Option<&PathBuf>,
) -> Result<(), SmartCutError> {
    // We've already proven all segments share a single source.
    let source_path = {
        let first = &opts.project.segments[0];
        opts.project
            .media
            .get(&first.media_id)
            .ok_or_else(|| SmartCutError::Skip(format!("unknown media: {}", first.media_id)))?
            .path
            .clone()
    };

    // Probe keyframes once for the source. If the file has no usable
    // keyframes (some screen recordings, exotic codecs) drop back to full.
    let kfs = smart_cut::probe_keyframes(app, &source_path)
        .await
        .map_err(|e| SmartCutError::Skip(format!("keyframe probe: {e}")))?;
    if kfs.len() < 3 {
        return Err(SmartCutError::Skip("source has too few keyframes".into()));
    }

    // Apply the same cut-point pre-roll padding as the full-reencode path so
    // smart-cut exports are equally protected against consonant clipping.
    let pad_secs = opts.project.settings.padding_ms as f64 / 1000.0;

    // Plan chunks for every segment.
    let mut plans: Vec<Vec<Chunk>> = Vec::with_capacity(opts.project.segments.len());
    let mut total_chunks = 0usize;
    let mut copyable = 0.0f64;
    let mut reencode_secs = 0.0f64;
    for seg in &opts.project.segments {
        let padded_in = (seg.source_in - pad_secs).max(0.0);
        let chunks = smart_cut::plan_segment(padded_in, seg.source_out, &kfs);
        for c in &chunks {
            match c.kind {
                ChunkKind::Copy => copyable += c.duration(),
                ChunkKind::Reencode => reencode_secs += c.duration(),
            }
        }
        total_chunks += chunks.len();
        plans.push(chunks);
    }

    // If nothing is copyable, smart-cut buys us nothing — bail.
    if copyable < smart_cut::MIN_COPY_DURATION {
        return Err(SmartCutError::Skip(
            "no segment had a long enough keyframe interior to copy".into(),
        ));
    }

    log::info!(
        "smart-cut plan: {} chunks across {} segments — {:.1}s copy, {:.1}s re-encode",
        total_chunks,
        plans.len(),
        copyable,
        reencode_secs
    );

    // Workdir for all the intermediates.
    let workdir = tempfile_with_ext("smartcut-work");
    fs::create_dir_all(&workdir)
        .await
        .map_err(|e| SmartCutError::Hard(format!("workdir: {e}")))?;

    // Make every chunk. We weight progress by *seconds processed*: copy
    // chunks count cheaply (10× faster), re-encode chunks count by wall-time.
    // For simplicity, attribute progress proportionally to chunk *duration*.
    let mut chunk_files: Vec<PathBuf> = Vec::with_capacity(total_chunks);
    let mut processed_secs = 0.0f64;
    let video_codec = pick_video_codec(opts);
    let vbitrate = opts.video_bitrate_kbps.unwrap_or(8000);
    let abitrate = opts.audio_bitrate_kbps.unwrap_or(192);

    for chunks in &plans {
        for chunk in chunks {
            // Honour cancel between chunks. The kill is performed by the
            // cancel_job command — here we just bail.
            if job.is_cancelled() {
                let _ = fs::remove_dir_all(&workdir).await;
                if let Some(p) = chapter_meta {
                    let _ = fs::remove_file(p).await;
                }
                return Err(SmartCutError::Hard("cancelled".into()));
            }

            let out = workdir.join(format!("chunk-{:04}.mp4", chunk_files.len()));
            match chunk.kind {
                ChunkKind::Copy => {
                    smart_cut_copy_chunk(app, state, &source_path, chunk, &out)
                        .await
                        .map_err(SmartCutError::Hard)?;
                }
                ChunkKind::Reencode => {
                    smart_cut_reencode_chunk(
                        app, state, &source_path, chunk, video_codec, vbitrate, abitrate, &out,
                    )
                    .await
                    .map_err(SmartCutError::Hard)?;
                }
            }
            chunk_files.push(out);

            processed_secs += chunk.duration();
            let p = (processed_secs / total_duration).clamp(0.0, 0.98);
            // Use 0..0.98 for chunk render so the final concat pass can claim
            // the last 2%.
            let secs_remaining = (total_duration - processed_secs).max(0.0) as i64;
            job.set_progress(p, Some(secs_remaining)).await;
            app.emit(
                "export:progress",
                serde_json::json!({
                    "progress": p,
                    "outputTimeSec": processed_secs,
                    "etaSec": secs_remaining,
                }),
            )
            .ok();
        }
    }

    // Concat list
    let list_path = workdir.join("concat.txt");
    let mut list = String::new();
    for f in &chunk_files {
        // ffmpeg concat demuxer requires single-quoted, backslash-escaped paths.
        let escaped = f.to_string_lossy().replace('\'', "'\\''");
        let _ = writeln!(list, "file '{escaped}'");
    }
    fs::write(&list_path, list)
        .await
        .map_err(|e| SmartCutError::Hard(format!("writing concat list: {e}")))?;

    concat_chunks(app, state, &list_path, chapter_meta, &opts.output_path)
        .await
        .map_err(SmartCutError::Hard)?;

    let _ = fs::remove_dir_all(&workdir).await;
    if let Some(p) = chapter_meta {
        let _ = fs::remove_file(p).await;
    }

    job.set_progress(1.0, Some(0)).await;
    app.emit(
        "export:progress",
        serde_json::json!({
            "progress": 1.0,
            "outputTimeSec": total_duration,
            "etaSec": 0i64,
        }),
    )
    .ok();
    Ok(())
}

fn pick_video_codec(opts: &ExportOpts) -> &'static str {
    match opts.codec.as_deref() {
        Some("hevc") => "hevc_videotoolbox",
        _ => "h264_videotoolbox",
    }
}

/// Stream-copy a single sub-range of the source into an MP4.
async fn smart_cut_copy_chunk(
    app: &AppHandle,
    state: &State<'_, AppState>,
    source: &str,
    chunk: &Chunk,
    out: &PathBuf,
) -> Result<(), String> {
    let argv: Vec<String> = vec![
        "-y".into(),
        "-hide_banner".into(),
        // -ss before -i means a keyframe seek, which is what we want for copy.
        "-ss".into(), format!("{:.6}", chunk.chunk_in),
        "-to".into(), format!("{:.6}", chunk.chunk_out),
        "-i".into(), source.into(),
        "-c".into(), "copy".into(),
        // Reset timestamps so the concat demuxer doesn't trip on monotonic-PTS.
        "-avoid_negative_ts".into(), "make_zero".into(),
        out.to_string_lossy().to_string(),
    ];
    run_ffmpeg(app, state, &argv).await
}

/// Re-encode a small sub-range, sharing codec parameters with the copy chunks
/// so the concat demuxer can splice them with `-c copy`.
#[allow(clippy::too_many_arguments)]
async fn smart_cut_reencode_chunk(
    app: &AppHandle,
    state: &State<'_, AppState>,
    source: &str,
    chunk: &Chunk,
    video_codec: &str,
    video_bitrate_kbps: u32,
    audio_bitrate_kbps: u32,
    out: &PathBuf,
) -> Result<(), String> {
    let argv: Vec<String> = vec![
        "-y".into(),
        "-hide_banner".into(),
        // For re-encode we want frame-accurate trim — put -ss after -i.
        "-i".into(), source.into(),
        "-ss".into(), format!("{:.6}", chunk.chunk_in),
        "-to".into(), format!("{:.6}", chunk.chunk_out),
        "-c:v".into(), video_codec.into(),
        "-b:v".into(), format!("{video_bitrate_kbps}k"),
        "-c:a".into(), "aac".into(),
        "-b:a".into(), format!("{audio_bitrate_kbps}k"),
        // Force a keyframe at the start so the next chunk concats cleanly.
        "-force_key_frames".into(), "expr:eq(n,0)".into(),
        "-avoid_negative_ts".into(), "make_zero".into(),
        out.to_string_lossy().to_string(),
    ];
    run_ffmpeg(app, state, &argv).await
}

/// Run the final concat-demuxer pass to glue the chunks together. Adds chapter
/// metadata if present.
async fn concat_chunks(
    app: &AppHandle,
    state: &State<'_, AppState>,
    list_path: &PathBuf,
    chapter_meta: Option<&PathBuf>,
    output_path: &str,
) -> Result<(), String> {
    let mut argv: Vec<String> = vec![
        "-y".into(),
        "-hide_banner".into(),
        "-f".into(), "concat".into(),
        "-safe".into(), "0".into(),
        "-i".into(), list_path.to_string_lossy().to_string(),
    ];
    if let Some(p) = chapter_meta {
        argv.push("-i".into());
        argv.push(p.to_string_lossy().to_string());
        argv.push("-map_metadata".into());
        argv.push("1".into());
    }
    argv.extend([
        "-c".into(), "copy".into(),
        "-movflags".into(), "+faststart".into(),
        output_path.into(),
    ]);
    run_ffmpeg(app, state, &argv).await
}

/// Run a single ffmpeg invocation and surface its child handle through
/// AppState so cancel_job can kill it.
async fn run_ffmpeg(
    app: &AppHandle,
    state: &State<'_, AppState>,
    argv: &[String],
) -> Result<(), String> {
    let shell = app.shell();
    let cmd = shell
        .sidecar("ffmpeg")
        .map_err(|e| format!("ffmpeg sidecar: {e}"))?
        .args(argv);
    let (mut rx, child) = cmd.spawn().map_err(|e| format!("spawn ffmpeg: {e}"))?;
    *state.export.child.lock().await = Some(child);
    while let Some(ev) = rx.recv().await {
        if let CommandEvent::Terminated(t) = ev {
            *state.export.child.lock().await = None;
            if t.code != Some(0) {
                return Err(format!("ffmpeg exited with code {:?}", t.code));
            }
            return Ok(());
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Full re-encode path (the v2.1 behaviour, now with music-bed mixing).
// ---------------------------------------------------------------------------

async fn full_reencode(
    app: &AppHandle,
    state: &State<'_, AppState>,
    opts: &ExportOpts,
    job: &JobHandle,
    total_duration: f64,
    chapter_meta: Option<PathBuf>,
) -> Result<(), String> {
    // Cut-point pre-roll padding: pull each segment's source_in back by
    // padding_ms so word-initial consonants aren't clipped when Whisper's
    // timestamps land a few milliseconds late. We only extend the start (not
    // the end) to avoid overlapping with adjacent segments' content.
    let pad_secs = opts.project.settings.padding_ms as f64 / 1000.0;

    // Build a list of (input_path, in, out) by walking the EDL in output order.
    let mut inputs: Vec<&String> = Vec::new();
    let mut clip_specs: Vec<(usize, f64, f64)> = Vec::new();
    for seg in &opts.project.segments {
        let media = opts
            .project
            .media
            .get(&seg.media_id)
            .ok_or_else(|| format!("unknown media: {}", seg.media_id))?;
        let idx = match inputs.iter().position(|p| **p == media.path) {
            Some(i) => i,
            None => {
                inputs.push(&media.path);
                inputs.len() - 1
            }
        };
        clip_specs.push((idx, (seg.source_in - pad_secs).max(0.0), seg.source_out));
    }

    // Build the segment filter graph (trim each segment, concat into [outv][outa]).
    let mut filter = String::new();
    let mut concat_inputs = String::new();
    let mut video_tail = String::new();
    if let (Some(w), Some(h)) = (opts.width, opts.height) {
        let _ = write!(
            video_tail,
            ",scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2"
        );
    }
    if let Some(fps) = opts.fps {
        if fps > 0.0 {
            let _ = write!(video_tail, ",fps={fps}");
        }
    }
    for (i, (input_idx, sin, sout)) in clip_specs.iter().enumerate() {
        let _ = writeln!(
            filter,
            "[{input_idx}:v]trim=start={sin}:end={sout},setpts=PTS-STARTPTS{video_tail}[v{i}];\
             [{input_idx}:a]atrim=start={sin}:end={sout},asetpts=PTS-STARTPTS[a{i}];"
        );
        let _ = write!(concat_inputs, "[v{i}][a{i}]");
    }
    let _ = write!(
        filter,
        "{concat_inputs}concat=n={n}:v=1:a=1[outv][mainvox]",
        n = clip_specs.len()
    );

    // Music-bed mixing. We track the music input indices as we add them, then
    // append filter rules to mix them under [mainvox] → [outa].
    let voice_label = "mainvox";
    let final_audio_label = if opts.project.audio_tracks.is_empty() {
        // No music — just route mainvox straight through.
        let _ = write!(filter, ";[{voice_label}]anull[outa]");
        "outa".to_string()
    } else {
        append_music_bed_filters(
            &mut filter,
            &mut inputs,
            voice_label,
            &opts.project,
            total_duration,
        )?;
        "outa".to_string()
    };

    // Build the argv now that we know the input list (incl. music files).
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
    // Chapter metadata as one extra non-media input.
    let chapter_input_index: Option<usize> = chapter_meta.as_ref().map(|p| {
        let idx = inputs.len();
        argv.push("-i".into());
        argv.push(p.to_string_lossy().to_string());
        idx
    });
    argv.push("-filter_complex".into());
    argv.push(filter);

    // Mapping
    match opts.preset {
        ExportPreset::PodcastAudio => {
            argv.push("-map".into());
            argv.push(format!("[{final_audio_label}]"));
        }
        _ => {
            argv.push("-map".into());
            argv.push("[outv]".into());
            argv.push("-map".into());
            argv.push(format!("[{final_audio_label}]"));
        }
    }

    if let Some(idx) = chapter_input_index {
        argv.push("-map_metadata".into());
        argv.push(idx.to_string());
    }

    let video_codec = pick_video_codec(opts);
    match opts.preset {
        ExportPreset::Youtube1080p | ExportPreset::Custom => {
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
    }
    argv.extend(["-progress".into(), "pipe:1".into()]);
    argv.push(opts.output_path.clone());

    log::info!("ffmpeg {}", argv.join(" "));

    let shell = app.shell();
    let cmd = shell
        .sidecar("ffmpeg")
        .map_err(|e| format!("ffmpeg sidecar: {e}"))?
        .args(argv);
    let (mut rx, child) = cmd.spawn().map_err(|e| format!("spawn ffmpeg: {e}"))?;
    *state.export.child.lock().await = Some(child);

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
                            job.set_progress(progress, eta).await;
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
            CommandEvent::Stderr(_) => {}
            CommandEvent::Terminated(t) => {
                *state.export.child.lock().await = None;
                if let Some(p) = &chapter_meta {
                    let _ = fs::remove_file(p).await;
                }
                if t.code != Some(0) {
                    return Err(format!("ffmpeg exited with code {:?}", t.code));
                }
                app.emit(
                    "export:progress",
                    serde_json::json!({"progress": 1.0, "outputTimeSec": total_duration, "etaSec": 0i64}),
                )
                .ok();
                return Ok(());
            }
            _ => {}
        }
    }

    if let Some(p) = &chapter_meta {
        let _ = fs::remove_file(p).await;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Music-bed filter graph helpers
// ---------------------------------------------------------------------------

/// Append filter graph nodes that mix every audio track in the project under
/// the `[mainvox]` label and emit `[outa]`.
///
/// For each track:
///   * Add the underlying media file as a new -i input.
///   * Apply `volume=<gainDb>dB`, an `adelay` if `offsetSec > 0`, and
///     trim/`apad` so the track is exactly the output duration.
///   * If `ducks`, sidechain-compress it against [mainvox] so the music
///     drops by ~12 dB whenever the speaker is talking.
///   * `amix` all tracks together, then mix with [mainvox] (with normalize=0
///     so we don't lose voice headroom).
pub fn append_music_bed_filters<'a>(
    filter: &mut String,
    inputs: &mut Vec<&'a String>,
    voice_label: &str,
    project: &'a Project,
    total_duration: f64,
) -> Result<(), String> {
    if project.audio_tracks.is_empty() {
        return Ok(());
    }
    // Branch the voice so we can both use it as sidechain *and* mix it
    // directly. `asplit` is the audio version of split.
    let _ = write!(
        filter,
        ";[{voice_label}]asplit=2[vox_main][vox_side]"
    );

    // Process each track.
    let mut track_labels: Vec<String> = Vec::with_capacity(project.audio_tracks.len());
    for (i, track) in project.audio_tracks.iter().enumerate() {
        let media = project.media.get(&track.media_id).ok_or_else(|| {
            format!("audio track references unknown media: {}", track.media_id)
        })?;
        let input_idx = inputs.len();
        inputs.push(&media.path);

        // Trim, gain, optional ducking.
        let raw_label = format!("trk_raw_{i}");
        let delay_ms = (track.offset_sec.max(0.0) * 1000.0).round() as i64;
        let _ = write!(
            filter,
            ";[{input_idx}:a]atrim=0:{total_duration:.3},asetpts=PTS-STARTPTS,volume={gain}dB"
            ,
            gain = track.gain_db
        );
        if delay_ms > 0 {
            // `adelay=N|N` applies to first 2 channels; works on mono+stereo files.
            let _ = write!(filter, ",adelay={delay_ms}|{delay_ms}");
        }
        // Pad/cut the track to match the output duration so amix doesn't
        // truncate the voice.
        let _ = write!(
            filter,
            ",apad,atrim=0:{total_duration:.3},asetpts=PTS-STARTPTS[{raw_label}]"
        );

        if track.ducks {
            let ducked = format!("trk_duck_{i}");
            // `sidechaincompress` defaults: threshold=0.125, ratio=2 → not
            // aggressive enough. Tighten threshold + ratio for a real ducking
            // effect.
            let _ = write!(
                filter,
                ";[{raw_label}][vox_side]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=300:makeup=1[{ducked}]"
            );
            track_labels.push(ducked);
        } else {
            track_labels.push(raw_label);
        }
    }

    // Merge all music tracks. If only one, route it directly. Otherwise amix.
    let music_label = if track_labels.len() == 1 {
        track_labels.into_iter().next().unwrap()
    } else {
        let mixed = "music_mix".to_string();
        let mut amix_inputs = String::new();
        for l in &track_labels {
            let _ = write!(amix_inputs, "[{l}]");
        }
        let n = track_labels.len();
        let _ = write!(
            filter,
            ";{amix_inputs}amix=inputs={n}:duration=longest:dropout_transition=0:normalize=0[{mixed}]"
        );
        mixed
    };

    // Final mix: voice + music. normalize=0 keeps voice gain intact.
    let _ = write!(
        filter,
        ";[vox_main][{music_label}]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[outa]"
    );

    Ok(())
}

// ---------------------------------------------------------------------------
// Chapter ffmetadata builder + temp paths
// ---------------------------------------------------------------------------

/// Build an FFmetadata file containing one [CHAPTER] block per chapter.
/// ffmpeg expects per-chapter START/END in TIMEBASE units; we use 1/1000 so
/// times are simply integer milliseconds. The exporter clamps end-of-file
/// using the total output duration so the last chapter gets a sensible END.
fn build_chapter_ffmetadata(chapters: &[Chapter], total_duration_sec: f64) -> String {
    let mut sorted: Vec<&Chapter> = chapters.iter().collect();
    sorted.sort_by(|a, b| {
        a.output_time
            .partial_cmp(&b.output_time)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut out = String::from(";FFMETADATA1\n");
    for (i, c) in sorted.iter().enumerate() {
        let start_ms = (c.output_time.max(0.0) * 1000.0).round() as u64;
        let end_ms = if i + 1 < sorted.len() {
            (sorted[i + 1].output_time.max(0.0) * 1000.0).round() as u64
        } else {
            (total_duration_sec.max(c.output_time) * 1000.0).round() as u64
        };
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
        let _ = child.kill();
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use crate::edl::{
        AudioTrack, ExportPreset, Project, ProjectSettings, Segment, SourceMedia, Word,
    };
    use std::collections::HashMap;

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
        let _ = write!(
            filter,
            "{concat_inputs}concat=n={n}:v=1:a=1[outv][mainvox]",
            n = specs.len()
        );
        filter
    }

    fn fixture() -> Project {
        let mut media = HashMap::new();
        media.insert(
            "m".into(),
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
            audio_tracks: vec![],
        }
    }

    #[test]
    fn builds_two_segment_concat() {
        let filter = build_filter_for_test(&fixture());
        assert!(filter.contains("[0:v]trim=start=0:end=2"));
        assert!(filter.contains("[0:v]trim=start=5:end=7"));
        assert!(filter.contains("concat=n=2:v=1:a=1[outv][mainvox]"));
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

    #[test]
    fn append_music_bed_emits_volume_and_amix_for_two_tracks() {
        let mut p = fixture();
        p.media.insert(
            "music".into(),
            SourceMedia {
                id: "music".into(),
                path: "/tmp/song.mp3".into(),
                duration: 200.0,
                fps: 0.0,
                width: 0,
                height: 0,
                audio_sample_rate: 44100,
                sha256: "music".into(),
            },
        );
        p.audio_tracks.push(AudioTrack {
            id: "t1".into(),
            media_id: "music".into(),
            gain_db: -12.0,
            offset_sec: 0.0,
            ducks: true,
        });
        p.audio_tracks.push(AudioTrack {
            id: "t2".into(),
            media_id: "music".into(),
            gain_db: -20.0,
            offset_sec: 5.0,
            ducks: false,
        });

        let mut filter = build_filter_for_test(&p);
        let mut inputs: Vec<&String> = p
            .segments
            .iter()
            .map(|s| &p.media.get(&s.media_id).unwrap().path)
            .collect();
        super::append_music_bed_filters(&mut filter, &mut inputs, "mainvox", &p, 30.0).unwrap();
        assert!(filter.contains("asplit=2[vox_main][vox_side]"));
        assert!(filter.contains("volume=-12dB"));
        assert!(filter.contains("volume=-20dB"));
        assert!(filter.contains("adelay=5000|5000"));
        assert!(filter.contains("sidechaincompress="));
        assert!(filter.contains("amix=inputs=2:duration=longest"));
        assert!(filter.contains("[outa]"));
    }

    #[test]
    fn append_music_bed_with_single_track_skips_inner_amix() {
        let mut p = fixture();
        p.media.insert(
            "music".into(),
            SourceMedia {
                id: "music".into(),
                path: "/tmp/song.mp3".into(),
                duration: 200.0,
                fps: 0.0,
                width: 0,
                height: 0,
                audio_sample_rate: 44100,
                sha256: "music".into(),
            },
        );
        p.audio_tracks.push(AudioTrack {
            id: "t1".into(),
            media_id: "music".into(),
            gain_db: -6.0,
            offset_sec: 0.0,
            ducks: false,
        });
        let mut filter = build_filter_for_test(&p);
        let mut inputs: Vec<&String> = p
            .segments
            .iter()
            .map(|s| &p.media.get(&s.media_id).unwrap().path)
            .collect();
        super::append_music_bed_filters(&mut filter, &mut inputs, "mainvox", &p, 30.0).unwrap();
        // Only one inner track — no music_mix label needed.
        assert!(!filter.contains("music_mix"));
        // Final mix is voice + the single trk_raw_0 (no ducking).
        assert!(filter.contains("[vox_main][trk_raw_0]amix=inputs=2"));
    }
}
