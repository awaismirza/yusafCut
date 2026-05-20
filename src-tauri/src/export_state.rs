//! Shared state for the currently-running export, so the cancel command can
//! find and kill the child process.

use std::sync::Arc;
use tauri_plugin_shell::process::CommandChild;
use tokio::sync::Mutex;

#[derive(Default)]
pub struct ExportState {
    pub child: Arc<Mutex<Option<CommandChild>>>,
}
