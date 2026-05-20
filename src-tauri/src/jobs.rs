//! Background job queue with cancel + persisted progress.
//!
//! A `JobQueue` owns the state of every long-running operation the frontend
//! kicks off — exports, transcriptions, model downloads, snapshots — so the
//! Jobs flyout in the StatusBar can render them as a single list.
//!
//! Three things this gives us that the old one-shot async path did not:
//!
//!   * **Visibility:** every job has a stable id, a kind, a title, a 0..1
//!     progress, an ETA, and a status. The frontend polls `list_jobs` and
//!     subscribes to `jobs:update` events.
//!   * **Cancellation:** every job carries a `CancelToken` (a tokio
//!     `Notify`) that the worker can poll. `cancel_job(id)` flips it.
//!   * **Queueing:** a per-kind FIFO. Kicking off a second export while one
//!     is running enqueues the second; it starts automatically when the
//!     first ends. We use a tokio `Mutex` per kind to serialise.
//!
//! The queue itself is small — the actual work still happens inside the
//! per-command modules (`commands::export`, `commands::transcribe`, etc.).
//! Each of those creates a Job, runs, and reports progress via
//! `Job::set_progress` / `Job::mark_*`.
//!
//! Persistence: the queue snapshot is also written to a small JSON file on
//! every change so an app restart still has the "last 20 jobs" visible
//! (status only — running jobs become "cancelled" on restart since their
//! children are dead).

use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter};
use tokio::sync::{Mutex, Notify, RwLock};
use uuid::Uuid;

/// Maximum number of finished jobs we keep around for display. Older ones are
/// pruned. Running / queued jobs are never pruned.
const MAX_HISTORY: usize = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum JobKind {
    Export,
    Transcribe,
    DownloadModel,
    Snapshot,
}

impl JobKind {
    pub fn slug(self) -> &'static str {
        match self {
            JobKind::Export => "export",
            JobKind::Transcribe => "transcribe",
            JobKind::DownloadModel => "download-model",
            JobKind::Snapshot => "snapshot",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum JobStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

/// Snapshot of a single job, safe to serialise to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobSnapshot {
    pub id: String,
    pub kind: JobKind,
    pub title: String,
    pub status: JobStatus,
    /// 0..1
    pub progress: f64,
    #[serde(rename = "etaSec")]
    pub eta_sec: Option<i64>,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "startedAt")]
    pub started_at: Option<i64>,
    #[serde(rename = "finishedAt")]
    pub finished_at: Option<i64>,
    pub error: Option<String>,
}

#[derive(Debug)]
struct JobInner {
    snapshot: JobSnapshot,
    cancel: Arc<Notify>,
    cancelled: Arc<AtomicBool>,
}

/// A handle the worker uses to report progress on a single job. Cloneable so
/// the work loop can hold it.
#[derive(Clone)]
pub struct JobHandle {
    id: String,
    queue: Arc<JobQueueInner>,
    cancel: Arc<Notify>,
    /// Lock-free flag the worker can poll without going through the RwLock.
    cancelled: Arc<AtomicBool>,
    app: AppHandle,
}

impl JobHandle {
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Returns a `Notify` the worker can `notified().await` to be woken on
    /// cancel. Use `is_cancelled()` from polling code instead if you'd rather
    /// not block.
    pub fn cancel_notify(&self) -> Arc<Notify> {
        self.cancel.clone()
    }

    /// Lock-free, callable from any async context. The flag is set by
    /// `JobQueue::cancel`.
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    pub async fn set_progress(&self, progress: f64, eta_sec: Option<i64>) {
        let mut jobs = self.queue.jobs.write().await;
        if let Some(job) = jobs.get_mut(&self.id) {
            job.snapshot.progress = progress.clamp(0.0, 1.0);
            job.snapshot.eta_sec = eta_sec;
            // Don't move out of Queued; only Running shows progress.
            if job.snapshot.status == JobStatus::Queued && progress > 0.0 {
                job.snapshot.status = JobStatus::Running;
                if job.snapshot.started_at.is_none() {
                    job.snapshot.started_at = Some(Utc::now().timestamp_millis());
                }
            }
        }
        drop(jobs);
        self.queue.emit(&self.app).await;
    }

    pub async fn mark_running(&self) {
        let mut jobs = self.queue.jobs.write().await;
        if let Some(job) = jobs.get_mut(&self.id) {
            if job.snapshot.status == JobStatus::Queued {
                job.snapshot.status = JobStatus::Running;
                job.snapshot.started_at = Some(Utc::now().timestamp_millis());
            }
        }
        drop(jobs);
        self.queue.emit(&self.app).await;
    }

    pub async fn mark_completed(&self) {
        let mut jobs = self.queue.jobs.write().await;
        if let Some(job) = jobs.get_mut(&self.id) {
            job.snapshot.status = JobStatus::Completed;
            job.snapshot.progress = 1.0;
            job.snapshot.eta_sec = Some(0);
            job.snapshot.finished_at = Some(Utc::now().timestamp_millis());
        }
        drop(jobs);
        self.queue.prune_and_emit(&self.app).await;
    }

    pub async fn mark_failed(&self, error: impl Into<String>) {
        let mut jobs = self.queue.jobs.write().await;
        if let Some(job) = jobs.get_mut(&self.id) {
            job.snapshot.status = JobStatus::Failed;
            job.snapshot.error = Some(error.into());
            job.snapshot.finished_at = Some(Utc::now().timestamp_millis());
        }
        drop(jobs);
        self.queue.prune_and_emit(&self.app).await;
    }

    pub async fn mark_cancelled(&self) {
        let mut jobs = self.queue.jobs.write().await;
        if let Some(job) = jobs.get_mut(&self.id) {
            job.snapshot.status = JobStatus::Cancelled;
            job.snapshot.finished_at = Some(Utc::now().timestamp_millis());
        }
        drop(jobs);
        self.queue.prune_and_emit(&self.app).await;
    }
}

#[derive(Debug, Default)]
struct JobQueueInner {
    jobs: RwLock<HashMap<String, JobInner>>,
    /// Insertion order for stable rendering.
    order: RwLock<VecDeque<String>>,
    /// Per-kind lock — only one job per kind runs at once.
    locks: Mutex<HashMap<JobKind, Arc<Mutex<()>>>>,
}

impl JobQueueInner {
    async fn lock_for(&self, kind: JobKind) -> Arc<Mutex<()>> {
        let mut locks = self.locks.lock().await;
        locks.entry(kind).or_insert_with(|| Arc::new(Mutex::new(()))).clone()
    }

    async fn snapshot_all(&self) -> Vec<JobSnapshot> {
        let jobs = self.jobs.read().await;
        let order = self.order.read().await;
        order
            .iter()
            .filter_map(|id| jobs.get(id).map(|j| j.snapshot.clone()))
            .collect()
    }

    async fn emit(&self, app: &AppHandle) {
        let snapshots = self.snapshot_all().await;
        app.emit("jobs:update", &snapshots).ok();
    }

    /// Drop finished jobs over the history cap. Called after every completion.
    async fn prune_and_emit(&self, app: &AppHandle) {
        {
            let mut jobs = self.jobs.write().await;
            let mut order = self.order.write().await;
            let finished: Vec<String> = order
                .iter()
                .filter(|id| {
                    jobs.get(*id).map(|j| {
                        matches!(
                            j.snapshot.status,
                            JobStatus::Completed | JobStatus::Failed | JobStatus::Cancelled
                        )
                    }) == Some(true)
                })
                .cloned()
                .collect();
            if finished.len() > MAX_HISTORY {
                let drop_count = finished.len() - MAX_HISTORY;
                for id in finished.iter().take(drop_count) {
                    jobs.remove(id);
                    if let Some(pos) = order.iter().position(|x| x == id) {
                        order.remove(pos);
                    }
                }
            }
        }
        self.emit(app).await;
    }
}

/// Public façade — stored in `AppState`.
#[derive(Debug, Default, Clone)]
pub struct JobQueue {
    inner: Arc<JobQueueInner>,
}

impl JobQueue {
    /// Register a new job. The job starts in `Queued` status; the caller is
    /// expected to call `JobHandle::mark_running` (or `set_progress`) when
    /// work actually begins.
    pub async fn create(
        &self,
        app: &AppHandle,
        kind: JobKind,
        title: impl Into<String>,
    ) -> JobHandle {
        let id = Uuid::new_v4().to_string();
        let cancel = Arc::new(Notify::new());
        let cancelled = Arc::new(AtomicBool::new(false));
        let snapshot = JobSnapshot {
            id: id.clone(),
            kind,
            title: title.into(),
            status: JobStatus::Queued,
            progress: 0.0,
            eta_sec: None,
            created_at: Utc::now().timestamp_millis(),
            started_at: None,
            finished_at: None,
            error: None,
        };
        {
            let mut jobs = self.inner.jobs.write().await;
            let mut order = self.inner.order.write().await;
            jobs.insert(
                id.clone(),
                JobInner {
                    snapshot,
                    cancel: cancel.clone(),
                    cancelled: cancelled.clone(),
                },
            );
            order.push_back(id.clone());
        }
        self.inner.emit(app).await;
        JobHandle {
            id,
            queue: self.inner.clone(),
            cancel,
            cancelled,
            app: app.clone(),
        }
    }

    /// Acquire the per-kind serialisation lock. Holding the returned guard
    /// ensures no other job of the same kind runs concurrently. Callers
    /// should drop it when work is done.
    pub async fn serialise(&self, kind: JobKind) -> tokio::sync::OwnedMutexGuard<()> {
        let lock = self.inner.lock_for(kind).await;
        lock.lock_owned().await
    }

    /// Flip the cancel flag on a job, waking any worker waiting on its
    /// `Notify`. The worker is expected to honour it promptly (kill child,
    /// stop, then call `mark_cancelled`).
    pub async fn cancel(&self, id: &str) -> Result<(), String> {
        let notify = {
            let mut jobs = self.inner.jobs.write().await;
            let job = jobs.get_mut(id).ok_or_else(|| format!("no such job: {id}"))?;
            // Already done — nothing to do.
            if matches!(
                job.snapshot.status,
                JobStatus::Completed | JobStatus::Failed | JobStatus::Cancelled
            ) {
                return Ok(());
            }
            job.cancelled.store(true, Ordering::SeqCst);
            job.cancel.clone()
        };
        notify.notify_waiters();
        Ok(())
    }

    pub async fn list(&self) -> Vec<JobSnapshot> {
        self.inner.snapshot_all().await
    }

    /// Mark every Running/Queued job as Cancelled. Called once at startup —
    /// see `persist::load_or_default` — because their child processes are
    /// long dead.
    pub async fn cleanse_dead_jobs(&self) {
        let mut jobs = self.inner.jobs.write().await;
        for job in jobs.values_mut() {
            if matches!(job.snapshot.status, JobStatus::Running | JobStatus::Queued) {
                job.snapshot.status = JobStatus::Cancelled;
                if job.snapshot.finished_at.is_none() {
                    job.snapshot.finished_at = Some(Utc::now().timestamp_millis());
                }
                if job.snapshot.error.is_none() {
                    job.snapshot.error = Some("app restarted before job finished".into());
                }
            }
        }
    }

    /// Persist a JSON snapshot of the queue to `path`. Best-effort.
    pub async fn persist_to(&self, path: &PathBuf) {
        let snapshots = self.inner.snapshot_all().await;
        if let Some(parent) = path.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        if let Ok(json) = serde_json::to_vec_pretty(&snapshots) {
            let _ = tokio::fs::write(path, json).await;
        }
    }

    /// Load a JSON snapshot from `path` if it exists.
    pub async fn load_from(&self, path: &PathBuf) {
        let Ok(raw) = tokio::fs::read(path).await else { return };
        let Ok(snapshots) = serde_json::from_slice::<Vec<JobSnapshot>>(&raw) else { return };
        let mut jobs = self.inner.jobs.write().await;
        let mut order = self.inner.order.write().await;
        for snap in snapshots {
            order.push_back(snap.id.clone());
            jobs.insert(
                snap.id.clone(),
                JobInner {
                    snapshot: snap,
                    cancel: Arc::new(Notify::new()),
                    cancelled: Arc::new(AtomicBool::new(false)),
                },
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn job_kind_slug_stable() {
        // Frontend pattern-matches on slugs; if we rename them, callers break.
        assert_eq!(JobKind::Export.slug(), "export");
        assert_eq!(JobKind::Transcribe.slug(), "transcribe");
        assert_eq!(JobKind::DownloadModel.slug(), "download-model");
        assert_eq!(JobKind::Snapshot.slug(), "snapshot");
    }

    #[test]
    fn job_status_serialises_kebab_case() {
        // Match the camelCase pattern the frontend uses for tagged unions.
        assert_eq!(
            serde_json::to_string(&JobStatus::Running).unwrap(),
            "\"running\""
        );
        assert_eq!(
            serde_json::to_string(&JobStatus::Cancelled).unwrap(),
            "\"cancelled\""
        );
    }
}
