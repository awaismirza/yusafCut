//! MLX-Python sidecar manager (Phase 6.3, gated behind the `mlx-sidecar` feature).
//!
//! Responsibilities:
//!   1. Spawn the bundled `mlx-sidecar` binary as a child process.
//!   2. Speak a tiny JSON-line protocol over stdin/stdout.
//!   3. Ensure the child dies when the app quits (kill_on_drop).
//!
//! This module is intentionally empty for v1 — implement when section 6.3
//! lands. Kept here so the import path is stable.

pub fn placeholder() {}
