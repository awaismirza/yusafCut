//! Transcription engine parsers.
//!
//! The actual binary invocations are in `commands::transcribe`. This module
//! contains pure JSON parsers for:
//!   - whisper.cpp `--output-json-full` format  (`parse_whisper_json`)
//!   - WhisperKit JSON output format             (`parse_whisperkit_json`)
//!
//! Both are exposed as pure functions so they can be unit-tested without
//! spawning any binary.

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
    // Current whisper.cpp JSON emits token t0/t1 as absolute audio offsets.
    // Some older/alternate wrappers emit token offsets relative to the segment,
    // so we accept both to avoid either doubled timestamps or zero-based drift.
    if tok.from >= seg.from && tok.to <= seg.to {
        (tok.from, tok.to)
    } else {
        (seg.from + tok.from, seg.from + tok.to)
    }
}

fn ms_to_sec(ms: u64) -> f64 {
    ms as f64 / 1000.0
}

// ---------------------------------------------------------------------------
// WhisperKit output parser
// ---------------------------------------------------------------------------
//
// WhisperKit (argmaxinc/WhisperKit) writes a JSON file whose top-level
// structure is:
//
//   {
//     "text": "...",
//     "segments": [
//       {
//         "id": 0,
//         "seek": 0,
//         "start": 0.0,     ← seconds (float)
//         "end": 3.84,
//         "text": " Hello world",
//         "tokens": [50364, 2425, ...],
//         "tokenLogProbs": [[...], ...],
//         "words": [         ← word-level timestamps (present when --word-timestamps is passed)
//           { "word": " Hello", "start": 0.0, "end": 0.56, "probability": 0.98 },
//           { "word": " world", "start": 0.56, "end": 1.12, "probability": 0.95 }
//         ]
//       }
//     ]
//   }
//
// We prefer the per-word entries when present; fall back to segment-level
// timestamps when word timestamps are absent (older model or short file).

#[derive(Debug, Deserialize)]
struct WhisperKitOutput {
    segments: Vec<WhisperKitSegment>,
}

#[derive(Debug, Deserialize)]
struct WhisperKitSegment {
    start: f64,
    end: f64,
    text: String,
    #[serde(default)]
    words: Vec<WhisperKitWord>,
}

#[derive(Debug, Deserialize)]
struct WhisperKitWord {
    word: String,
    start: f64,
    end: f64,
    probability: f64,
}

/// Parse WhisperKit's JSON output into our `Word` list.
pub fn parse_whisperkit_json(json: &str) -> Result<Vec<Word>> {
    let parsed: WhisperKitOutput =
        serde_json::from_str(json).context("invalid WhisperKit JSON")?;

    let mut words = Vec::new();

    for seg in parsed.segments {
        if seg.words.is_empty() {
            // No word-level timestamps — fall back to one "word" per segment
            // (coarse, but still usable for editing).
            let text = seg.text.trim().to_string();
            if text.is_empty() || text.chars().all(|c| !c.is_alphanumeric()) {
                continue;
            }
            words.push(Word {
                id: Uuid::new_v4().to_string(),
                text,
                start: seg.start,
                end: seg.end,
                confidence: 1.0,
                speaker: None,
            });
        } else {
            for w in seg.words {
                let text = w.word.trim().to_string();
                if text.is_empty() || text.chars().all(|c| !c.is_alphanumeric()) {
                    continue;
                }
                words.push(Word {
                    id: Uuid::new_v4().to_string(),
                    text,
                    start: w.start,
                    end: w.end,
                    confidence: w.probability.clamp(0.0, 1.0),
                    speaker: None,
                });
            }
        }
    }

    Ok(words)
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

    // ── WhisperKit parser tests ──────────────────────────────────────────────

    #[test]
    fn parses_whisperkit_word_level_output() {
        let json = r#"{
            "text": " Hello world",
            "segments": [
              {
                "id": 0,
                "seek": 0,
                "start": 0.0,
                "end": 1.5,
                "text": " Hello world",
                "tokens": [],
                "words": [
                  {"word": " Hello", "start": 0.0, "end": 0.56, "probability": 0.98},
                  {"word": " world", "start": 0.56, "end": 1.12, "probability": 0.95}
                ]
              }
            ]
        }"#;
        let words = parse_whisperkit_json(json).unwrap();
        assert_eq!(words.len(), 2);
        assert_eq!(words[0].text, "Hello");
        assert!((words[0].start - 0.0).abs() < 1e-9);
        assert!((words[0].end - 0.56).abs() < 1e-9);
        assert!((words[0].confidence - 0.98).abs() < 1e-9);
        assert_eq!(words[1].text, "world");
        assert!((words[1].start - 0.56).abs() < 1e-9);
    }

    #[test]
    fn parses_whisperkit_segment_fallback_when_no_words() {
        // When --word-timestamps is not passed, `words` array is absent.
        let json = r#"{
            "text": " Testing fallback",
            "segments": [
              {
                "id": 0,
                "seek": 0,
                "start": 5.0,
                "end": 7.5,
                "text": " Testing fallback",
                "tokens": []
              }
            ]
        }"#;
        let words = parse_whisperkit_json(json).unwrap();
        assert_eq!(words.len(), 1);
        assert_eq!(words[0].text, "Testing fallback");
        assert!((words[0].start - 5.0).abs() < 1e-9);
        assert!((words[0].end - 7.5).abs() < 1e-9);
    }

    #[test]
    fn whisperkit_drops_punctuation_only_words() {
        let json = r#"{
            "text": " Hi.",
            "segments": [
              {
                "id": 0,
                "seek": 0,
                "start": 0.0,
                "end": 1.0,
                "text": " Hi.",
                "tokens": [],
                "words": [
                  {"word": " Hi", "start": 0.0, "end": 0.5, "probability": 0.99},
                  {"word": ".", "start": 0.5, "end": 0.6, "probability": 1.0}
                ]
              }
            ]
        }"#;
        let words = parse_whisperkit_json(json).unwrap();
        assert_eq!(words.len(), 1);
        assert_eq!(words[0].text, "Hi");
    }
}
