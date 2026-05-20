#!/usr/bin/env python3
"""PyInstaller build script for the MLX-LLM sidecar.

Produces a single self-contained binary at:
    src-tauri/binaries/mlx-sidecar-aarch64-apple-darwin

Run from the repo root:
    python sidecars/mlx-llm/build.py

Requirements:
    pip install pyinstaller
    # mlx-lm and its deps must be installed in the active venv.

The binary name follows Tauri's sidecar convention:
    <stem>-<target-triple>
where the stem matches the key in tauri.conf.json `bundle.externalBin`.
"""

from __future__ import annotations

import platform
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
SIDECAR_DIR = Path(__file__).resolve().parent
OUT_DIR = REPO_ROOT / "src-tauri" / "binaries"

# Tauri target triple for Apple Silicon.
# For Intel builds swap to x86_64-apple-darwin.
TARGET_TRIPLE = "aarch64-apple-darwin"
BINARY_NAME = f"mlx-sidecar-{TARGET_TRIPLE}"


def main() -> None:
    if platform.system() != "Darwin":
        print("ERROR: This sidecar targets macOS Apple Silicon only.", file=sys.stderr)
        sys.exit(1)

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--onefile",
        "--name", BINARY_NAME,
        "--distpath", str(OUT_DIR),
        "--workpath", str(SIDECAR_DIR / "build"),
        "--specpath", str(SIDECAR_DIR / "build"),
        # Hidden imports needed by mlx-lm that PyInstaller may miss.
        "--hidden-import", "mlx",
        "--hidden-import", "mlx.core",
        "--hidden-import", "mlx_lm",
        "--hidden-import", "mlx_lm.utils",
        "--hidden-import", "transformers",
        # Entry point
        str(SIDECAR_DIR / "mlx_llm" / "__main__.py"),
    ]

    print("Running PyInstaller …")
    print(" ".join(cmd))
    result = subprocess.run(cmd, cwd=str(REPO_ROOT))
    if result.returncode != 0:
        print("PyInstaller failed.", file=sys.stderr)
        sys.exit(result.returncode)

    binary = OUT_DIR / BINARY_NAME
    print(f"\nBinary written to: {binary}")
    print("Add execute permission if needed:")
    print(f"  chmod +x {binary}")


if __name__ == "__main__":
    main()
