use std::path::PathBuf;
use std::sync::Arc;
use tauri_plugin_shell::process::CommandChild;
use tokio::sync::Mutex;

#[derive(Default)]
pub struct RecordingState {
    pub session: Arc<Mutex<Option<RecordingSession>>>,
}

pub struct RecordingSession {
    pub child: CommandChild,
    pub output_path: PathBuf,
}
