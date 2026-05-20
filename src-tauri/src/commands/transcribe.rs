//! Transcription commands:
//!   - `transcribe`     — extract 16kHz mono WAV, run whisper-cli, parse JSON, emit progress
//!   - `list_models`    — what is installed locally, what needs downloading
//!   - `download_model` — fetch a ggml model + Core ML companion from Hugging Face
//!
//! Progress events are emitted on the channel `transcribe:progress` and
//! `model:download:progress`. Frontend subscribes via `ipc.ts`.

use crate::edl::Word;
use crate::transcribe::parse_whisper_json;
use futures_util::StreamExt as _;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;
use tokio::fs;
use tokio::io::AsyncWriteExt as _;

#[derive(Debug, Serialize, Deserialize, Clone, Copy)]
#[serde(rename_all = "kebab-case")]
pub enum WhisperModel {
    Tiny,
    Base,
    Small,
    Medium,
    #[serde(rename = "large-v3-turbo")]
    LargeV3Turbo,
}

impl WhisperModel {
    pub fn filename(self) -> &'static str {
        match self {
            WhisperModel::Tiny => "ggml-tiny.bin",
            WhisperModel::Base => "ggml-base.bin",
            WhisperModel::Small => "ggml-small.bin",
            WhisperModel::Medium => "ggml-medium.bin",
            WhisperModel::LargeV3Turbo => "ggml-large-v3-turbo.bin",
        }
    }

    /// Base name used in Core ML encoder filenames, e.g. "tiny", "large-v3-turbo".
    pub fn base_name(self) -> &'static str {
        match self {
            WhisperModel::Tiny => "tiny",
            WhisperModel::Base => "base",
            WhisperModel::Small => "small",
            WhisperModel::Medium => "medium",
            WhisperModel::LargeV3Turbo => "large-v3-turbo",
        }
    }

    /// The Core ML encoder directory that whisper-cli looks for next to the .bin.
    /// e.g. "ggml-tiny-encoder.mlmodelc"
    pub fn coreml_encoder_dir(self) -> String {
        format!("ggml-{}-encoder.mlmodelc", self.base_name())
    }

    /// The zip file name on HuggingFace that contains the Core ML encoder.
    pub fn coreml_encoder_zip(self) -> String {
        format!("ggml-{}-encoder.mlmodelc.zip", self.base_name())
    }

    pub fn size_mb(self) -> u64 {
        match self {
            WhisperModel::Tiny => 75,
            WhisperModel::Base => 142,
            WhisperModel::Small => 466,
            WhisperModel::Medium => 1500,
            WhisperModel::LargeV3Turbo => 1600,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct ModelInfo {
    pub name: WhisperModel,
    #[serde(rename = "sizeMb")]
    pub size_mb: u64,
    pub installed: bool,
}

#[derive(Debug, Deserialize)]
pub struct TranscribeOpts {
    #[serde(rename = "mediaId")]
    pub media_id: String,
    #[serde(rename = "mediaPath")]
    pub media_path: String,
    #[serde(rename = "modelName")]
    pub model_name: WhisperModel,
    /// Total media duration in seconds — used to emit accurate 0..1 progress.
    #[serde(rename = "mediaDuration", default)]
    pub media_duration: f64,
}

#[derive(Debug, Serialize)]
pub struct TranscribeResult {
    #[serde(rename = "mediaId")]
    pub media_id: String,
    pub words: Vec<Word>,
}

#[derive(Debug, Serialize, Clone)]
pub struct TranscribeProgress {
    #[serde(rename = "mediaId")]
    pub media_id: String,
    pub progress: f64,
    #[serde(rename = "currentTime")]
    pub current_time: f64,
}

fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let mut p = app.path().app_data_dir().map_err(|e| e.to_string())?;
    p.push("models");
    Ok(p)
}

// ---------------------------------------------------------------------------
// list_models
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_models(app: AppHandle) -> Result<Vec<ModelInfo>, String> {
    let dir = models_dir(&app)?;
    let mut out = Vec::new();
    for &m in &[
        WhisperModel::Tiny,
        WhisperModel::Base,
        WhisperModel::Small,
        WhisperModel::Medium,
        WhisperModel::LargeV3Turbo,
    ] {
        let installed = dir.join(m.filename()).exists();
        out.push(ModelInfo {
            name: m,
            size_mb: m.size_mb(),
            installed,
        });
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// download_model  (GGML bin + Core ML encoder zip)
// ---------------------------------------------------------------------------

/// Download a single file from HuggingFace whisper.cpp repo, emitting progress
/// events with the given `progress_name` key.
async fn download_hf_file(
    app: &AppHandle,
    filename: &str,
    dest: &PathBuf,
    progress_name: impl Serialize,
    progress_scale: f64,   // multiply raw 0..1 into the overall progress fraction
    progress_offset: f64,  // add after scaling
) -> Result<(), String> {
    let url = format!(
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/{}",
        filename
    );
    let tmp = dest.with_extension(format!(
        "{}.partial",
        dest.extension().unwrap_or_default().to_string_lossy()
    ));

    let resp = reqwest::get(&url).await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("download failed ({}): {}", filename, resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut stream = resp.bytes_stream();
    let mut file = fs::File::create(&tmp).await.map_err(|e| e.to_string())?;
    let mut downloaded: u64 = 0;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;
        let raw = if total > 0 {
            downloaded as f64 / total as f64
        } else {
            0.0
        };
        let progress = (raw * progress_scale + progress_offset).clamp(0.0, 1.0);
        app.emit(
            "model:download:progress",
            serde_json::json!({
                "name": progress_name,
                "progress": progress,
                "bytesDownloaded": downloaded,
                "bytesTotal": total,
            }),
        )
        .ok();
    }

    fs::rename(&tmp, dest).await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Unzip a single-directory zip into `parent_dir`, then remove the zip.
async fn unzip_coreml_encoder(zip_path: &PathBuf, parent_dir: &PathBuf) -> Result<(), String> {
    // Use the system `unzip` tool (available on macOS) via std::process.
    // We're in an async context but unzip is fast enough to block briefly.
    let output = std::process::Command::new("unzip")
        .arg("-o")
        .arg(zip_path)
        .arg("-d")
        .arg(parent_dir)
        .output()
        .map_err(|e| format!("failed to run unzip: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("unzip failed: {stderr}"));
    }
    let _ = fs::remove_file(zip_path).await;
    Ok(())
}

#[tauri::command]
pub async fn download_model(app: AppHandle, name: WhisperModel) -> Result<(), String> {
    let dir = models_dir(&app)?;
    fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;

    // ── Step 1: download the GGML .bin (counts as 0..0.85 of total progress) ──
    let bin_dest = dir.join(name.filename());
    download_hf_file(&app, name.filename(), &bin_dest, name, 0.85, 0.0).await?;

    // ── Step 2: download & unzip Core ML encoder ────────────────────────────────
    // The GGML bin download above emitted progress up to 0.85 via download_hf_file.
    // Now fetch the Core ML companion so whisper-cli can use Metal/ANE acceleration.
    // ensure_coreml_encoder handles its own progress events and the final 1.0 flush.
    ensure_coreml_encoder(&app, &dir, name).await;

    Ok(())
}

// ---------------------------------------------------------------------------
// ensure_coreml_encoder — download the Core ML companion if not present
// ---------------------------------------------------------------------------

/// Ensure the Core ML encoder is present for `name`.
///
/// If the `.mlmodelc` directory already exists, returns `true` immediately.
/// Otherwise downloads and unzips it from HuggingFace, emitting
/// `model:download:progress` so the toolbar shows a progress bar.
///
/// Returns `true` when Core ML is ready, `false` only when the network or
/// unzip fails — callers should treat `false` as a last-resort CPU fallback.
async fn ensure_coreml_encoder(
    app: &AppHandle,
    models: &PathBuf,
    name: WhisperModel,
) -> bool {
    let encoder_dir = models.join(name.coreml_encoder_dir());
    if encoder_dir.exists() {
        return true;
    }

    log::info!(
        "Core ML encoder missing for {} — downloading automatically",
        name.filename()
    );

    // Signal the frontend immediately so the "Downloading…" bar appears.
    app.emit(
        "model:download:progress",
        serde_json::json!({
            "name": name,
            "progress": 0.0,
            "bytesDownloaded": 0u64,
            "bytesTotal": 0u64,
        }),
    )
    .ok();

    let zip_name = name.coreml_encoder_zip();
    let zip_dest = models.join(&zip_name);

    let ok = match download_hf_file(app, &zip_name, &zip_dest, name, 1.0, 0.0).await {
        Err(e) => {
            log::warn!("Core ML encoder download failed: {e}");
            false
        }
        Ok(()) => match unzip_coreml_encoder(&zip_dest, models).await {
            Err(e) => {
                log::warn!("Core ML encoder unzip failed: {e}");
                let _ = fs::remove_file(&zip_dest).await;
                false
            }
            Ok(()) => {
                log::info!("Core ML encoder installed for {}", name.filename());
                true
            }
        },
    };

    // Always emit 1.0 to close the download bar in the toolbar.
    app.emit(
        "model:download:progress",
        serde_json::json!({
            "name": name,
            "progress": 1.0,
            "bytesDownloaded": 0u64,
            "bytesTotal": 0u64,
        }),
    )
    .ok();

    ok
}

// ---------------------------------------------------------------------------
// transcribe
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn transcribe(
    app: AppHandle,
    opts: TranscribeOpts,
) -> Result<TranscribeResult, String> {
    // Emit an immediate "started" event so the toolbar shows the progress bar
    // even before ffmpeg finishes extracting audio.
    app.emit(
        "transcribe:progress",
        TranscribeProgress {
            media_id: opts.media_id.clone(),
            progress: 0.01,
            current_time: 0.0,
        },
    )
    .ok();

    // 1) Use the media path provided by the front-end.
    let media_path = &opts.media_path;

    // 2) Extract audio to a temp wav
    let wav = tempfile_with_ext("wav");
    let shell = app.shell();
    let ffmpeg = shell
        .sidecar("ffmpeg")
        .map_err(|e| format!("ffmpeg sidecar not available: {e}"))?
        .args([
            "-y",
            "-i", media_path,
            "-vn",
            "-ac", "1",
            "-ar", "16000",
            "-c:a", "pcm_s16le",
            wav.to_str().unwrap(),
        ]);
    let (mut rx, _child) = ffmpeg.spawn().map_err(|e| format!("spawn ffmpeg: {e}"))?;
    while let Some(ev) = rx.recv().await {
        if let CommandEvent::Terminated(t) = ev {
            if t.code != Some(0) {
                return Err("ffmpeg failed extracting audio".into());
            }
            break;
        }
    }

    // 3) Run whisper-cli
    let models = models_dir(&app)?;
    let model = models.join(opts.model_name.filename());
    if !model.exists() {
        return Err(format!(
            "model not installed: {}. Call download_model first.",
            opts.model_name.filename()
        ));
    }

    // Ensure the Core ML encoder is present — auto-download it if missing.
    // This handles the case where the user had a model installed before the
    // Core ML encoder was added to download_model.
    // --no-gpu is only used as a true last resort (network failure, etc.).
    let use_coreml = ensure_coreml_encoder(&app, &models, opts.model_name).await;
    if !use_coreml {
        log::warn!(
            "Core ML encoder unavailable for {} — falling back to CPU (--no-gpu)",
            opts.model_name.filename()
        );
    }

    // Build whisper-cli argv as owned Strings to avoid lifetime tangles.
    let model_str = model.to_str().unwrap().to_string();
    let wav_str = wav.to_str().unwrap().to_string();
    let mut whisper_args: Vec<String> = vec![
        "-m".into(), model_str,
        "-f".into(), wav_str,
        "--output-json-full".into(),
        "--word-thold".into(), "0.01".into(),
        "-ml".into(), "1".into(),
    ];
    if !use_coreml {
        whisper_args.push("--no-gpu".into());
    }

    let whisper = shell
        .sidecar("whisper-cli")
        .map_err(|e| format!("whisper-cli sidecar not available: {e}"))?
        .args(whisper_args);

    let (mut rx, _child) = whisper.spawn().map_err(|e| format!("spawn whisper: {e}"))?;
    let mut stderr = String::new();
    let total_duration = if opts.media_duration > 0.001 {
        opts.media_duration
    } else {
        1.0 // avoid divide-by-zero; progress will still show something
    };

    while let Some(ev) = rx.recv().await {
        match ev {
            CommandEvent::Stderr(line) => {
                let line = String::from_utf8_lossy(&line).to_string();
                stderr.push_str(&line);
                stderr.push('\n');
                if let Some(current_time) = parse_progress_line(&line) {
                    let progress = (current_time / total_duration).clamp(0.02, 0.99);
                    let p = TranscribeProgress {
                        media_id: opts.media_id.clone(),
                        progress,
                        current_time,
                    };
                    app.emit("transcribe:progress", p).ok();
                }
            }
            CommandEvent::Terminated(t) => {
                if t.code != Some(0) {
                    return Err(format!("whisper-cli failed: {}", stderr.trim()));
                }
                break;
            }
            _ => {}
        }
    }

    // 4) whisper-cli writes <wav>.json — read it.
    let json_path = wav.with_extension("wav.json");
    let json = fs::read_to_string(&json_path)
        .await
        .map_err(|e| format!("reading whisper json {}: {}", json_path.display(), e))?;
    let words = parse_whisper_json(&json).map_err(|e| e.to_string())?;

    // 5) Clean up tmp files
    let _ = fs::remove_file(&wav).await;
    let _ = fs::remove_file(&json_path).await;

    // 6) Emit a final "done" progress event
    app.emit(
        "transcribe:progress",
        TranscribeProgress {
            media_id: opts.media_id.clone(),
            progress: 1.0,
            current_time: total_duration,
        },
    )
    .ok();

    Ok(TranscribeResult {
        media_id: opts.media_id,
        words,
    })
}

/// Parse a whisper.cpp stderr progress line of the form
/// `[00:00:30.000 --> 00:00:32.500]` and return the *to* time in seconds.
fn parse_progress_line(line: &str) -> Option<f64> {
    let line = line.trim();
    if !line.starts_with('[') {
        return None;
    }
    let arrow = line.find("--> ")?;
    let end = line[arrow + 4..].find(']')?;
    let ts = &line[arrow + 4..arrow + 4 + end];
    parse_timestamp(ts)
}

fn parse_timestamp(s: &str) -> Option<f64> {
    let mut parts = s.split(':');
    let h: u64 = parts.next()?.parse().ok()?;
    let m: u64 = parts.next()?.parse().ok()?;
    let s = parts.next()?;
    let secs: f64 = s.parse().ok()?;
    Some((h * 3600 + m * 60) as f64 + secs)
}

fn tempfile_with_ext(ext: &str) -> PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!("scribe-{}.{}", uuid::Uuid::new_v4(), ext));
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_progress_line() {
        let line = "[00:00:30.500 --> 00:00:32.500]  hello world";
        assert_eq!(parse_progress_line(line), Some(32.5));
    }

    #[test]
    fn rejects_non_progress_lines() {
        assert_eq!(parse_progress_line("loading model"), None);
        assert_eq!(parse_progress_line("[foo]"), None);
    }

    #[test]
    fn coreml_encoder_names() {
        assert_eq!(WhisperModel::Tiny.coreml_encoder_dir(), "ggml-tiny-encoder.mlmodelc");
        assert_eq!(WhisperModel::LargeV3Turbo.coreml_encoder_dir(), "ggml-large-v3-turbo-encoder.mlmodelc");
        assert_eq!(WhisperModel::Tiny.coreml_encoder_zip(), "ggml-tiny-encoder.mlmodelc.zip");
    }
}
