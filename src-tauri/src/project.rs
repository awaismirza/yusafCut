//! Project file I/O.
//!
//! `.scribe` is a folder on disk (presented to the user as a bundle), structured:
//!   MyProject.scribe/
//!   ├── project.json
//!   ├── transcripts/           # raw whisper output per media (future)
//!   └── media-refs.json        # original paths + sha256
//!
//! We write atomically: serialise to `.tmp` then rename.

use crate::edl::Project;
use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use tokio::fs;

const PROJECT_FILE: &str = "project.json";

pub async fn save(project: &Project, path: &Path) -> Result<()> {
    fs::create_dir_all(path).await.with_context(|| format!("creating {}", path.display()))?;
    let main = path.join(PROJECT_FILE);
    let tmp = path.join(format!("{}.tmp", PROJECT_FILE));
    let json = serde_json::to_vec_pretty(project)?;
    fs::write(&tmp, json).await.context("writing tmp")?;
    fs::rename(&tmp, &main).await.context("atomic rename")?;
    Ok(())
}

pub async fn load(path: &Path) -> Result<Project> {
    let p: PathBuf = if path.is_dir() {
        path.join(PROJECT_FILE)
    } else {
        path.to_path_buf()
    };
    let raw = fs::read(&p).await.with_context(|| format!("reading {}", p.display()))?;
    let project: Project = serde_json::from_slice(&raw).context("parsing project.json")?;
    Ok(project)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::edl::{ExportPreset, ProjectSettings};
    use std::collections::HashMap;
    use tokio::runtime::Runtime;

    fn sample_project() -> Project {
        Project {
            version: 1,
            id: "abc".into(),
            name: "Sample".into(),
            created_at: "2025-01-01T00:00:00Z".into(),
            updated_at: "2025-01-01T00:00:00Z".into(),
            media: HashMap::new(),
            segments: vec![],
            settings: ProjectSettings {
                export_preset: ExportPreset::Youtube1080p,
                padding_ms: 80,
            },
            chapters: vec![],
        }
    }

    #[test]
    fn round_trip_via_tempdir() {
        let rt = Runtime::new().unwrap();
        rt.block_on(async {
            let dir = std::env::temp_dir().join(format!("scribe-test-{}", uuid::Uuid::new_v4()));
            let bundle = dir.join("Test.scribe");
            let p = sample_project();
            save(&p, &bundle).await.unwrap();
            let loaded = load(&bundle).await.unwrap();
            assert_eq!(p.id, loaded.id);
            assert_eq!(p.name, loaded.name);
            tokio::fs::remove_dir_all(&dir).await.ok();
        });
    }
}
