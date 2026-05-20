//! Project snapshots — create / list / restore / delete.
//!
//! Snapshots live inside the `.scribe` bundle, so they survive restarts and
//! travel with the project file. See `crate::snapshots` for the on-disk
//! layout.

use crate::AppState;
use crate::edl::Project;
use crate::jobs::JobKind;
use crate::snapshots::{self, SnapshotIndex};
use std::path::Path;
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn create_snapshot(
    app: AppHandle,
    state: State<'_, AppState>,
    project: Project,
    #[allow(non_snake_case)] projectPath: String,
    label: String,
) -> Result<SnapshotIndex, String> {
    let bundle = Path::new(&projectPath);
    if !bundle.exists() {
        return Err(format!("project bundle does not exist: {projectPath}"));
    }

    // Snapshots are cheap but we still surface them in the Jobs flyout so a
    // user kicking off N consecutive snapshots sees they're tracked.
    let handle = state
        .jobs
        .create(&app, JobKind::Snapshot, format!("Snapshot — {label}"))
        .await;
    handle.mark_running().await;

    match snapshots::create(bundle, &project, &label).await {
        Ok(idx) => {
            handle.mark_completed().await;
            Ok(idx)
        }
        Err(e) => {
            handle.mark_failed(e.to_string()).await;
            Err(e.to_string())
        }
    }
}

#[tauri::command]
pub async fn list_snapshots(
    #[allow(non_snake_case)] projectPath: String,
) -> Result<Vec<SnapshotIndex>, String> {
    let bundle = Path::new(&projectPath);
    if !bundle.exists() {
        return Ok(Vec::new());
    }
    snapshots::list(bundle).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn restore_snapshot(
    #[allow(non_snake_case)] projectPath: String,
    id: String,
) -> Result<Project, String> {
    let bundle = Path::new(&projectPath);
    snapshots::restore(bundle, &id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_snapshot(
    #[allow(non_snake_case)] projectPath: String,
    id: String,
) -> Result<(), String> {
    let bundle = Path::new(&projectPath);
    snapshots::delete(bundle, &id).await.map_err(|e| e.to_string())
}
