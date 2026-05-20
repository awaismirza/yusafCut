"""Implementations of the commands exposed by the sidecar.

Commands:
  summarise  — generate chapter titles with timestamps from a transcript.
  broll      — suggest b-roll search queries for a transcript span.
"""

from __future__ import annotations

import json
import logging
import re
import textwrap

from .schemas import (
    BrollPayload,
    BrollResult,
    BrollSuggestion,
    ChapterMarker,
    SummarisePayload,
    SummariseResult,
)

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Model cache — we keep the loaded model + tokenizer alive between calls so
# the sidecar doesn't reload weights on every request.
# ---------------------------------------------------------------------------

_cache: dict[str, object] = {}


def _load_model(model_name: str):
    """Load (or return cached) MLX model + tokenizer."""
    if model_name not in _cache:
        logger.info("Loading model %s …", model_name)
        # Import here so the module is importable even when mlx-lm is absent
        # (e.g. during unit tests with mocked generate).
        from mlx_lm import load  # type: ignore[import]

        model, tokenizer = load(model_name)
        _cache[model_name] = (model, tokenizer)
        logger.info("Model %s loaded.", model_name)

    return _cache[model_name]  # type: ignore[return-value]


# ---------------------------------------------------------------------------
# Summarise
# ---------------------------------------------------------------------------

_SYSTEM_PROMPT = textwrap.dedent("""\
    You are a video editor assistant. Given a transcript, produce chapter
    markers. Each chapter should have a descriptive title and a start time
    in seconds taken verbatim from the transcript timestamps.

    Reply ONLY with a JSON array — no prose, no markdown fences — of objects:
    [{"title": "...", "start_seconds": 0.0}, ...]

    Rules:
    - Produce exactly {n} chapters.
    - The first chapter MUST start at 0.0.
    - Titles should be concise (3–7 words), specific, and informative.
    - Distribute chapters roughly evenly over the full duration.
""")

_USER_PROMPT_TEMPLATE = textwrap.dedent("""\
    Transcript (word-level timestamps in [SS.s] format):

    {transcript}

    Produce {n} chapter markers as a JSON array.
""")


def _build_prompt(transcript: str, n: int) -> str:
    """Build the chat messages list for mlx_lm.generate."""
    return [
        {"role": "system", "content": _SYSTEM_PROMPT.format(n=n)},
        {"role": "user", "content": _USER_PROMPT_TEMPLATE.format(
            transcript=transcript, n=n
        )},
    ]


def _parse_chapters(text: str, n_chapters: int) -> list[ChapterMarker]:
    """Extract chapter markers from the raw LLM output.

    Handles:
      - Clean JSON arrays.
      - JSON embedded inside markdown fences (```json … ```).
      - Partial JSON that can be recovered.
    """
    # Strip markdown fences if present.
    text = re.sub(r"```(?:json)?\s*", "", text).strip()

    # Find the first '[' … ']' block.
    start = text.find("[")
    end = text.rfind("]")
    if start != -1 and end != -1 and end > start:
        text = text[start : end + 1]

    try:
        raw = json.loads(text)
    except json.JSONDecodeError as exc:
        logger.warning("JSON parse failed (%s); attempting recovery.", exc)
        # Try to collect whatever valid objects we can from a truncated array.
        raw = _recover_partial_json(text)

    chapters = []
    for item in raw[:n_chapters]:
        try:
            chapters.append(
                ChapterMarker(
                    title=str(item.get("title", "Chapter")).strip(),
                    start_seconds=float(item.get("start_seconds", 0.0)),
                )
            )
        except (TypeError, ValueError) as exc:
            logger.debug("Skipping malformed chapter item %r: %s", item, exc)

    # Always ensure chapter 0 starts at 0.
    if chapters and chapters[0].start_seconds != 0.0:
        chapters.insert(0, ChapterMarker(title="Introduction", start_seconds=0.0))

    return chapters[:n_chapters]


def _recover_partial_json(text: str) -> list[dict]:
    """Best-effort recovery of a truncated JSON array by extracting complete objects."""
    objects = []
    # Each object should match {"title": "...", "start_seconds": N}
    pattern = re.compile(
        r'\{\s*"title"\s*:\s*"([^"\\]*)"\s*,\s*"start_seconds"\s*:\s*([\d.]+)\s*\}',
        re.DOTALL,
    )
    for m in pattern.finditer(text):
        objects.append({"title": m.group(1), "start_seconds": float(m.group(2))})
    return objects


def summarise(payload: SummarisePayload) -> SummariseResult:
    """Run the chapter-detection prompt against the local MLX model.

    Parameters
    ----------
    payload:
        The validated ``SummarisePayload`` from the frontend.

    Returns
    -------
    SummariseResult
        A list of chapter markers with titles and start times.
    """
    model, tokenizer = _load_model(payload.model)

    messages = _build_prompt(payload.transcript, payload.n_chapters)

    # Apply the tokenizer's chat template if available.
    if hasattr(tokenizer, "apply_chat_template"):
        prompt = tokenizer.apply_chat_template(
            messages,
            add_generation_prompt=True,
            tokenize=False,
        )
    else:
        # Fallback: naive concatenation for models without a chat template.
        prompt = "\n".join(
            f"<|{m['role']}|>\n{m['content']}" for m in messages
        ) + "\n<|assistant|>\n"

    from mlx_lm import generate  # type: ignore[import]

    logger.info(
        "Generating %d chapters for transcript of length %d chars …",
        payload.n_chapters,
        len(payload.transcript),
    )

    # Cap output tokens — a JSON array of 30 chapters is well under 2 048 tokens.
    response_text = generate(
        model,
        tokenizer,
        prompt=prompt,
        max_tokens=2048,
        verbose=False,
    )

    logger.debug("Raw LLM output: %r", response_text[:500])

    chapters = _parse_chapters(response_text, payload.n_chapters)

    logger.info("Detected %d chapters.", len(chapters))

    return SummariseResult(chapters=chapters)


# ---------------------------------------------------------------------------
# B-roll suggestions
# ---------------------------------------------------------------------------

_BROLL_SYSTEM = textwrap.dedent("""\
    You are a video editor assistant. Given a short transcript excerpt, suggest
    b-roll footage ideas that would visually complement the spoken content.

    Reply ONLY with a JSON array — no prose, no markdown fences:
    [
      {
        "query":      "stock footage search query (4-8 words)",
        "rationale":  "one sentence: why this shot suits the content"
      },
      …
    ]

    Rules:
    - Produce exactly {n} suggestions.
    - Queries must be concrete and searchable (e.g. "developer typing code laptop coffee shop").
    - Avoid generic queries like "person working" — be specific to the topic.
    - Rationale must reference something said in the transcript.
""")

_BROLL_USER = textwrap.dedent("""\
    Transcript excerpt ({start:.1f}s – {end:.1f}s):

    {transcript}

    Suggest {n} b-roll shots as a JSON array.
""")


def _parse_broll(text: str, n: int, start: float, end: float) -> list[BrollSuggestion]:
    """Extract b-roll suggestions from raw LLM output."""
    text = re.sub(r"```(?:json)?\s*", "", text).strip()
    s = text.find("[")
    e = text.rfind("]")
    if s != -1 and e != -1 and e > s:
        text = text[s: e + 1]

    try:
        raw = json.loads(text)
    except json.JSONDecodeError:
        pattern = re.compile(
            r'\{\s*"query"\s*:\s*"([^"\\]*)"\s*(?:,\s*"rationale"\s*:\s*"([^"\\]*)"\s*)?\}',
            re.DOTALL,
        )
        raw = [
            {"query": m.group(1), "rationale": m.group(2) or ""}
            for m in pattern.finditer(text)
        ]

    suggestions = []
    for item in raw[:n]:
        try:
            suggestions.append(
                BrollSuggestion(
                    query=str(item.get("query", "")).strip(),
                    start_seconds=start,
                    end_seconds=end,
                    rationale=str(item.get("rationale", "")).strip(),
                )
            )
        except (TypeError, ValueError) as exc:
            logger.debug("Skipping malformed b-roll item %r: %s", item, exc)

    return suggestions[:n]


def broll(payload: BrollPayload) -> BrollResult:
    """Generate b-roll search suggestions for a transcript span.

    Parameters
    ----------
    payload:
        Validated ``BrollPayload`` from the frontend.

    Returns
    -------
    BrollResult
        A list of b-roll suggestions with search queries and rationales.
    """
    model, tokenizer = _load_model(payload.model)

    messages = [
        {
            "role": "system",
            "content": _BROLL_SYSTEM.format(n=payload.n_suggestions),
        },
        {
            "role": "user",
            "content": _BROLL_USER.format(
                start=payload.start_seconds,
                end=payload.end_seconds,
                transcript=payload.transcript,
                n=payload.n_suggestions,
            ),
        },
    ]

    if hasattr(tokenizer, "apply_chat_template"):
        prompt = tokenizer.apply_chat_template(
            messages, add_generation_prompt=True, tokenize=False
        )
    else:
        prompt = "\n".join(
            f"<|{m['role']}|>\n{m['content']}" for m in messages
        ) + "\n<|assistant|>\n"

    from mlx_lm import generate  # type: ignore[import]

    logger.info(
        "Generating %d b-roll suggestions for span %.1f–%.1f s …",
        payload.n_suggestions,
        payload.start_seconds,
        payload.end_seconds,
    )

    response_text = generate(
        model,
        tokenizer,
        prompt=prompt,
        max_tokens=1024,
        verbose=False,
    )

    logger.debug("Raw b-roll output: %r", response_text[:400])

    suggestions = _parse_broll(
        response_text, payload.n_suggestions, payload.start_seconds, payload.end_seconds
    )

    logger.info("Generated %d b-roll suggestions.", len(suggestions))
    return BrollResult(suggestions=suggestions)
