//! Transcription commands:
//!   - `transcribe`     — extract 16kHz mono WAV, run transcription engine, parse JSON, emit progress
//!   - `list_models`    — what is installed locally, what needs downloading
//!   - `download_model` — fetch a model from Hugging Face
//!
//! Two engines are supported, selected via `TranscriptionEngine` in `TranscribeOpts`:
//!   - `whisper-cpp`  (default) — whisper-cli sidecar, GGML models + Core ML encoders
//!   - `whisper-kit`            — whisperkit-cli sidecar, native ANE via Core ML .mlpackage
//!
//! Progress events are emitted on the channel `transcribe:progress` and
//! `model:download:progress`. Frontend subscribes via `ipc.ts`.

use crate::AppState;
use crate::edl::Word;
use crate::jobs::JobKind;
use crate::transcribe::{parse_whisper_json, parse_whisperkit_json};
use futures_util::StreamExt as _;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;
use tokio::fs;
use tokio::io::AsyncWriteExt as _;

// ---------------------------------------------------------------------------
// TranscriptionEngine
// ---------------------------------------------------------------------------

/// Which inference backend to use for a transcription job.
///
/// The frontend stores this as a user preference and passes it in
/// `TranscribeOpts`. Defaults to `WhisperCpp` for backwards compatibility.
#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum TranscriptionEngine {
    /// whisper-cli (whisper.cpp), GGML models accelerated by Core ML encoders.
    /// Widest model coverage; good baseline performance on Apple Silicon.
    #[default]
    WhisperCpp,
    /// whisperkit-cli (Argmax WhisperKit), native ANE via Core ML `.mlpackage`.
    /// Skips CPU round-trips; typically 2–4× faster than whisper.cpp on M-series.
    WhisperKit,
}

// ---------------------------------------------------------------------------
// WhisperModel (whisper.cpp / GGML)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
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

// ---------------------------------------------------------------------------
// WhisperKitModel (Core ML .mlpackage bundles from argmaxinc/whisperkit-coreml)
// ---------------------------------------------------------------------------

/// WhisperKit models available for download.
///
/// These are the `.mlmodelc` bundles published by Argmax at
/// `huggingface.co/argmaxinc/whisperkit-coreml`. Each "model repo" is a
/// directory that contains `AudioEncoder.mlmodelc`, `MelSpectrogram.mlmodelc`,
/// `TextDecoder.mlmodelc`, `config.json`, and `generation_config.json`.
#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum WhisperKitModel {
    /// openai/whisper-tiny (~39 M params). ANE-only; blazing fast.
    #[serde(rename = "openai_whisper-tiny")]
    Tiny,
    /// openai/whisper-base — good balance of speed and quality.
    #[serde(rename = "openai_whisper-base")]
    Base,
    /// openai/whisper-small — solid quality, still fast on ANE.
    #[serde(rename = "openai_whisper-small")]
    Small,
    /// openai/whisper-large-v3-turbo — distilled, ~large accuracy at ~small speed.
    #[serde(rename = "openai_whisper-large-v3-turbo")]
    LargeV3Turbo,
    /// openai/whisper-large-v3 — highest accuracy; ~4 GB on-disk.
    #[serde(rename = "openai_whisper-large-v3")]
    LargeV3,
}

impl WhisperKitModel {
    /// The repo subdirectory name used in the Argmax HuggingFace space.
    pub fn repo_name(self) -> &'static str {
        match self {
            WhisperKitModel::Tiny => "openai_whisper-tiny",
            WhisperKitModel::Base => "openai_whisper-base",
            WhisperKitModel::Small => "openai_whisper-small",
            WhisperKitModel::LargeV3Turbo => "openai_whisper-large-v3-turbo",
            WhisperKitModel::LargeV3 => "openai_whisper-large-v3",
        }
    }

    /// Local directory name under `<app-data>/whisperkit-models/`.
    pub fn local_dir(self) -> &'static str {
        self.repo_name()
    }

    /// Approximate download size in MiB (all `.mlmodelc` bundles combined).
    pub fn size_mb(self) -> u64 {
        match self {
            WhisperKitModel::Tiny => 77,
            WhisperKitModel::Base => 190,
            WhisperKitModel::Small => 640,
            WhisperKitModel::LargeV3Turbo => 1700,
            WhisperKitModel::LargeV3 => 3090,
        }
    }
}

// ---------------------------------------------------------------------------
// Shared ModelInfo (returned by list_models)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct ModelInfo {
    pub engine: TranscriptionEngine,
    pub name: String,
    #[serde(rename = "sizeMb")]
    pub size_mb: u64,
    pub installed: bool,
}

// ---------------------------------------------------------------------------
// TranscribeOpts / TranscribeResult / TranscribeProgress
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct TranscribeOpts {
    #[serde(rename = "mediaId")]
    pub media_id: String,
    #[serde(rename = "mediaPath")]
    pub media_path: String,
    /// Which transcription engine to use. Defaults to `whisper-cpp`.
    #[serde(rename = "engine", default)]
    pub engine: TranscriptionEngine,
    /// Model name for the chosen engine.
    ///   - whisper-cpp  → `WhisperModel` serialised as kebab-case (e.g. "large-v3-turbo")
    ///   - whisper-kit  → `WhisperKitModel` repo name (e.g. "openai_whisper-large-v3-turbo")
    #[serde(rename = "modelName")]
    pub model_name: String,
    /// Total media duration in seconds — used to emit accurate 0..1 progress.
    #[serde(rename = "mediaDuration", default)]
    pub media_duration: f64,
    /// BCP-47 language code for the source audio (e.g. "fr", "es").
    /// `None` / omitted → Whisper auto-detects. "auto" is treated as None.
    #[serde(rename = "language", default)]
    pub language: Option<String>,
    /// Output English regardless of source language (whisper-cpp `--translate`).
    #[serde(rename = "translate", default)]
    pub translate: bool,
    /// Attempt speaker diarisation (whisper-cpp `--diarize`).
    #[serde(rename = "diarize", default)]
    pub diarize: bool,
}

#[derive(Debug, Serialize)]
pub struct TranscribeResult {
    #[serde(rename = "mediaId")]
    pub media_id: String,
    pub words: Vec<Word>,
    /// Which engine produced this result.
    pub engine: TranscriptionEngine,
}

#[derive(Debug, Serialize, Clone)]
pub struct TranscribeProgress {
    #[serde(rename = "mediaId")]
    pub media_id: String,
    pub progress: f64,
    #[serde(rename = "currentTime")]
    pub current_time: f64,
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let mut p = app.path().app_data_dir().map_err(|e| e.to_string())?;
    p.push("models");
    Ok(p)
}

fn whisperkit_models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let mut p = app.path().app_data_dir().map_err(|e| e.to_string())?;
    p.push("whisperkit-models");
    Ok(p)
}

// ---------------------------------------------------------------------------
// list_models  (both engines)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_models(app: AppHandle) -> Result<Vec<ModelInfo>, String> {
    let mut out = Vec::new();

    // — whisper.cpp GGML models —
    let ggml_dir = models_dir(&app)?;
    for &m in &[
        WhisperModel::Tiny,
        WhisperModel::Base,
        WhisperModel::Small,
        WhisperModel::Medium,
        WhisperModel::LargeV3Turbo,
    ] {
        out.push(ModelInfo {
            engine: TranscriptionEngine::WhisperCpp,
            name: serde_json::to_value(m)
                .ok()
                .and_then(|v| v.as_str().map(String::from))
                .unwrap_or_default(),
            size_mb: m.size_mb(),
            installed: ggml_dir.join(m.filename()).exists(),
        });
    }

    // — WhisperKit .mlmodelc models —
    let wk_dir = whisperkit_models_dir(&app)?;
    for &m in &[
        WhisperKitModel::Tiny,
        WhisperKitModel::Base,
        WhisperKitModel::Small,
        WhisperKitModel::LargeV3Turbo,
        WhisperKitModel::LargeV3,
    ] {
        // "installed" = config.json sentinel present (written last by download)
        let model_dir = wk_dir.join(m.local_dir());
        let installed = model_dir.join("config.json").exists();
        out.push(ModelInfo {
            engine: TranscriptionEngine::WhisperKit,
            name: m.repo_name().to_string(),
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
    url: &str,
    dest: &PathBuf,
    progress_name: impl Serialize,
    progress_scale: f64,
    progress_offset: f64,
) -> Result<(), String> {
    let tmp = dest.with_extension(format!(
        "{}.partial",
        dest.extension().unwrap_or_default().to_string_lossy()
    ));

    let resp = reqwest::get(url).await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!(
            "download failed ({}): {}",
            dest.display(),
            resp.status()
        ));
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

/// Download a whisper.cpp GGML model (bin + optional Core ML encoder).
async fn download_whisper_cpp_model(
    app: &AppHandle,
    name: WhisperModel,
) -> Result<(), String> {
    let dir = models_dir(app)?;
    fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;

    let bin_url = format!(
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/{}",
        name.filename()
    );
    let bin_dest = dir.join(name.filename());
    download_hf_file(app, &bin_url, &bin_dest, name, 0.85, 0.0).await?;
    ensure_coreml_encoder(app, &dir, name).await;
    Ok(())
}

/// A single entry returned by the HuggingFace tree API.
#[derive(Debug, Deserialize)]
struct HfTreeEntry {
    /// `"file"` or `"directory"`.
    #[serde(rename = "type")]
    kind: String,
    /// Repo-relative path, e.g. `"openai_whisper-tiny/config.json"`.
    path: String,
}

/// Return every *file* path under `repo_path` in `argmaxinc/whisperkit-coreml`,
/// by calling the HuggingFace tree API with `?recursive=true`.
async fn list_hf_model_files(repo_path: &str) -> Result<Vec<String>, String> {
    let url = format!(
        "https://huggingface.co/api/models/argmaxinc/whisperkit-coreml/tree/main/{}?recursive=true",
        repo_path
    );
    let client = reqwest::Client::builder()
        .user_agent("scribe/2.3")
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("HF tree API request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "HF tree API returned {}: {}",
            resp.status(),
            url
        ));
    }
    let entries: Vec<HfTreeEntry> = resp
        .json()
        .await
        .map_err(|e| format!("HF tree API JSON parse failed: {e}"))?;
    Ok(entries
        .into_iter()
        .filter(|e| e.kind == "file")
        .map(|e| e.path)
        .collect())
}

/// Download WhisperKit `.mlmodelc` bundles for a given model from Argmax's
/// HuggingFace repository (`argmaxinc/whisperkit-coreml`).
///
/// `.mlmodelc` bundles are *directories* (not single files), so we enumerate
/// every file under the model subdirectory via the HuggingFace tree API, then
/// download each file individually while preserving the directory structure.
///
/// `config.json` is downloaded last; its presence on disk is the sentinel that
/// `list_models()` uses to declare the model installed.
async fn download_whisperkit_model(
    app: &AppHandle,
    model: WhisperKitModel,
) -> Result<(), String> {
    let base_dir = whisperkit_models_dir(app)?;
    let model_dir = base_dir.join(model.local_dir());

    // Enumerate every file in the model directory.
    let all_files = list_hf_model_files(model.repo_name()).await?;
    if all_files.is_empty() {
        return Err(format!(
            "No files found for model {} — check argmaxinc/whisperkit-coreml on HuggingFace",
            model.repo_name()
        ));
    }

    // Sort so config.json is last (it's our "installed" sentinel).
    let mut sorted = all_files;
    sorted.sort_by_key(|p| if p.ends_with("config.json") { 1 } else { 0 });

    let n = sorted.len() as f64;
    let prefix = format!("{}/", model.repo_name());

    for (i, repo_relative_path) in sorted.iter().enumerate() {
        // Strip the model-directory prefix to get the file's local relative path.
        let local_relative = repo_relative_path
            .strip_prefix(&prefix)
            .unwrap_or(repo_relative_path);

        let dest = model_dir.join(local_relative);

        // Ensure parent directories exist (e.g. AudioEncoder.mlmodelc/weights/).
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("create_dir_all {}: {e}", parent.display()))?;
        }

        let url = format!(
            "https://huggingface.co/argmaxinc/whisperkit-coreml/resolve/main/{}",
            repo_relative_path
        );
        let scale = 1.0 / n;
        let offset = i as f64 / n;
        download_hf_file(app, &url, &dest, model.repo_name(), scale, offset).await?;
    }

    Ok(())
}

#[tauri::command]
pub async fn download_model(
    app: AppHandle,
    state: State<'_, AppState>,
    engine: TranscriptionEngine,
    name: String,
) -> Result<(), String> {
    let job = state
        .jobs
        .create(
            &app,
            JobKind::DownloadModel,
            format!("Downloading model: {name}"),
        )
        .await;
    job.mark_running().await;

    let result = match engine {
        TranscriptionEngine::WhisperCpp => {
            let model: WhisperModel = serde_json::from_value(serde_json::Value::String(name))
                .map_err(|e| format!("unknown whisper-cpp model: {e}"))?;
            download_whisper_cpp_model(&app, model).await
        }
        TranscriptionEngine::WhisperKit => {
            let model: WhisperKitModel = serde_json::from_value(serde_json::Value::String(name))
                .map_err(|e| format!("unknown whisperkit model: {e}"))?;
            download_whisperkit_model(&app, model).await
        }
    };

    match &result {
        Ok(()) => job.mark_completed().await,
        Err(e) => job.mark_failed(e.clone()).await,
    }
    result
}

// ---------------------------------------------------------------------------
// ensure_coreml_encoder — whisper.cpp Core ML companion (unchanged)
// ---------------------------------------------------------------------------

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
    let zip_url = format!(
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/{}",
        zip_name
    );

    let ok = match download_hf_file(app, &zip_url, &zip_dest, name, 1.0, 0.0).await {
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
// transcribe  (public Tauri command)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn transcribe(
    app: AppHandle,
    state: State<'_, AppState>,
    opts: TranscribeOpts,
) -> Result<TranscribeResult, String> {
    let job = state
        .jobs
        .create(
            &app,
            JobKind::Transcribe,
            format!(
                "Transcribing ({}) — {}",
                match opts.engine {
                    TranscriptionEngine::WhisperCpp => "whisper.cpp",
                    TranscriptionEngine::WhisperKit => "WhisperKit",
                },
                &opts.model_name
            ),
        )
        .await;
    job.mark_running().await;
    let job_for_progress = job.clone();
    let media_id_for_progress = opts.media_id.clone();

    let result =
        transcribe_inner(&app, &opts, &job_for_progress, &media_id_for_progress).await;
    match &result {
        Ok(_) => job.mark_completed().await,
        Err(e) => job.mark_failed(e.clone()).await,
    }
    result
}

async fn transcribe_inner(
    app: &AppHandle,
    opts: &TranscribeOpts,
    job: &crate::jobs::JobHandle,
    media_id: &str,
) -> Result<TranscribeResult, String> {
    app.emit(
        "transcribe:progress",
        TranscribeProgress {
            media_id: opts.media_id.clone(),
            progress: 0.01,
            current_time: 0.0,
        },
    )
    .ok();

    // 1) Extract audio to a temp wav (same for both engines)
    let wav = tempfile_with_ext("wav");
    let shell = app.shell();
    let ffmpeg = shell
        .sidecar("ffmpeg")
        .map_err(|e| format!("ffmpeg sidecar not available: {e}"))?
        .args([
            "-y",
            "-i", &opts.media_path,
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

    // 2) Branch on engine
    let words = match opts.engine {
        TranscriptionEngine::WhisperCpp => {
            transcribe_whisper_cpp(app, opts, job, &wav).await?
        }
        TranscriptionEngine::WhisperKit => {
            transcribe_whisperkit(app, opts, job, &wav).await?
        }
    };

    let _ = media_id;

    // 3) Emit final "done"
    let total_duration = opts.media_duration.max(1.0);
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
        media_id: opts.media_id.clone(),
        words,
        engine: opts.engine,
    })
}

// ---------------------------------------------------------------------------
// whisper.cpp path
// ---------------------------------------------------------------------------

async fn transcribe_whisper_cpp(
    app: &AppHandle,
    opts: &TranscribeOpts,
    job: &crate::jobs::JobHandle,
    wav: &PathBuf,
) -> Result<Vec<Word>, String> {
    let models = models_dir(app)?;

    let model_enum: WhisperModel =
        serde_json::from_value(serde_json::Value::String(opts.model_name.clone()))
            .map_err(|_| format!("unknown whisper-cpp model: {}", opts.model_name))?;

    let model_path = models.join(model_enum.filename());
    if !model_path.exists() {
        return Err(format!(
            "model not installed: {}. Call download_model first.",
            model_enum.filename()
        ));
    }

    let use_coreml = ensure_coreml_encoder(app, &models, model_enum).await;
    if !use_coreml {
        log::warn!(
            "Core ML encoder unavailable for {} — falling back to CPU (--no-gpu)",
            model_enum.filename()
        );
    }

    let model_str = model_path.to_str().unwrap().to_string();
    let wav_str = wav.to_str().unwrap().to_string();
    let mut whisper_args: Vec<String> = vec![
        "-m".into(), model_str,
        "-f".into(), wav_str,
        "--output-json-full".into(),
        "--word-thold".into(), "0.01".into(),
        "--split-on-word".into(),
    ];
    if !use_coreml {
        whisper_args.push("--no-gpu".into());
    }
    // Language / translation flags
    let effective_language = opts.language.as_deref().filter(|l| !l.is_empty() && *l != "auto");
    if let Some(lang) = effective_language {
        whisper_args.push("--language".into());
        whisper_args.push(lang.to_string());
    }
    if opts.translate {
        whisper_args.push("--translate".into());
    }
    // Speaker diarisation
    if opts.diarize {
        whisper_args.push("--diarize".into());
    }

    let shell = app.shell();
    let whisper = shell
        .sidecar("whisper-cli")
        .map_err(|e| format!("whisper-cli sidecar not available: {e}"))?
        .args(whisper_args);

    let (mut rx, _child) = whisper.spawn().map_err(|e| format!("spawn whisper-cli: {e}"))?;
    let mut stderr = String::new();
    let total_duration = opts.media_duration.max(1.0);

    while let Some(ev) = rx.recv().await {
        match ev {
            CommandEvent::Stderr(line) => {
                let line = String::from_utf8_lossy(&line).to_string();
                stderr.push_str(&line);
                stderr.push('\n');
                if let Some(current_time) = parse_progress_line(&line) {
                    let progress = (current_time / total_duration).clamp(0.02, 0.99);
                    app.emit(
                        "transcribe:progress",
                        TranscribeProgress {
                            media_id: opts.media_id.clone(),
                            progress,
                            current_time,
                        },
                    )
                    .ok();
                    let eta = ((total_duration - current_time).max(0.0)) as i64;
                    job.set_progress(progress, Some(eta)).await;
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

    let json_path = wav.with_extension("wav.json");
    let json = fs::read_to_string(&json_path)
        .await
        .map_err(|e| format!("reading whisper json {}: {}", json_path.display(), e))?;
    let words = parse_whisper_json(&json).map_err(|e| e.to_string())?;

    let _ = fs::remove_file(wav).await;
    let _ = fs::remove_file(&json_path).await;

    Ok(words)
}

// ---------------------------------------------------------------------------
// WhisperKit path
// ---------------------------------------------------------------------------

async fn transcribe_whisperkit(
    app: &AppHandle,
    opts: &TranscribeOpts,
    job: &crate::jobs::JobHandle,
    wav: &PathBuf,
) -> Result<Vec<Word>, String> {
    let wk_dir = whisperkit_models_dir(app)?;

    let model_enum: WhisperKitModel =
        serde_json::from_value(serde_json::Value::String(opts.model_name.clone()))
            .map_err(|_| format!("unknown whisperkit model: {}", opts.model_name))?;

    let model_dir = wk_dir.join(model_enum.local_dir());
    if !model_dir.exists() {
        return Err(format!(
            "WhisperKit model not installed: {}. Call download_model first.",
            model_enum.repo_name()
        ));
    }

    // whisperkit-cli writes `<audio-stem>.json` next to the audio file when
    // `--report` is passed.  We do NOT use `--output-dir` — that flag does not
    // exist in the Argmax CLI; the output location is always the directory that
    // contains the audio file.
    let shell = app.shell();
    let wk = shell
        .sidecar("whisperkit-cli")
        .map_err(|e| format!("whisperkit-cli sidecar not available: {e}"))?
        .args([
            "transcribe",
            "--audio-path",
            wav.to_str().unwrap(),
            "--model-path",
            model_dir.to_str().unwrap(),
            "--word-timestamps",
            "--report",          // write <audio-stem>.json next to the wav
        ]);

    let (mut rx, _child) = wk.spawn().map_err(|e| format!("spawn whisperkit-cli: {e}"))?;
    let mut stderr = String::new();
    let total_duration = opts.media_duration.max(1.0);

    while let Some(ev) = rx.recv().await {
        match ev {
            CommandEvent::Stderr(line) => {
                let line = String::from_utf8_lossy(&line).to_string();
                stderr.push_str(&line);
                stderr.push('\n');
                // WhisperKit prints "Progress: 0.42" style lines on stderr.
                if let Some(p) = parse_whisperkit_progress(&line) {
                    app.emit(
                        "transcribe:progress",
                        TranscribeProgress {
                            media_id: opts.media_id.clone(),
                            progress: p.clamp(0.02, 0.99),
                            current_time: p * total_duration,
                        },
                    )
                    .ok();
                    let eta = ((total_duration * (1.0 - p)).max(0.0)) as i64;
                    job.set_progress(p, Some(eta)).await;
                }
            }
            CommandEvent::Stdout(line) => {
                // whisperkit-cli also writes progress to stdout in some versions.
                let line = String::from_utf8_lossy(&line).to_string();
                if let Some(p) = parse_whisperkit_progress(&line) {
                    let progress = p.clamp(0.02, 0.99);
                    app.emit(
                        "transcribe:progress",
                        TranscribeProgress {
                            media_id: opts.media_id.clone(),
                            progress,
                            current_time: progress * total_duration,
                        },
                    )
                    .ok();
                }
            }
            CommandEvent::Terminated(t) => {
                if t.code != Some(0) {
                    return Err(format!("whisperkit-cli failed: {}", stderr.trim()));
                }
                break;
            }
            _ => {}
        }
    }

    // whisperkit-cli writes `<audio-stem>.json` in the same directory as the
    // wav file when --report is passed.
    let json_path = wav.with_extension("json");
    let json = fs::read_to_string(&json_path)
        .await
        .map_err(|e| format!("reading whisperkit json {}: {}", json_path.display(), e))?;
    let words = parse_whisperkit_json(&json).map_err(|e| e.to_string())?;

    let _ = fs::remove_file(wav).await;
    let _ = fs::remove_file(&json_path).await;

    Ok(words)
}

// ---------------------------------------------------------------------------
// Progress line parsers
// ---------------------------------------------------------------------------

/// Parse a whisper.cpp stderr progress line:
///   `[00:00:30.000 --> 00:00:32.500]` → 32.5 seconds
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

/// Parse a WhisperKit progress line.
///
/// WhisperKit CLI emits lines like:
///   `  Progress: 42%`
///   `transcribing segment 5 / 12`
///
/// We handle both forms and return a 0.0–1.0 fraction.
fn parse_whisperkit_progress(line: &str) -> Option<f64> {
    let line = line.trim();

    // "Progress: 42%" or "Progress: 0.42"
    if let Some(rest) = line.strip_prefix("Progress:") {
        let rest = rest.trim().trim_end_matches('%');
        if let Ok(v) = rest.parse::<f64>() {
            return Some(if v > 1.0 { v / 100.0 } else { v });
        }
    }

    // "transcribing segment N / M"
    if line.to_ascii_lowercase().contains("segment") {
        let nums: Vec<u64> = line
            .split_whitespace()
            .filter_map(|w| w.trim_end_matches('/').parse().ok())
            .collect();
        if nums.len() >= 2 {
            return Some(nums[0] as f64 / nums[1] as f64);
        }
    }

    None
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_whisper_cpp_progress_line() {
        let line = "[00:00:30.500 --> 00:00:32.500]  hello world";
        assert_eq!(parse_progress_line(line), Some(32.5));
    }

    #[test]
    fn rejects_non_progress_lines() {
        assert_eq!(parse_progress_line("loading model"), None);
        assert_eq!(parse_progress_line("[foo]"), None);
    }

    #[test]
    fn parses_whisperkit_progress_percent() {
        assert_eq!(parse_whisperkit_progress("Progress: 42%"), Some(0.42));
        assert_eq!(parse_whisperkit_progress("  Progress: 100%"), Some(1.0));
    }

    #[test]
    fn parses_whisperkit_progress_fraction() {
        // Some builds emit a 0-1 float rather than a percentage.
        let v = parse_whisperkit_progress("Progress: 0.75").unwrap();
        assert!((v - 0.75).abs() < 1e-9);
    }

    #[test]
    fn parses_whisperkit_segment_progress() {
        let v = parse_whisperkit_progress("transcribing segment 3 / 12").unwrap();
        assert!((v - 0.25).abs() < 1e-9);
    }

    #[test]
    fn coreml_encoder_names() {
        assert_eq!(
            WhisperModel::Tiny.coreml_encoder_dir(),
            "ggml-tiny-encoder.mlmodelc"
        );
        assert_eq!(
            WhisperModel::LargeV3Turbo.coreml_encoder_dir(),
            "ggml-large-v3-turbo-encoder.mlmodelc"
        );
        assert_eq!(
            WhisperModel::Tiny.coreml_encoder_zip(),
            "ggml-tiny-encoder.mlmodelc.zip"
        );
    }

    #[test]
    fn whisperkit_model_repo_names() {
        assert_eq!(
            WhisperKitModel::LargeV3Turbo.repo_name(),
            "openai_whisper-large-v3-turbo"
        );
        assert_eq!(WhisperKitModel::Tiny.repo_name(), "openai_whisper-tiny");
    }

    #[test]
    fn transcription_engine_default_is_whisper_cpp() {
        let engine = TranscriptionEngine::default();
        assert_eq!(engine, TranscriptionEngine::WhisperCpp);
    }

    #[test]
    fn transcription_engine_deserialises_from_json() {
        let e: TranscriptionEngine =
            serde_json::from_str("\"whisper-kit\"").unwrap();
        assert_eq!(e, TranscriptionEngine::WhisperKit);
        let e: TranscriptionEngine =
            serde_json::from_str("\"whisper-cpp\"").unwrap();
        assert_eq!(e, TranscriptionEngine::WhisperCpp);
    }
}
