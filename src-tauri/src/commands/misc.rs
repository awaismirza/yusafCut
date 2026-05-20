//! Tiny utility commands.

use tauri::Manager;

#[tauri::command]
pub async fn app_data_dir(app: tauri::AppHandle) -> Result<String, String> {
    let p = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(p.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn reveal_in_finder(path: String) -> Result<(), String> {
    // We don't depend on macos-specific crates; shell out to `open -R` instead.
    let status = tokio::process::Command::new("open")
        .args(["-R", &path])
        .status()
        .await
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!("`open -R` exited with {status:?}"));
    }
    Ok(())
}
