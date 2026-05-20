//! Project snapshots — named restore points stored inside a project bundle.
//!
//! Today undo is a 50-step ring buffer in the frontend; once you reload the
//! app or open a different file, the history is gone. For commercial use we
//! want **named restore points** so an editor can pin "Snapshot v3 — before
//! client edits" and come back to it days later.
//!
//! On disk a `.scribe` bundle gains a `snapshots/` directory:
//!
//! ```text
//! MyProject.scribe/
//! ├── project.json
//! ├── transcripts/
//! ├── snapshots/
//! │   ├── 2026-05-20T15-04-12_2bdb…_index.json
//! │   ├── 2026-05-20T15-04-12_2bdb….json.gz
//! │   └── 2026-05-20T16-12-44_8a9f….json.gz
//! ```
//!
//! Each snapshot is two files: a small JSON index (id, label, createdAt) and
//! a gzip-compressed copy of the full project JSON at that point in time.
//! The project itself is tiny so gzip is overkill technically; we use it
//! anyway so a 50-snapshot bundle stays in the low MBs.

use crate::edl::Project;
use anyhow::{Context, Result};
use flate2::{Compression, read::GzDecoder, write::GzEncoder};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tokio::fs;
use uuid::Uuid;

/// On-disk index for a single snapshot — kept separate from the (compressed)
/// body so `list_snapshots` doesn't have to decompress everything.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotIndex {
    pub id: String,
    pub label: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    /// Total duration of the snapshotted output timeline, in seconds. Useful
    /// for showing "1:23:04" next to the entry in the restore-list UI.
    #[serde(rename = "durationSec")]
    pub duration_sec: f64,
    /// Number of segments at snapshot time. A weak proxy for "how big" the
    /// edit was, used to badge entries in the UI.
    pub segments: usize,
}

fn snapshots_dir(bundle: &Path) -> PathBuf {
    bundle.join("snapshots")
}

fn index_path(bundle: &Path, id: &str, ts: &str) -> PathBuf {
    snapshots_dir(bundle).join(format!("{ts}_{id}_index.json"))
}

fn body_path(bundle: &Path, id: &str, ts: &str) -> PathBuf {
    snapshots_dir(bundle).join(format!("{ts}_{id}.json.gz"))
}

/// Write a new snapshot. Returns the snapshot index that was written.
pub async fn create(bundle: &Path, project: &Project, label: &str) -> Result<SnapshotIndex> {
    let id = Uuid::new_v4().to_string();
    let now = chrono::Utc::now();
    // ISO 8601 minus colons (filesystem-safe), keeps lexicographic == time order.
    let ts = now.format("%Y-%m-%dT%H-%M-%S").to_string();

    let total_duration: f64 = project
        .segments
        .iter()
        .map(|s| (s.source_out - s.source_in).max(0.0))
        .sum();
    let segments = project.segments.len();

    let dir = snapshots_dir(bundle);
    fs::create_dir_all(&dir).await.context("creating snapshots dir")?;

    // gzip-compress the project json
    let json = serde_json::to_vec_pretty(project)?;
    let body = gzip_compress(&json)?;
    let body_p = body_path(bundle, &id, &ts);
    fs::write(&body_p, body).await.context("writing snapshot body")?;

    let label = if label.trim().is_empty() {
        format!("Snapshot {}", now.format("%Y-%m-%d %H:%M"))
    } else {
        label.trim().to_string()
    };

    let index = SnapshotIndex {
        id: id.clone(),
        label,
        created_at: now.to_rfc3339(),
        duration_sec: total_duration,
        segments,
    };
    let idx_p = index_path(bundle, &id, &ts);
    let idx_json = serde_json::to_vec_pretty(&index)?;
    fs::write(&idx_p, idx_json).await.context("writing snapshot index")?;

    Ok(index)
}

/// Read every snapshot index in the bundle, sorted newest-first.
pub async fn list(bundle: &Path) -> Result<Vec<SnapshotIndex>> {
    let dir = snapshots_dir(bundle);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut entries = fs::read_dir(&dir).await?;
    let mut out: Vec<SnapshotIndex> = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
        if !name.ends_with("_index.json") {
            continue;
        }
        let raw = match fs::read(&path).await {
            Ok(r) => r,
            Err(_) => continue,
        };
        match serde_json::from_slice::<SnapshotIndex>(&raw) {
            Ok(idx) => out.push(idx),
            Err(err) => log::warn!("skipping bad snapshot index {}: {err}", path.display()),
        }
    }
    // Newest first
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(out)
}

/// Load a snapshot's project body by id. Returns the decompressed Project.
pub async fn restore(bundle: &Path, id: &str) -> Result<Project> {
    let body = find_body(bundle, id).await?;
    let json = gzip_decompress(&body)?;
    let project: Project = serde_json::from_slice(&json).context("parsing snapshot body")?;
    Ok(project)
}

/// Delete a snapshot's index + body. Missing files are silently ignored —
/// this is a "clean up best-effort" operation.
pub async fn delete(bundle: &Path, id: &str) -> Result<()> {
    let dir = snapshots_dir(bundle);
    if !dir.exists() {
        return Ok(());
    }
    let mut entries = fs::read_dir(&dir).await?;
    while let Some(entry) = entries.next_entry().await? {
        let p = entry.path();
        let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
        if name.contains(id) {
            let _ = fs::remove_file(&p).await;
        }
    }
    Ok(())
}

async fn find_body(bundle: &Path, id: &str) -> Result<Vec<u8>> {
    let dir = snapshots_dir(bundle);
    let mut entries = fs::read_dir(&dir).await?;
    while let Some(entry) = entries.next_entry().await? {
        let p = entry.path();
        let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
        if name.contains(id) && name.ends_with(".json.gz") {
            return Ok(fs::read(&p).await?);
        }
    }
    anyhow::bail!("snapshot not found: {id}")
}

fn gzip_compress(input: &[u8]) -> Result<Vec<u8>> {
    let mut enc = GzEncoder::new(Vec::new(), Compression::default());
    enc.write_all(input)?;
    Ok(enc.finish()?)
}

fn gzip_decompress(input: &[u8]) -> Result<Vec<u8>> {
    let mut dec = GzDecoder::new(input);
    let mut out = Vec::new();
    dec.read_to_end(&mut out)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::edl::{ExportPreset, Project, ProjectSettings};
    use std::collections::HashMap;

    fn sample() -> Project {
        Project {
            version: 1,
            id: "p".into(),
            name: "n".into(),
            created_at: "x".into(),
            updated_at: "x".into(),
            media: HashMap::new(),
            segments: vec![],
            settings: ProjectSettings {
                export_preset: ExportPreset::Youtube1080p,
                padding_ms: 80,
            },
            chapters: vec![],
            audio_tracks: vec![],
        }
    }

    #[tokio::test]
    async fn round_trip_snapshot() {
        let dir = std::env::temp_dir().join(format!("scribe-snap-{}", Uuid::new_v4()));
        let bundle = dir.join("Test.scribe");
        fs::create_dir_all(&bundle).await.unwrap();

        let project = sample();
        let idx = create(&bundle, &project, "first").await.unwrap();
        let listed = list(&bundle).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, idx.id);
        assert_eq!(listed[0].label, "first");

        let restored = restore(&bundle, &idx.id).await.unwrap();
        assert_eq!(restored.id, project.id);

        delete(&bundle, &idx.id).await.unwrap();
        assert_eq!(list(&bundle).await.unwrap().len(), 0);

        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn empty_label_falls_back_to_timestamp() {
        let dir = std::env::temp_dir().join(format!("scribe-snap-{}", Uuid::new_v4()));
        let bundle = dir.join("Test.scribe");
        fs::create_dir_all(&bundle).await.unwrap();
        let idx = create(&bundle, &sample(), "   ").await.unwrap();
        assert!(idx.label.starts_with("Snapshot "));
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }
}
