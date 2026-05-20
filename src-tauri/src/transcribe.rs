//! Whisper.cpp glue.
//!
//! The actual binary invocation is in `commands::transcribe`. This module
//! contains the JSON parser for whisper.cpp's `--output-json-full` format,
//! exposed as a pure function so it can be unit-tested without spawning the
//! binary.

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
