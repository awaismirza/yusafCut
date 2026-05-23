// Prevents additional console window on Windows in release. Kept for parity even
// though YusafCut is a macOS-only target — costs nothing.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    yusafcut_lib::run()
}
