//! `import_media` — run ffprobe + sha256 on a video file and return parsed metadata.

use crate::edl::SourceMedia;
use crate::media::{parse_ffprobe_json, sha256_file};
use crate::recording_state::RecordingSession;
use crate::AppState;
use std::path::Path;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;
use tokio::fs;
use tokio::time::sleep;
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

#[tauri::command]
pub async fn start_native_recording(
    app: AppHandle,
    state: State<'_, AppState>,
    mode: String,
) -> Result<String, String> {
    let mut guard = state.recording.session.lock().await;
    if guard.is_some() {
        return Err("a recording is already running".into());
    }

    let mode = mode.as_str();
    let (prefix, extension, mut args): (&str, &str, Vec<String>) = match mode {
        "voiceover" => (
            "voiceover",
            "m4a",
            vec![
                "-y", "-hide_banner", "-f", "avfoundation", "-i", ":default", "-c:a", "aac",
                "-b:a", "192k",
            ]
            .into_iter()
            .map(String::from)
            .collect(),
        ),
        "screen" => (
            "screen-recording",
            "mp4",
            vec![
                "-y",
                "-hide_banner",
                "-f",
                "avfoundation",
                "-framerate",
                "30",
                "-capture_cursor",
                "1",
                "-capture_mouse_clicks",
                "1",
                "-i",
                "Capture screen 0:default",
                "-c:v",
                "h264_videotoolbox",
                "-b:v",
                "8000k",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
            ]
            .into_iter()
            .map(String::from)
            .collect(),
        ),
        "camera" => (
            "camera-recording",
            "mp4",
            vec![
                "-y",
                "-hide_banner",
                "-f",
                "avfoundation",
                "-framerate",
                "30",
                "-i",
                "default:default",
                "-c:v",
                "h264_videotoolbox",
                "-b:v",
                "6000k",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
            ]
            .into_iter()
            .map(String::from)
            .collect(),
        ),
        other => return Err(format!("unsupported recording mode: {other}")),
    };

    let mut dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    dir.push("recordings");
    fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;

    let path = dir.join(format!("{prefix}-{}.{}", Uuid::new_v4(), extension));
    args.push(path.to_string_lossy().to_string());

    let shell = app.shell();
    let cmd = shell
        .sidecar("ffmpeg")
        .map_err(|e| format!("ffmpeg sidecar not available: {e}"))?
        .args(args);
    let (mut rx, child) = cmd.spawn().map_err(|e| format!("spawn ffmpeg: {e}"))?;
    let path_for_task = path.clone();
    tauri::async_runtime::spawn(async move {
        let mut stderr = String::new();
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stderr(line) => {
                    let line = String::from_utf8_lossy(&line);
                    stderr.push_str(&line);
                }
                CommandEvent::Terminated(t) => {
                    if t.code != Some(0) {
                        log::warn!(
                            "recording ffmpeg exited with {:?} for {}: {}",
                            t.code,
                            path_for_task.display(),
                            stderr
                        );
                    }
                    break;
                }
                _ => {}
            }
        }
    });

    let output = path.to_string_lossy().to_string();
    *guard = Some(RecordingSession {
        child,
        output_path: path,
    });
    Ok(output)
}

#[tauri::command]
pub async fn stop_native_recording(state: State<'_, AppState>) -> Result<String, String> {
    let mut session = {
        let mut guard = state.recording.session.lock().await;
        guard.take()
            .ok_or_else(|| "no recording is currently running".to_string())?
    };

    session
        .child
        .write(b"q")
        .map_err(|e| format!("failed to stop ffmpeg recording: {e}"))?;

    // FFmpeg needs a brief moment after receiving `q` to flush container metadata.
    for _ in 0..30 {
        if let Ok(meta) = fs::metadata(&session.output_path).await {
            if meta.len() > 0 {
                sleep(Duration::from_millis(100)).await;
                break;
            }
        }
        sleep(Duration::from_millis(100)).await;
    }

    Ok(session.output_path.to_string_lossy().to_string())
}
