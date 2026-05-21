//! Transcription engine parsers.
//!
//! The actual binary invocations are in `commands::transcribe`. This module
//! contains pure JSON parsers for whisper.cpp `--output-json-full` format.
//!
//! WhisperKit was removed in v3.2.0 — restore from commit 4726d25 if needed.
//!
//! `parse_whisper_json` is exposed as a pure function so it can be unit-tested
//! without spawning any binary.

use crate::edl::Word;
use anyhow::{Context, Result};
use serde::Deserialize;
use uuid::Uuid;

#[derive(Debug, Deserialize)]
struct WhisperJson {
    transcription: Vec<WhisperSegment>,
}

#[derive(Debug, Deserialize)]
struct WhisperSegment {
    #[allow(dead_code)]
    text: String,
    offsets: WhisperOffsets,
    tokens: Vec<WhisperToken>,
}

#[derive(Debug, Deserialize)]
struct WhisperOffsets {
    from: u64,
    #[allow(dead_code)]
    to: u64,
}

#[derive(Debug, Deserialize)]
struct WhisperToken {
    text: String,
    offsets: WhisperOffsets,
    p: f64, // probability
}

/// Parse whisper.cpp's full JSON output into our `Word` list, dropping pure
/// whitespace/punctuation artefacts.
pub fn parse_whisper_json(json: &str) -> Result<Vec<Word>> {
    let parsed: WhisperJson = serde_json::from_str(json).context("invalid whisper JSON")?;
    let mut words = Vec::new();
    for seg in parsed.transcription {
        for tok in seg.tokens {
            let text = tok.text.trim().to_string();
            // Skip Whisper special tokens like <|startoftranscript|>, [BLANK_AUDIO], etc.
            if text.is_empty() || text.starts_with("<|") || text.starts_with('[') {
                continue;
            }
            // Skip leading-only-punctuation tokens — whisper emits these as separate atoms.
            if text.chars().all(|c| !c.is_alphanumeric()) {
                continue;
            }
            let (start_ms, end_ms) = token_offsets_ms(&seg.offsets, &tok.offsets);
            words.push(Word {
                id: Uuid::new_v4().to_string(),
                text,
                start: ms_to_sec(start_ms),
                end: ms_to_sec(end_ms),
                confidence: tok.p.clamp(0.0, 1.0),
                speaker: None,
            });
        }
    }
    Ok(words)
}

fn token_offsets_ms(seg: &WhisperOffsets, tok: &WhisperOffsets) -> (u64, u64) {
    // whisper.cpp `--output-json-full` (post-~1.5.0) emits token t0/t1 as
    // *absolute* millisecond offsets in the source audio timeline.
    //
    // Some older/alternative builds emit token offsets *relative* to the
    // segment start instead. We distinguish the two forms by checking whether
    // the token range is plausibly contained within the segment range:
    //
    //   absolute  → tok.from ∈ [seg.from, seg.to]  (or at least tok.from >= seg.from)
    //   relative  → tok.from is small (< seg.from), add seg.from to both
    //
    // Edge case: when seg.from == 0 both interpretations look identical.
    // In that case we trust the token offsets directly (absolute), because
    // the segment-relative form would produce the same values anyway.
    //
    // We also guard against tokens whose `to` accidentally undershoots `from`
    // (corrupted JSON): clamp `to` to at least `from + 1 ms` so the editor
    // never shows a zero-duration word.
    let (start, end) = if seg.from == 0 || tok.from >= seg.from {
        // Absolute offsets — use directly.
        (tok.from, tok.to)
    } else {
        // Relative offsets — add segment start.
        (seg.from + tok.from, seg.from + tok.to)
    };

    // Safety clamp: ensure end > start (a zero-width word causes visual glitches).
    let end = end.max(start + 1);
    (start, end)
}

fn ms_to_sec(ms: u64) -> f64 {
    ms as f64 / 1000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_minimal_whisper_output() {
        // whisper.cpp emits `offsets.from`/`offsets.to` in milliseconds.
        // This fixture matches older wrappers where token offsets are relative
        // to the segment start.
        let json = r#"{
            "transcription": [
              {
                "text": " hello world",
                "offsets": {"from": 0, "to": 1500},
                "tokens": [
                  {"text": " hello", "offsets": {"from": 0, "to": 500}, "p": 0.99},
                  {"text": " world", "offsets": {"from": 600, "to": 1100}, "p": 0.95}
                ]
              }
            ]
        }"#;
        let words = parse_whisper_json(json).unwrap();
        assert_eq!(words.len(), 2);
        assert_eq!(words[0].text, "hello");
        assert!((words[0].start - 0.0).abs() < 1e-9);
        assert!((words[0].end - 0.5).abs() < 1e-9);
        assert_eq!(words[1].text, "world");
        assert!((words[1].start - 0.6).abs() < 1e-9);
        assert!((words[1].confidence - 0.95).abs() < 1e-9);
    }

    #[test]
    fn parses_absolute_token_offsets_without_doubling_segment_start() {
        // Current whisper.cpp writes token offsets from token.t0/t1, which are
        // already absolute in the source audio timeline.
        let json = r#"{
            "transcription": [
              {
                "text": " later words",
                "offsets": {"from": 30000, "to": 32000},
                "tokens": [
                  {"text": " later", "offsets": {"from": 30100, "to": 30500}, "p": 0.99},
                  {"text": " words", "offsets": {"from": 30600, "to": 31100}, "p": 0.95}
                ]
              }
            ]
        }"#;
        let words = parse_whisper_json(json).unwrap();
        assert_eq!(words.len(), 2);
        assert_eq!(words[0].text, "later");
        assert!((words[0].start - 30.1).abs() < 1e-9);
        assert!((words[0].end - 30.5).abs() < 1e-9);
        assert_eq!(words[1].text, "words");
        assert!((words[1].start - 30.6).abs() < 1e-9);
    }

    #[test]
    fn drops_special_and_punctuation_tokens() {
        let json = r#"{
            "transcription": [
              {
                "text": "[MUSIC] hi.",
                "offsets": {"from": 0, "to": 1000},
                "tokens": [
                  {"text": "<|startoftranscript|>", "offsets":{"from":0,"to":0}, "p":1.0},
                  {"text": "[MUSIC]", "offsets":{"from":0,"to":100}, "p":1.0},
                  {"text": " hi", "offsets":{"from":100,"to":500}, "p":0.9},
                  {"text": ".", "offsets":{"from":500,"to":600}, "p":1.0}
                ]
              }
            ]
        }"#;
        let words = parse_whisper_json(json).unwrap();
        assert_eq!(words.len(), 1);
        assert_eq!(words[0].text, "hi");
    }
}
