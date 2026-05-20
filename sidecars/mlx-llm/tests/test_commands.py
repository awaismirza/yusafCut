"""Unit tests for mlx_llm.commands — no real MLX model required.

We patch `mlx_lm.load` and `mlx_lm.generate` so the tests run on any machine
(CI included) without downloading multi-GB model weights.
"""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest

from mlx_llm.commands import _parse_chapters, _recover_partial_json, summarise
from mlx_llm.schemas import SummarisePayload


# ---------------------------------------------------------------------------
# _recover_partial_json
# ---------------------------------------------------------------------------

class TestRecoverPartialJson:
    def test_extracts_complete_objects(self):
        text = (
            '[{"title": "Intro", "start_seconds": 0.0},'
            '{"title": "Middle", "start_seconds": 45.5},'
        )  # deliberately truncated — no closing ']'
        result = _recover_partial_json(text)
        assert len(result) == 2
        assert result[0]["title"] == "Intro"
        assert result[1]["start_seconds"] == pytest.approx(45.5)

    def test_empty_string_returns_empty(self):
        assert _recover_partial_json("") == []

    def test_no_matches_returns_empty(self):
        assert _recover_partial_json("some random text") == []


# ---------------------------------------------------------------------------
# _parse_chapters
# ---------------------------------------------------------------------------

class TestParseChapters:
    def test_parses_clean_json(self):
        raw = json.dumps([
            {"title": "Introduction", "start_seconds": 0.0},
            {"title": "Deep Dive",    "start_seconds": 120.0},
        ])
        chapters = _parse_chapters(raw, n_chapters=2)
        assert len(chapters) == 2
        assert chapters[0].title == "Introduction"
        assert chapters[0].start_seconds == pytest.approx(0.0)
        assert chapters[1].title == "Deep Dive"
        assert chapters[1].start_seconds == pytest.approx(120.0)

    def test_strips_markdown_fences(self):
        raw = "```json\n" + json.dumps([
            {"title": "A", "start_seconds": 0.0},
        ]) + "\n```"
        chapters = _parse_chapters(raw, n_chapters=1)
        assert len(chapters) == 1
        assert chapters[0].title == "A"

    def test_inserts_intro_when_first_chapter_nonzero(self):
        raw = json.dumps([
            {"title": "Topic A", "start_seconds": 30.0},
        ])
        chapters = _parse_chapters(raw, n_chapters=1)
        # An "Introduction" at 0.0 should be prepended.
        assert chapters[0].start_seconds == pytest.approx(0.0)

    def test_caps_at_n_chapters(self):
        raw = json.dumps([
            {"title": f"Ch {i}", "start_seconds": float(i * 60)}
            for i in range(20)
        ])
        chapters = _parse_chapters(raw, n_chapters=5)
        assert len(chapters) <= 5

    def test_recovers_truncated_json(self):
        # Simulate the model cutting off mid-array.
        partial = (
            '[{"title": "Intro", "start_seconds": 0.0},'
            '{"title": "Part 2", "start_seconds": 90.0}'
        )  # missing closing ']'
        chapters = _parse_chapters(partial, n_chapters=5)
        assert any(c.title == "Intro" for c in chapters)

    def test_skips_malformed_items(self):
        raw = json.dumps([
            {"title": "Good",  "start_seconds": 0.0},
            {"title": None,    "start_seconds": "not-a-number"},   # bad
            {"title": "Also Good", "start_seconds": 60.0},
        ])
        chapters = _parse_chapters(raw, n_chapters=10)
        titles = [c.title for c in chapters]
        assert "Good" in titles
        assert "Also Good" in titles


# ---------------------------------------------------------------------------
# summarise (integration, mlx mocked)
# ---------------------------------------------------------------------------

FAKE_JSON_RESPONSE = json.dumps([
    {"title": "Introduction",   "start_seconds": 0.0},
    {"title": "Main Points",    "start_seconds": 180.0},
    {"title": "Conclusion",     "start_seconds": 540.0},
])

SAMPLE_TRANSCRIPT = (
    "[0.0] Welcome to the show. [2.5] Today we discuss MLX. "
    "[180.0] The main argument is as follows. [540.0] To wrap up."
)


class TestSummarise:
    """Tests for the summarise() function with mlx_lm mocked out."""

    def _make_payload(self, n=3) -> SummarisePayload:
        return SummarisePayload(
            transcript=SAMPLE_TRANSCRIPT,
            n_chapters=n,
            model="mlx-community/Llama-3.2-3B-Instruct-4bit",
        )

    @patch("mlx_llm.commands.generate", return_value=FAKE_JSON_RESPONSE, create=True)
    @patch("mlx_llm.commands._load_model")
    def test_returns_chapter_markers(self, mock_load, mock_generate):
        mock_tokenizer = MagicMock()
        mock_tokenizer.apply_chat_template.return_value = "prompt"
        mock_load.return_value = (MagicMock(), mock_tokenizer)

        result = summarise(self._make_payload(n=3))

        assert len(result.chapters) == 3
        assert result.chapters[0].start_seconds == pytest.approx(0.0)
        assert result.chapters[1].title == "Main Points"

    @patch("mlx_llm.commands.generate", return_value=FAKE_JSON_RESPONSE, create=True)
    @patch("mlx_llm.commands._load_model")
    def test_calls_load_model_with_correct_name(self, mock_load, _mock_gen):
        mock_tokenizer = MagicMock()
        mock_tokenizer.apply_chat_template.return_value = "prompt"
        mock_load.return_value = (MagicMock(), mock_tokenizer)

        payload = self._make_payload()
        summarise(payload)

        mock_load.assert_called_once_with(payload.model)

    @patch(
        "mlx_llm.commands.generate",
        return_value="not json at all",
        create=True,
    )
    @patch("mlx_llm.commands._load_model")
    def test_gracefully_handles_bad_llm_output(self, mock_load, _mock_gen):
        """Malformed LLM output should yield an empty (or partial) chapter list
        rather than raising an exception."""
        mock_tokenizer = MagicMock()
        mock_tokenizer.apply_chat_template.return_value = "prompt"
        mock_load.return_value = (MagicMock(), mock_tokenizer)

        result = summarise(self._make_payload(n=3))
        # Result must be a valid SummariseResult (possibly empty chapters).
        assert isinstance(result.chapters, list)

    @patch("mlx_llm.commands.generate", return_value=FAKE_JSON_RESPONSE, create=True)
    @patch("mlx_llm.commands._load_model")
    def test_fallback_prompt_when_no_chat_template(self, mock_load, mock_gen):
        """Tokenizers without apply_chat_template should still produce a prompt."""
        mock_tokenizer = MagicMock(spec=[])  # no apply_chat_template attr
        mock_load.return_value = (MagicMock(), mock_tokenizer)

        result = summarise(self._make_payload())
        assert result.chapters  # at least one chapter returned
        # generate() must have been called with a non-empty prompt string.
        _, kwargs = mock_gen.call_args
        assert kwargs.get("prompt") or mock_gen.call_args[0][2]
