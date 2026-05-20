//! Scribe backend — Tauri-side glue and command handlers.
//!
//! Everything that talks to whisper.cpp, ffmpeg, the filesystem, or the MLX
//! sidecar lives in this crate. The frontend communicates via Tauri commands
//! declared in `commands::*`.

pub mod commands;
pub mod edl;
pub mod export_state;
#[cfg(feature = "mlx-sidecar")]
pub mod llm;
pub mod media;
pub mod project;
pub mod transcribe;

/// Shared application state passed into every Tauri command.
#[derive(Default)]
pub struct AppState {
    pub export: export_state::ExportState,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::media::import_media,
            commands::media::save_recording_file,
            commands::transcribe::transcribe,
            commands::transcribe::list_models,
            commands::transcribe::download_model,
            commands::project::save_project,
            commands::project::load_project,
            commands::project::relink_media,
            commands::export::export_video,
            commands::export::cancel_export,
            commands::misc::app_data_dir,
            commands::misc::reveal_in_finder,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Scribe");
}
