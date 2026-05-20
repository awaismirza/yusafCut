//! Project save / load / relink commands.

use crate::edl::{Project, SourceMedia};
use crate::media::sha256_file;
use crate::media::parse_ffprobe_json;
use std::path::Path;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;

#[tauri::command]
pub async fn save_project(project: Project, path: String) -> Result<(), String> {
    let p = Path::new(&path);
    crate::project::save(&project, p).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn load_project(path: String) -> Result<Project, String> {
    let p = Path::new(&path);
    crate::project::load(p).await.map_err(|e| e.to_string())
}

/// Relink: user has moved a media file. Re-probe and confirm SHA-256 matches.
#[tauri::command]
pub async fn relink_media(
    app: tauri::AppHandle,
    path: String,
    expected_sha256: String,
) -> Result<SourceMedia, String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("file not found: {}", path));
    }
    let actual = sha256_file(p).await.map_err(|e| e.to_string())?;
    if actual != expected_sha256 {
        return Err(format!(
            "SHA-256 mismatch — expected {expected_sha256}, got {actual}"
        ));
    }
    // Re-probe via ffprobe
    let shell = app.shell();
    let cmd = shell
        .sidecar("ffprobe")
        .map_err(|e| format!("ffprobe: {e}"))?
        .args([
            "-v", "error",
            "-print_format", "json",
            "-show_format",
            "-show_streams",
            &path,
        ]);
    let (mut rx, _child) = cmd.spawn().map_err(|e| format!("spawn ffprobe: {e}"))?;
    let mut stdout = String::new();
    while let Some(ev) = rx.recv().await {
        match ev {
            CommandEvent::Stdout(line) => {
                stdout.push_str(&String::from_utf8_lossy(&line));
                stdout.push('\n');
            }
            CommandEvent::Terminated(t) => {
                if t.code != Some(0) {
                    return Err("ffprobe failed during relink".into());
                }
                break;
            }
            _ => {}
        }
    }
    parse_ffprobe_json(&path, actual, &stdout).map_err(|e| e.to_string())
}
