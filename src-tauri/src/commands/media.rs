//! `import_media` — run ffprobe + sha256 on a video file and return parsed metadata.

use crate::edl::SourceMedia;
use crate::media::{parse_ffprobe_json, sha256_file};
use std::path::Path;
use tauri::Manager;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;

#[tauri::command]
pub async fn import_media(app: tauri::AppHandle, path: String) -> Result<SourceMedia, String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("file not found: {}", path));
    }

    // sha256 first (cheap if SSD; surfaces I/O errors early).
    let sha = sha256_file(p).await.map_err(|e| e.to_string())?;

    // Spawn the bundled ffprobe sidecar.
    let shell = app.shell();
    let cmd = shell
        .sidecar("ffprobe")
        .map_err(|e| format!("ffprobe sidecar not available: {e}"))?
        .args([
            "-v", "error",
            "-print_format", "json",
            "-show_format",
            "-show_streams",
            &path,
        ]);

    let (mut rx, _child) = cmd.spawn().map_err(|e| format!("spawn ffprobe: {e}"))?;

    let mut stdout = String::new();
    let mut stderr = String::new();
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(line) => {
                stdout.push_str(&String::from_utf8_lossy(&line));
                stdout.push('\n');
            }
            CommandEvent::Stderr(line) => {
                stderr.push_str(&String::from_utf8_lossy(&line));
                stderr.push('\n');
            }
            CommandEvent::Terminated(t) => {
                if t.code != Some(0) {
                    return Err(format!("ffprobe failed: {}", stderr.trim()));
                }
                break;
            }
            _ => {}
        }
    }

    parse_ffprobe_json(&path, sha, &stdout).map_err(|e| e.to_string())
}
