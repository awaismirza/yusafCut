//! AI features powered by the MLX-LLM sidecar.
//!
//! Commands:
//!   - `detect_chapters` — chapter title generation from a transcript.
//!   - `suggest_broll`   — b-roll search query suggestions for a timeline span.
//!
//! `detect_chapters` feeds a plain-text transcript to the on-device
//! Llama-3.2-3B-Instruct-4bit model running inside `mlx-sidecar` and returns
//! a list of chapter markers that the editor inserts as draft chapters.
//!
//! Frontend calls this via:
//!   ```ts
//!   invoke<ChapterMarker[]>('detect_chapters', { mediaId, transcript, nChapters })
//!   ```
//!
//! The command is intentionally fire-and-forget from the UI perspective —
//! it's tracked as a background Job so the user can see progress in the
//! Jobs flyout without blocking the editor.

use crate::AppState;
use crate::jobs::JobKind;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// A single chapter marker returned to the frontend.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChapterMarker {
    pub title: String,
    /// Start time in seconds from the beginning of the recording.
    #[serde(rename = "startSeconds")]
    pub start_seconds: f64,
}

/// Options accepted by `detect_chapters`.
#[derive(Debug, Deserialize)]
pub struct DetectChaptersOpts {
    /// Used only to label the Job entry in the flyout.
    #[serde(rename = "mediaId")]
    pub media_id: String,
    /// Plain text transcript, optionally with `[SS.s]` word timestamps.
    pub transcript: String,
    /// How many chapters to request. Defaults to 10.
    #[serde(rename = "nChapters", default = "default_n_chapters")]
    pub n_chapters: u32,
    /// Override the MLX model. Defaults to Llama-3.2-3B-Instruct-4bit.
    #[serde(default = "default_model")]
    pub model: String,
}

fn default_n_chapters() -> u32 {
    10
}

fn default_model() -> String {
    "mlx-community/Llama-3.2-3B-Instruct-4bit".to_string()
}

// ---------------------------------------------------------------------------
// detect_chapters command
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn detect_chapters(
    app: AppHandle,
    state: State<'_, AppState>,
    opts: DetectChaptersOpts,
) -> Result<Vec<ChapterMarker>, String> {
    // Surface in the Jobs flyout so the user can see the LLM is running.
    let job = state
        .jobs
        .create(
            &app,
            JobKind::DetectChapters,
            format!("Detecting chapters — {}", opts.media_id),
        )
        .await;
    job.mark_running().await;

    let result = run_detect_chapters(&app, &state, &opts).await;

    match &result {
        Ok(_) => job.mark_completed().await,
        Err(e) => job.mark_failed(e.clone()).await,
    }

    result
}

async fn run_detect_chapters(
    app: &AppHandle,
    state: &AppState,
    opts: &DetectChaptersOpts,
) -> Result<Vec<ChapterMarker>, String> {
    // Build the payload that maps to mlx_llm.schemas.SummarisePayload.
    let payload = serde_json::json!({
        "transcript": opts.transcript,
        "n_chapters": opts.n_chapters,
        "model":      opts.model,
    });

    let raw = state
        .llm
        .call(app, "summarise", payload)
        .await
        .map_err(|e| format!("LLM sidecar error: {e}"))?;

    // raw is the JSON `result` value — parse into our Vec<ChapterMarker>.
    // The Python side returns {"chapters": [{title, start_seconds}, ...]}.
    let chapters_value = raw
        .get("chapters")
        .ok_or("sidecar response missing 'chapters' field")?
        .clone();

    #[derive(Deserialize)]
    struct PythonChapter {
        title: String,
        start_seconds: f64,
    }

    let py_chapters: Vec<PythonChapter> = serde_json::from_value(chapters_value)
        .map_err(|e| format!("failed to parse chapters from sidecar: {e}"))?;

    Ok(py_chapters
        .into_iter()
        .map(|c| ChapterMarker {
            title: c.title,
            start_seconds: c.start_seconds,
        })
        .collect())
}

// ---------------------------------------------------------------------------
// suggest_broll command
// ---------------------------------------------------------------------------

/// A single b-roll suggestion returned to the frontend.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BrollSuggestion {
    /// Stock-footage / Unsplash search query (4–8 words).
    pub query: String,
    /// Output-timeline start of the span this suggestion covers.
    #[serde(rename = "startSeconds")]
    pub start_seconds: f64,
    /// Output-timeline end of the span this suggestion covers.
    #[serde(rename = "endSeconds")]
    pub end_seconds: f64,
    /// One-sentence explanation of why this shot suits the content.
    pub rationale: String,
}

/// Options accepted by `suggest_broll`.
#[derive(Debug, Deserialize)]
pub struct SuggestBrollOpts {
    /// Used to label the Job entry.
    #[serde(rename = "mediaId")]
    pub media_id: String,
    /// Transcript text for the span (plain text with optional `[SS.s]` timestamps).
    pub transcript: String,
    /// Output-timeline start of the span, in seconds.
    #[serde(rename = "startSeconds")]
    pub start_seconds: f64,
    /// Output-timeline end of the span, in seconds.
    #[serde(rename = "endSeconds")]
    pub end_seconds: f64,
    /// How many suggestions to request. Defaults to 3.
    #[serde(rename = "nSuggestions", default = "default_n_suggestions")]
    pub n_suggestions: u32,
    /// Override the MLX model.
    #[serde(default = "default_model")]
    pub model: String,
}

fn default_n_suggestions() -> u32 { 3 }

#[tauri::command]
pub async fn suggest_broll(
    app: AppHandle,
    state: State<'_, AppState>,
    opts: SuggestBrollOpts,
) -> Result<Vec<BrollSuggestion>, String> {
    let job = state
        .jobs
        .create(
            &app,
            JobKind::SuggestBroll,
            format!("B-roll suggestions — {}", opts.media_id),
        )
        .await;
    job.mark_running().await;

    let result = run_suggest_broll(&app, &state, &opts).await;

    match &result {
        Ok(_) => job.mark_completed().await,
        Err(e) => job.mark_failed(e.clone()).await,
    }

    result
}

async fn run_suggest_broll(
    app: &AppHandle,
    state: &AppState,
    opts: &SuggestBrollOpts,
) -> Result<Vec<BrollSuggestion>, String> {
    let payload = serde_json::json!({
        "transcript":    opts.transcript,
        "start_seconds": opts.start_seconds,
        "end_seconds":   opts.end_seconds,
        "n_suggestions": opts.n_suggestions,
        "model":         opts.model,
    });

    let raw = state
        .llm
        .call(app, "broll", payload)
        .await
        .map_err(|e| format!("LLM sidecar error: {e}"))?;

    let suggestions_value = raw
        .get("suggestions")
        .ok_or("sidecar response missing 'suggestions' field")?
        .clone();

    #[derive(Deserialize)]
    struct PythonSuggestion {
        query: String,
        start_seconds: f64,
        end_seconds: f64,
        #[serde(default)]
        rationale: String,
    }

    let py: Vec<PythonSuggestion> = serde_json::from_value(suggestions_value)
        .map_err(|e| format!("failed to parse b-roll suggestions from sidecar: {e}"))?;

    Ok(py
        .into_iter()
        .map(|s| BrollSuggestion {
            query: s.query,
            start_seconds: s.start_seconds,
            end_seconds: s.end_seconds,
            rationale: s.rationale,
        })
        .collect())
}
