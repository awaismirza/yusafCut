//! Tauri commands that expose the JobQueue to the frontend.

use crate::AppState;
use crate::jobs::JobSnapshot;
use tauri::State;

#[tauri::command]
pub async fn list_jobs(state: State<'_, AppState>) -> Result<Vec<JobSnapshot>, String> {
    Ok(state.jobs.list().await)
}

/// Cancel a job by id. The worker is notified asynchronously and will (a)
/// kill any child process it owns, (b) call `mark_cancelled`. The command
/// returns immediately — frontend should rely on the `jobs:update` event for
/// the eventual status change.
#[tauri::command]
pub async fn cancel_job(state: State<'_, AppState>, id: String) -> Result<(), String> {
    // Best-effort: if this is the running export, also kill the current ffmpeg
    // child immediately. The JobQueue cancel signal is what makes the worker
    // call mark_cancelled.
    state.jobs.cancel(&id).await?;
    // If a current export is running, kill its child too. We do this
    // unconditionally because the running-export id is owned by the export
    // command, not us, and the killed child path is harmless to call twice.
    let mut guard = state.export.child.lock().await;
    if let Some(child) = guard.take() {
        let _ = child.kill();
    }
    Ok(())
}
