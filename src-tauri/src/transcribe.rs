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
            words.push(Word {
                id: Uuid::new_v4().to_string(),
                text,
                start: ms_to_sec(seg.offsets.from + tok.offsets.from),
                end: ms_to_sec(seg.offsets.from + tok.offsets.to),
                confidence: tok.p.clamp(0.0, 1.0),
                speaker: None,
            });
        }
    }
    Ok(words)
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
        // Segment offsets are absolute; token offsets are relative to the segment.
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
