# `sidecars/mlx-llm/` — MLX Python sidecar (Phase 6.3)

This directory is reserved for the **MLX-based local LLM sidecar** described in
section 6.3 of the spec. It is **not** wired up in v1 — kept in the tree so
contributors know where to put the work when they pick up Phase 6.

## Intended responsibility

A small Python program that:

1. Loads an MLX model on startup (default: `mlx-community/Llama-3.2-3B-Instruct-4bit`).
2. Reads `LLMRequest` JSON objects from stdin.
3. Returns `LLMResponse` JSON objects (one per line) on stdout.
4. Exits cleanly on EOF.

The Rust side (`src-tauri/src/llm.rs`, currently a placeholder) will spawn this
binary with `kill_on_drop`, talk to it over pipes, and surface results to the
frontend.

## Suggested layout when implementing

```
sidecars/mlx-llm/
├── pyproject.toml          # use uv or poetry
├── mlx_llm/
│   ├── __init__.py
│   ├── __main__.py         # entry point
│   ├── server.py           # stdin/stdout JSON loop
│   ├── commands.py         # cut_to_duration, remove_tangents, find_quote, …
│   └── schemas.py          # pydantic request/response models
├── build.py                # PyInstaller wrapper
└── README.md
```

Output goes to `src-tauri/binaries/mlx-sidecar-aarch64-apple-darwin` and is
declared in `tauri.conf.json`'s `bundle.externalBin` once enabled.

## Why isolated as a subprocess?

- Keeps the GPL/MIT licence story clean (Python deps are isolated).
- The model can be unloaded / restarted independently of the main app.
- Memory pressure is contained.
- Crashes don't take down the editor.
