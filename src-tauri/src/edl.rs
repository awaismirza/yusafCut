//! Rust mirror of the EDL types. Serialised identically to the TypeScript side
//! so projects round-trip without loss.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub type MediaId = String;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceMedia {
    pub id: MediaId,
    pub path: String,
    pub duration: f64,
    pub fps: f64,
    pub width: u32,
    pub height: u32,
    #[serde(rename = "audioSampleRate")]
    pub audio_sample_rate: u32,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Word {
    pub id: String,
    pub text: String,
    pub start: f64,
    pub end: f64,
    pub confidence: f64,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub speaker: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Segment {
    pub id: String,
    #[serde(rename = "mediaId")]
    pub media_id: MediaId,
    pub words: Vec<Word>,
    #[serde(rename = "sourceIn")]
    pub source_in: f64,
    #[serde(rename = "sourceOut")]
    pub source_out: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ExportPreset {
    #[serde(rename = "youtube-1080p")]
    Youtube1080p,
    #[serde(rename = "podcast-audio")]
    PodcastAudio,
    Custom,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectSettings {
    #[serde(rename = "exportPreset")]
    pub export_preset: ExportPreset,
    #[serde(rename = "paddingMs")]
    pub padding_ms: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub version: u32,
    pub id: String,
    pub name: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    pub media: HashMap<MediaId, SourceMedia>,
    pub segments: Vec<Segment>,
    pub settings: ProjectSettings,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_empty_project() {
        let p = Project {
            version: 1,
            id: "abc".into(),
            name: "Test".into(),
            created_at: "2025-01-01T00:00:00Z".into(),
            updated_at: "2025-01-01T00:00:00Z".into(),
            media: HashMap::new(),
            segments: vec![],
            settings: ProjectSettings {
                export_preset: ExportPreset::Youtube1080p,
                padding_ms: 80,
            },
        };
        let json = serde_json::to_string(&p).unwrap();
        let back: Project = serde_json::from_str(&json).unwrap();
        assert_eq!(p.id, back.id);
        assert_eq!(p.settings.padding_ms, back.settings.padding_ms);
    }

    #[test]
    fn deserialise_typescript_shape() {
        // This exercises that camelCase field names match the frontend.
        let json = r#"{
            "version": 1,
            "id": "p",
            "name": "n",
            "createdAt": "2025-01-01T00:00:00Z",
            "updatedAt": "2025-01-01T00:00:00Z",
            "media": {},
            "segments": [
              {
                "id": "s",
                "mediaId": "m",
                "words": [
                  {"id":"w","text":"hi","start":0,"end":0.5,"confidence":0.9}
                ],
                "sourceIn": 0,
                "sourceOut": 5
              }
            ],
            "settings": { "exportPreset": "youtube-1080p", "paddingMs": 80 }
        }"#;
        let p: Project = serde_json::from_str(json).unwrap();
        assert_eq!(p.segments.len(), 1);
        assert_eq!(p.segments[0].words[0].text, "hi");
        assert_eq!(p.settings.export_preset, ExportPreset::Youtube1080p);
    }
}
