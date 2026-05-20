"""JSON-line stdin/stdout server loop.

Protocol
--------
- The Rust parent writes one ``LLMRequest`` JSON object per line to our stdin.
- We respond with one ``LLMResponse`` JSON object per line on stdout.
- We flush stdout after every response so the parent isn't blocked waiting for
  output-buffer fill.
- We exit cleanly on EOF (parent closed stdin / app quit).

Error handling
--------------
- Malformed JSON on a line → emit an error response for that line and continue.
- Exception inside a command → emit an error response and continue.
- Unrecoverable errors (import failure, etc.) → let the process crash; the
  Rust sidecar manager will restart it.
"""

from __future__ import annotations

import json
import logging
import sys

from pydantic import ValidationError

from .commands import broll, summarise
from .schemas import BrollResult, LLMRequest, LLMResponseErr, LLMResponseOk, SummariseResult

logger = logging.getLogger(__name__)


def _handle(line: str) -> str:
    """Parse one request line, dispatch, and return a response JSON string."""
    # --- parse ---
    try:
        data = json.loads(line)
        request = LLMRequest.model_validate(data)
    except (json.JSONDecodeError, ValidationError) as exc:
        # We don't have an id if JSON is malformed, use a sentinel.
        req_id = data.get("id", "unknown") if isinstance(data, dict) else "unknown"  # type: ignore[union-attr]
        return LLMResponseErr(id=req_id, error=str(exc)).model_dump_json()

    # --- dispatch ---
    try:
        if request.command == "summarise":
            result: SummariseResult = summarise(request.payload)
            return LLMResponseOk(id=request.id, result=result).model_dump_json()
        elif request.command == "broll":
            broll_result: BrollResult = broll(request.payload)
            return LLMResponseOk(id=request.id, result=broll_result).model_dump_json()
        else:
            return LLMResponseErr(
                id=request.id,
                error=f"Unknown command: {request.command!r}",
            ).model_dump_json()
    except Exception as exc:  # noqa: BLE001
        logger.exception("Command %r failed", request.command)
        return LLMResponseErr(id=request.id, error=str(exc)).model_dump_json()


def serve() -> None:
    """Read requests from stdin line by line, write responses to stdout."""
    logger.info("MLX-LLM sidecar ready — waiting for requests on stdin.")

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        response = _handle(line)
        sys.stdout.write(response + "\n")
        sys.stdout.flush()

    logger.info("stdin closed — exiting.")
