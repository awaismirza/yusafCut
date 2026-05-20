//! `import_media` — run ffprobe + sha256 on a video file and return parsed metadata.

use crate::edl::SourceMedia;
use crate::media::{parse_ffprobe_json, sha256_file};
use serde::Deserialize;
use std::path::Path;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;
use tokio::fs;
use tokio::io::AsyncWriteExt as _;
use uuid::Uuid;

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
            "-v",
            "error",
            "-print_format",
            "json",
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

#[derive(Debug, Deserialize)]
pub struct SaveRecordingOpts {
    pub bytes: Vec<u8>,
    pub extension: String,
    pub prefix: String,
}

#[tauri::command]
pub async fn save_recording_file(
    app: AppHandle,
    opts: SaveRecordingOpts,
) -> Result<String, String> {
    if opts.bytes.is_empty() {
        return Err("recording is empty".into());
    }

    let extension = match opts
        .extension
        .trim_start_matches('.')
        .to_ascii_lowercase()
        .as_str()
    {
        "webm" => "webm",
        "mp4" => "mp4",
        "wav" => "wav",
        "m4a" => "m4a",
        other => return Err(format!("unsupported recording extension: {other}")),
    };
    let prefix = opts
        .prefix
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect::<String>();
    let prefix = if prefix.is_empty() {
        "recording"
    } else {
        prefix.as_str()
    };

    let mut dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    dir.push("recordings");
    fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;

    let path = dir.join(format!("{prefix}-{}.{}", Uuid::new_v4(), extension));
    let mut file = fs::File::create(&path).await.map_err(|e| e.to_string())?;
    file.write_all(&opts.bytes)
        .await
        .map_err(|e| e.to_string())?;
    file.flush().await.map_err(|e| e.to_string())?;

    Ok(path.to_string_lossy().to_string())
}
