"""Entry point for the MLX-LLM sidecar.

Usage (direct):
    python -m mlx_llm

Usage (as installed script):
    mlx-llm

Usage (as PyInstaller bundle):
    ./mlx-sidecar-aarch64-apple-darwin

The process reads LLMRequest JSON lines from stdin and writes LLMResponse
JSON lines to stdout until EOF.
"""

from __future__ import annotations

import logging
import sys


def main() -> None:
    # Configure logging to stderr so it doesn't pollute the stdout JSON channel.
    logging.basicConfig(
        stream=sys.stderr,
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    from .server import serve

    try:
        serve()
    except KeyboardInterrupt:
        pass
    sys.exit(0)


if __name__ == "__main__":
    main()
