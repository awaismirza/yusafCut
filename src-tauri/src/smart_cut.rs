//! Smart-cut export — stream-copy long interiors, re-encode only at cuts.
//!
//! ## Why
//!
//! The "naïve" exporter in `commands::export` runs every output second through
//! `h264_videotoolbox`. A 30-minute talk with 20 cuts therefore re-encodes 30
//! minutes of video to save maybe 90 seconds of content. The professional move
//! is to stream-copy the long *interior* of each EDL segment and only re-encode
//! the few hundred frames either side of each cut — exactly enough to rebuild
//! the GOP structure across the splice. That gets us 10–50× export speedups
//! on the videos people actually edit.
//!
//! ## How
//!
//! For each segment `[source_in, source_out]`:
//!   1. Probe the source's keyframe timestamps (`ffprobe -show_frames
//!      -skip_frame nokey`).
//!   2. Pick `kf_start` = first keyframe `>=` source_in and `kf_end` = last
//!      keyframe `<=` source_out. If `kf_end - kf_start >= MIN_COPY_DURATION`
//!      we get three sub-chunks:
//!        - **head** `[source_in, kf_start)` — short re-encode.
//!        - **body** `[kf_start, kf_end]` — stream-copy with `-c copy`.
//!        - **tail** `[kf_end, source_out]` — short re-encode.
//!   3. Otherwise re-encode the whole segment (no keyframe far enough inside).
//!
//! All chunks land in a temp dir as MP4s with identical codec parameters, then
//! the final pass uses the concat demuxer (`-f concat -i list.txt -c copy`) to
//! glue them together. Result: every second of stream-copied body is a "free"
//! second of export.
//!
//! ## When NOT to smart-cut (eligibility)
//!
//! Smart-cut requires the head/body/tail chunks to share codec parameters with
//! the source. So we fall back to the full re-encode path whenever:
//!   * The user asked for a different codec (h264 ↔ hevc).
//!   * The user asked for a different resolution or fps.
//!   * The preset is `podcast-audio` (audio-only, no video to copy).
//!   * The EDL references multiple source files (mixing different codecs in a
//!     `-c copy` concat is unsafe).
//!   * The source has no usable keyframes (some screen recordings).
//!
//! Eligibility is decided by `is_eligible`, which the export command calls
//! before delegating here.

use crate::edl::Project;
use anyhow::{Context, Result};
use std::path::PathBuf;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;

/// Stream-copy bodies shorter than this are not worth the overhead of a
/// concat: cleaner to just re-encode the whole segment.
pub const MIN_COPY_DURATION: f64 = 2.0;

/// Decide whether smart-cut is safe for the current export options.
///
/// `requested_codec` is `"h264"`, `"hevc"`, or `None` (= match source). The
/// returned bool is false → caller must use full re-encode.
pub fn is_eligible(project: &Project, codec: Option<&str>, width: Option<u32>, height: Option<u32>, fps: Option<f64>, audio_only: bool) -> bool {
    if audio_only {
        return false;
    }
    if project.segments.is_empty() {
        return false;
    }
    // Multi-source concat with -c copy is brittle (mismatched codec params,
    // SAR, timebase). Defer to full re-encode for v2.2.
    let first_media = &project.segments[0].media_id;
    if project.segments.iter().any(|s| &s.media_id != first_media) {
        return false;
    }
    // Resolution / fps overrides force a re-encode.
    if width.is_some() || height.is_some() {
        return false;
    }
    if let Some(f) = fps {
        if f > 0.0 {
            return false;
        }
    }
    // If the user picked a codec different from the source, we can't stream-copy.
    if let Some(c) = codec {
        // We don't know the source codec at this layer; treat any explicit
        // request as "user knows best, please re-encode". The caller can pass
        // None to mean "match source".
        let _ = c;
        return false;
    }
    // Music beds need a different audio mux path (mixed), so for v2.2 we
    // bypass smart-cut when audio tracks are present. The exporter will fall
    // back to the regular path which handles mixing.
    if !project.audio_tracks.is_empty() {
        return false;
    }
    true
}

/// One slice of an EDL segment, as we'll render it during smart-cut.
#[derive(Debug, Clone, PartialEq)]
pub enum ChunkKind {
    /// `[chunk_in, chunk_out)` will be stream-copied with `-c copy`.
    Copy,
    /// `[chunk_in, chunk_out)` will be re-encoded to match `Copy` params.
    Reencode,
}

#[derive(Debug, Clone)]
pub struct Chunk {
    pub kind: ChunkKind,
    pub chunk_in: f64,
    pub chunk_out: f64,
}

impl Chunk {
    pub fn duration(&self) -> f64 {
        (self.chunk_out - self.chunk_in).max(0.0)
    }
}

/// Split a segment into chunks given the source's keyframe timestamps.
///
/// `keyframes` must be sorted ascending. Returns a head + body + tail (any of
/// which may be empty/dropped) or, if no usable keyframe is far enough inside
/// the segment, a single Reencode chunk covering the whole thing.
pub fn plan_segment(source_in: f64, source_out: f64, keyframes: &[f64]) -> Vec<Chunk> {
    if source_out <= source_in {
        return Vec::new();
    }
    // First keyframe >= source_in
    let kf_start = keyframes.iter().copied().find(|&t| t >= source_in);
    // Last keyframe <= source_out — walk backwards
    let kf_end = keyframes.iter().copied().rev().find(|&t| t <= source_out);
    match (kf_start, kf_end) {
        (Some(ks), Some(ke)) if ke - ks >= MIN_COPY_DURATION && ks < ke => {
            let mut out = Vec::with_capacity(3);
            if ks > source_in + 1e-3 {
                out.push(Chunk { kind: ChunkKind::Reencode, chunk_in: source_in, chunk_out: ks });
            }
            out.push(Chunk { kind: ChunkKind::Copy, chunk_in: ks, chunk_out: ke });
            if source_out > ke + 1e-3 {
                out.push(Chunk { kind: ChunkKind::Reencode, chunk_in: ke, chunk_out: source_out });
            }
            out
        }
        _ => vec![Chunk { kind: ChunkKind::Reencode, chunk_in: source_in, chunk_out: source_out }],
    }
}

/// Probe the input video's keyframe timestamps via ffprobe. This walks every
/// keyframe in the file and returns their `pkt_pts_time` values sorted
/// ascending. Robust against files with no I-frame index (will simply return
/// an empty Vec — caller treats that as ineligible).
pub async fn probe_keyframes(app: &tauri::AppHandle, path: &str) -> Result<Vec<f64>> {
    let shell = app.shell();
    let cmd = shell
        .sidecar("ffprobe")
        .with_context(|| "ffprobe sidecar")?
        .args([
            "-v", "error",
            "-skip_frame", "nokey",
            "-select_streams", "v:0",
            "-show_entries", "frame=pkt_pts_time,pts_time",
            "-of", "csv=p=0",
            path,
        ]);
    let (mut rx, _child) = cmd.spawn().with_context(|| "spawn ffprobe")?;
    let mut stdout = String::new();
    while let Some(ev) = rx.recv().await {
        match ev {
            CommandEvent::Stdout(line) => {
                stdout.push_str(&String::from_utf8_lossy(&line));
                stdout.push('\n');
            }
            CommandEvent::Terminated(t) => {
                if t.code != Some(0) {
                    anyhow::bail!("ffprobe failed");
                }
                break;
            }
            _ => {}
        }
    }
    let kfs = parse_keyframe_csv(&stdout);
    Ok(kfs)
}

/// Parse ffprobe `csv=p=0` output where each line is a single keyframe timestamp.
/// Newer ffmpegs emit `pts_time`; older emit `pkt_pts_time`. Both are floats so
/// we just parse leading-float each line. Empty / "N/A" lines are ignored.
pub fn parse_keyframe_csv(s: &str) -> Vec<f64> {
    let mut out = Vec::new();
    for line in s.lines() {
        let t = line.trim();
        if t.is_empty() || t.eq_ignore_ascii_case("n/a") {
            continue;
        }
        // Some ffmpeg builds emit `pkt_pts_time,pts_time` two columns; take whichever parses.
        for tok in t.split(',') {
            if let Ok(v) = tok.trim().parse::<f64>() {
                out.push(v);
                break;
            }
        }
    }
    out.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    out.dedup_by(|a, b| (*a - *b).abs() < 1e-4);
    out
}

/// Build a temp file path with a deterministic prefix so cleanup is easier
/// if a worker dies.
pub fn temp_path(suffix: &str) -> PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!("yusafcut-smartcut-{}-{}", uuid::Uuid::new_v4(), suffix));
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_segment_emits_head_body_tail_when_keyframes_inside() {
        let kfs = vec![0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0];
        let chunks = plan_segment(1.5, 6.5, &kfs);
        assert_eq!(chunks.len(), 3);
        assert_eq!(chunks[0].kind, ChunkKind::Reencode);
        assert!((chunks[0].chunk_in - 1.5).abs() < 1e-9);
        assert!((chunks[0].chunk_out - 2.0).abs() < 1e-9);
        assert_eq!(chunks[1].kind, ChunkKind::Copy);
        assert!((chunks[1].chunk_in - 2.0).abs() < 1e-9);
        assert!((chunks[1].chunk_out - 6.0).abs() < 1e-9);
        assert_eq!(chunks[2].kind, ChunkKind::Reencode);
        assert!((chunks[2].chunk_in - 6.0).abs() < 1e-9);
        assert!((chunks[2].chunk_out - 6.5).abs() < 1e-9);
    }

    #[test]
    fn plan_segment_falls_back_to_reencode_when_body_too_short() {
        // Only one keyframe inside the segment — body would be 0s, so we
        // re-encode the whole thing.
        let kfs = vec![0.0, 3.0, 10.0];
        let chunks = plan_segment(2.0, 4.0, &kfs);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].kind, ChunkKind::Reencode);
    }

    #[test]
    fn plan_segment_drops_zero_length_head_or_tail() {
        // source_in lands exactly on a keyframe → no head.
        let kfs = vec![0.0, 2.0, 4.0, 6.0, 8.0];
        let chunks = plan_segment(2.0, 6.5, &kfs);
        assert_eq!(chunks[0].kind, ChunkKind::Copy);
        assert!((chunks[0].chunk_in - 2.0).abs() < 1e-9);
        // body 2..6, then tail 6..6.5
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[1].kind, ChunkKind::Reencode);
    }

    #[test]
    fn parse_keyframe_csv_handles_two_columns_and_na() {
        let raw = "0.000000\n2.500000,2.500000\nN/A\n5.0\n";
        let kfs = parse_keyframe_csv(raw);
        assert_eq!(kfs, vec![0.0, 2.5, 5.0]);
    }

    #[test]
    fn parse_keyframe_csv_dedups_near_duplicates() {
        let raw = "1.0\n1.00005\n2.0\n";
        let kfs = parse_keyframe_csv(raw);
        // 1.0 and 1.00005 round to within 1e-4
        assert_eq!(kfs.len(), 2);
    }

    fn fixture() -> Project {
        use crate::edl::{ExportPreset, Project, ProjectSettings, Segment, SourceMedia};
        use std::collections::HashMap;
        let mut media = HashMap::new();
        media.insert(
            "m".into(),
            SourceMedia {
                id: "m".into(),
                path: "/tmp/x.mp4".into(),
                duration: 60.0,
                fps: 30.0,
                width: 1920,
                height: 1080,
                audio_sample_rate: 48000,
                sha256: "x".into(),
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
                Segment { id: "s1".into(), media_id: "m".into(), words: vec![], source_in: 0.0, source_out: 30.0 },
                Segment { id: "s2".into(), media_id: "m".into(), words: vec![], source_in: 40.0, source_out: 55.0 },
            ],
            settings: ProjectSettings { export_preset: ExportPreset::Youtube1080p, padding_ms: 80 },
            chapters: vec![],
            audio_tracks: vec![],
        }
    }

    #[test]
    fn eligible_for_simple_single_source_youtube_export() {
        assert!(is_eligible(&fixture(), None, None, None, None, false));
    }

    #[test]
    fn ineligible_when_audio_only_preset() {
        assert!(!is_eligible(&fixture(), None, None, None, None, true));
    }

    #[test]
    fn ineligible_when_resolution_override() {
        assert!(!is_eligible(&fixture(), None, Some(1280), Some(720), None, false));
    }

    #[test]
    fn ineligible_when_multiple_source_media() {
        use crate::edl::{Segment, SourceMedia};
        let mut p = fixture();
        p.media.insert("n".into(), SourceMedia {
            id: "n".into(), path: "/tmp/y.mp4".into(), duration: 10.0, fps: 30.0,
            width: 1920, height: 1080, audio_sample_rate: 48000, sha256: "y".into(),
        });
        p.segments.push(Segment {
            id: "s3".into(), media_id: "n".into(), words: vec![],
            source_in: 0.0, source_out: 5.0,
        });
        assert!(!is_eligible(&p, None, None, None, None, false));
    }

    #[test]
    fn ineligible_when_audio_tracks_present() {
        use crate::edl::AudioTrack;
        let mut p = fixture();
        p.audio_tracks.push(AudioTrack {
            id: "a1".into(), media_id: "m".into(),
            gain_db: -10.0, offset_sec: 0.0, ducks: true,
        });
        assert!(!is_eligible(&p, None, None, None, None, false));
    }
}
