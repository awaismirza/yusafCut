// Prevents additional console window on Windows in release. Kept for parity even
// though Scribe is a macOS-only target — costs nothing.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    scribe_lib::run()
}
