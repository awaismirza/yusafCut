"""Pydantic request / response schemas for the MLX-LLM sidecar JSON-line protocol.

Every message is a single JSON object on one line.

Request
-------
{
  "id":      "uuid-v4",           // echoed in the response for correlation
  "command": "summarise" | "broll",
  "payload": { ... }              // command-specific data (see below)
}

Summarise payload
-----------------
{
  "transcript": "Full transcript text …",
  "n_chapters": 10,               // desired number of chapters (default 10)
  "model":      "mlx-community/Llama-3.2-3B-Instruct-4bit"   // optional override
}

B-roll payload
--------------
{
  "transcript":      "Span of transcript text ~30 s …",
  "start_seconds":   0.0,         // output-timeline start of the span
  "end_seconds":     30.0,        // output-timeline end of the span
  "n_suggestions":   3,           // how many b-roll ideas to return (default 3)
  "model":           "mlx-community/Llama-3.2-3B-Instruct-4bit"
}

Response
--------
{
  "id":     "uuid-v4",
  "ok":     true,
  "result": { ... }               // command-specific result
}

Error response
--------------
{
  "id":    "uuid-v4",
  "ok":    false,
  "error": "human-readable error message"
}

Chapter result
--------------
{
  "chapters": [
    { "title": "Introduction", "start_seconds": 0.0 },
    { "title": "Topic A",      "start_seconds": 142.5 },
    …
  ]
}

B-roll result
-------------
{
  "suggestions": [
    {
      "query":          "developer typing code on laptop",
      "start_seconds":  0.0,
      "end_seconds":    30.0,
      "rationale":      "Visually reinforces the programming topic being discussed."
    },
    …
  ]
}
"""

from __future__ import annotations

from typing import Any, Literal, Union

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Requests
# ---------------------------------------------------------------------------

class SummarisePayload(BaseModel):
    transcript: str
    n_chapters: int = Field(default=10, ge=1, le=30)
    model: str = "mlx-community/Llama-3.2-3B-Instruct-4bit"


class BrollPayload(BaseModel):
    transcript: str
    start_seconds: float = 0.0
    end_seconds: float = 30.0
    n_suggestions: int = Field(default=3, ge=1, le=10)
    model: str = "mlx-community/Llama-3.2-3B-Instruct-4bit"


class LLMRequest(BaseModel):
    id: str
    command: Literal["summarise", "broll"]
    payload: Union[SummarisePayload, BrollPayload]

    model_config = {"arbitrary_types_allowed": True}


# ---------------------------------------------------------------------------
# Responses
# ---------------------------------------------------------------------------

class ChapterMarker(BaseModel):
    title: str
    start_seconds: float


class SummariseResult(BaseModel):
    chapters: list[ChapterMarker]


class BrollSuggestion(BaseModel):
    """A single b-roll suggestion for a span of the timeline."""
    query: str
    """Stock footage / Unsplash search query, 4–8 words."""
    start_seconds: float
    end_seconds: float
    rationale: str = ""
    """One sentence explaining why this shot suits the content."""


class BrollResult(BaseModel):
    suggestions: list[BrollSuggestion]


class LLMResponseOk(BaseModel):
    id: str
    ok: Literal[True] = True
    result: Union[SummariseResult, BrollResult]


class LLMResponseErr(BaseModel):
    id: str
    ok: Literal[False] = False
    error: str


LLMResponse = LLMResponseOk | LLMResponseErr
