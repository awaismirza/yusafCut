//! FFmpeg/FFprobe wrappers.
//!
//! In production these call the bundled binaries via `tauri::process`. For now
//! we expose the JSON parser and SHA-256 helper as pure functions so they can
//! be unit-tested without invoking the external binary.

use crate::edl::SourceMedia;
use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::path::Path;
use tokio::fs::File;
use tokio::io::AsyncReadExt;
use uuid::Uuid;

#[derive(Debug, Deserialize)]
struct FfprobeOutput {
    format: FfprobeFormat,
    streams: Vec<FfprobeStream>,
}

#[derive(Debug, Deserialize)]
struct FfprobeFormat {
    duration: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "codec_type")]
enum FfprobeStream {
    #[serde(rename = "video")]
    Video {
        width: u32,
        height: u32,
        r_frame_rate: String,
    },
    #[serde(rename = "audio")]
    Audio { sample_rate: String },
    #[serde(other)]
    Other,
}

/// Parse the JSON FFprobe emits with `-print_format json -show_format -show_streams`.
/// `path` and `sha256` are passed through onto the returned [SourceMedia].
pub fn parse_ffprobe_json(path: &str, sha256: String, json: &str) -> Result<SourceMedia> {
    let parsed: FfprobeOutput = serde_json::from_str(json).context("invalid ffprobe JSON")?;

    let mut width = 0u32;
    let mut height = 0u32;
    let mut fps = 0.0f64;
    let mut audio_sample_rate = 0u32;
    for s in &parsed.streams {
        match s {
            FfprobeStream::Video { width: w, height: h, r_frame_rate } => {
                width = *w;
                height = *h;
                fps = parse_r_frame_rate(r_frame_rate);
            }
            FfprobeStream::Audio { sample_rate } => {
                audio_sample_rate = sample_rate.parse().unwrap_or(0);
            }
            FfprobeStream::Other => {}
        }
    }

    let duration: f64 = parsed
        .format
        .duration
        .as_deref()
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| anyhow!("missing duration"))?;

    Ok(SourceMedia {
        id: Uuid::new_v4().to_string(),
        path: path.to_string(),
        duration,
        fps,
        width,
        height,
        audio_sample_rate,
        sha256,
    })
}

/// Parses ffprobe's "30000/1001" style fractions.
fn parse_r_frame_rate(s: &str) -> f64 {
    let mut parts = s.split('/');
    let num: f64 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0.0);
    let den: f64 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(1.0);
    if den == 0.0 {
        0.0
    } else {
        num / den
    }
}

/// Stream SHA-256 of a file without loading it into memory. Used for project
/// integrity / relinking.
pub async fn sha256_file(path: &Path) -> Result<String> {
    let mut f = File::open(path).await.with_context(|| format!("opening {}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_canonical_ffprobe_output() {
        let json = r#"{
            "streams": [
              {
                "codec_type": "video",
                "width": 1920,
                "height": 1080,
                "r_frame_rate": "30000/1001"
              },
              {
                "codec_type": "audio",
                "sample_rate": "48000"
              }
            ],
            "format": { "duration": "12.345" }
        }"#;
        let m = parse_ffprobe_json("/tmp/x.mp4", "deadbeef".into(), json).unwrap();
        assert_eq!(m.path, "/tmp/x.mp4");
        assert_eq!(m.width, 1920);
        assert_eq!(m.height, 1080);
        assert!((m.fps - 29.97).abs() < 0.01);
        assert_eq!(m.audio_sample_rate, 48000);
        assert!((m.duration - 12.345).abs() < 1e-6);
    }

    #[test]
    fn handles_integer_frame_rate() {
        let json = r#"{
            "streams":[{"codec_type":"video","width":1280,"height":720,"r_frame_rate":"30/1"}],
            "format":{"duration":"5.0"}
        }"#;
        let m = parse_ffprobe_json("/x.mp4", "x".into(), json).unwrap();
        assert!((m.fps - 30.0).abs() < 1e-9);
    }

    #[test]
    fn rejects_missing_duration() {
        let json = r#"{
            "streams":[{"codec_type":"video","width":1,"height":1,"r_frame_rate":"1/1"}],
            "format":{}
        }"#;
        assert!(parse_ffprobe_json("/x.mp4", "x".into(), json).is_err());
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse_ffprobe_json("/x.mp4", "x".into(), "{not json").is_err());
    }
}
