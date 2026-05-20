"""Unit tests for mlx_llm.server — the JSON-line protocol layer."""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest

from mlx_llm.server import _handle
from mlx_llm.schemas import ChapterMarker, SummariseResult


VALID_REQUEST = {
    "id": "req-001",
    "command": "summarise",
    "payload": {
        "transcript": "Hello world. [30.0] More content here.",
        "n_chapters": 2,
        "model": "mlx-community/Llama-3.2-3B-Instruct-4bit",
    },
}

FAKE_RESULT = SummariseResult(chapters=[
    ChapterMarker(title="Introduction", start_seconds=0.0),
    ChapterMarker(title="Main Topic",   start_seconds=30.0),
])


class TestHandle:
    def test_returns_ok_response_on_success(self):
        with patch("mlx_llm.server.summarise", return_value=FAKE_RESULT):
            raw = _handle(json.dumps(VALID_REQUEST))
        resp = json.loads(raw)
        assert resp["ok"] is True
        assert resp["id"] == "req-001"
        assert len(resp["result"]["chapters"]) == 2

    def test_returns_error_on_malformed_json(self):
        raw = _handle("{not valid json")
        resp = json.loads(raw)
        assert resp["ok"] is False
        assert resp["id"] == "unknown"
        assert "error" in resp

    def test_returns_error_on_missing_fields(self):
        bad = {"id": "req-002", "command": "summarise"}  # no payload
        raw = _handle(json.dumps(bad))
        resp = json.loads(raw)
        assert resp["ok"] is False
        assert resp["id"] == "req-002"

    def test_returns_error_on_unknown_command(self):
        req = {**VALID_REQUEST, "command": "fly_to_moon"}
        raw = _handle(json.dumps(req))
        resp = json.loads(raw)
        assert resp["ok"] is False
        assert "Unknown command" in resp["error"]

    def test_returns_error_when_summarise_raises(self):
        with patch("mlx_llm.server.summarise", side_effect=RuntimeError("OOM")):
            raw = _handle(json.dumps(VALID_REQUEST))
        resp = json.loads(raw)
        assert resp["ok"] is False
        assert "OOM" in resp["error"]

    def test_echoes_request_id(self):
        with patch("mlx_llm.server.summarise", return_value=FAKE_RESULT):
            raw = _handle(json.dumps({**VALID_REQUEST, "id": "my-custom-id"}))
        resp = json.loads(raw)
        assert resp["id"] == "my-custom-id"

    def test_response_is_single_line(self):
        with patch("mlx_llm.server.summarise", return_value=FAKE_RESULT):
            raw = _handle(json.dumps(VALID_REQUEST))
        # Must be parseable as a single JSON object with no embedded newlines.
        assert "\n" not in raw
        json.loads(raw)  # must not raise
