//! MLX-LLM sidecar manager.
//!
//! Responsibilities:
//!   1. Spawn the bundled `mlx-sidecar` binary as a child process on first use.
//!   2. Speak the JSON-line protocol over stdin/stdout.
//!   3. Ensure the child is killed when the Tauri app quits (CommandChild is
//!      stored in AppState and dropped on exit).
//!
//! The sidecar is started lazily on the first `call()` and kept alive for the
//! lifetime of the process. If the child exits unexpectedly the state is
//! cleared and the next `call()` will restart it.
//!
//! ## Protocol
//!
//! Request  (one JSON line → sidecar stdin):
//! ```json
//! {"id":"<uuid>","command":"summarise","payload":{...}}
//! ```
//!
//! Response (one JSON line ← sidecar stdout):
//! ```json
//! {"id":"<uuid>","ok":true,"result":{...}}
//! {"id":"<uuid>","ok":false,"error":"..."}
//! ```

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;
use tokio::sync::{Mutex, oneshot};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Wire types  (mirror mlx_llm/schemas.py)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
struct RawRequest {
    id: String,
    command: String,
    payload: Value,
}

#[derive(Debug, Deserialize)]
struct RawResponse {
    id: String,
    ok: bool,
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error: Option<String>,
}

// ---------------------------------------------------------------------------
// Shared pending-request map
// ---------------------------------------------------------------------------

type PendingMap = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value>>>>>;

// ---------------------------------------------------------------------------
// LlmSidecar
// ---------------------------------------------------------------------------

/// Manages the lifecycle of the `mlx-sidecar` child process.
///
/// Stored in `AppState`; clone is cheap (all state is behind `Arc`).
#[derive(Clone, Default)]
pub struct LlmSidecar {
    /// Running sidecar state — `None` when not yet started or after a crash.
    inner: Arc<Mutex<Option<SidecarInner>>>,
}

struct SidecarInner {
    /// Shared with the background drain task so it can resolve responses.
    pending: PendingMap,
    /// Write half of the child's stdin pipe.
    stdin_tx: tokio::sync::mpsc::UnboundedSender<Vec<u8>>,
}

impl LlmSidecar {
    /// Send a typed request to the sidecar and await the JSON `result` value.
    ///
    /// Starts the child process on first call. Serialises `payload` to JSON,
    /// writes the request line, and waits for the matching response line.
    pub async fn call(
        &self,
        app: &AppHandle,
        command: &str,
        payload: Value,
    ) -> Result<Value> {
        let id = Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel::<Result<Value>>();

        {
            let mut guard = self.inner.lock().await;
            let inner = Self::ensure_running(&mut guard, app).await?;

            // Register the pending response waiter before we send.
            inner.pending.lock().await.insert(id.clone(), tx);

            // Serialise and send the request line.
            let req = RawRequest {
                id: id.clone(),
                command: command.to_string(),
                payload,
            };
            let mut line =
                serde_json::to_string(&req).context("serialise LLM request")?;
            line.push('\n');
            inner
                .stdin_tx
                .send(line.into_bytes())
                .map_err(|_| anyhow::anyhow!("sidecar stdin channel closed"))?;
        }

        // Await response outside the lock so other callers aren't blocked.
        rx.await
            .context("sidecar response channel dropped (child may have exited)")?
    }

    /// Returns a mutable reference to the running sidecar, spawning it first
    /// if necessary.
    async fn ensure_running<'a>(
        guard: &'a mut Option<SidecarInner>,
        app: &AppHandle,
    ) -> Result<&'a mut SidecarInner> {
        if guard.is_none() {
            *guard = Some(Self::spawn(app).await?);
        }
        Ok(guard.as_mut().unwrap())
    }

    async fn spawn(app: &AppHandle) -> Result<SidecarInner> {
        log::info!("Spawning mlx-sidecar…");

        let shell = app.shell();
        let (mut rx, mut child) = shell
            .sidecar("mlx-sidecar")
            .context("mlx-sidecar not found in app bundle — run `python sidecars/mlx-llm/build.py` first")?
            .spawn()
            .context("failed to spawn mlx-sidecar")?;

        // Channel for the write half: the main task pushes bytes in, the
        // background writer task forwards them to the child's stdin pipe.
        let (stdin_tx, mut stdin_rx) =
            tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();

        // Background writer task — forwards stdin_rx bytes to child stdin.
        tauri::async_runtime::spawn(async move {
            while let Some(bytes) = stdin_rx.recv().await {
                if child.write(&bytes).is_err() {
                    log::warn!("mlx-sidecar stdin write failed — child may have exited");
                    break;
                }
            }
        });

        // Shared pending map between the caller and the stdout drain task.
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let pending_bg = pending.clone();

        // Background stdout drain task — routes each response line to the
        // corresponding pending oneshot sender.
        tauri::async_runtime::spawn(async move {
            while let Some(event) = rx.recv().await {
                match event {
                    CommandEvent::Stdout(bytes) => {
                        let line = String::from_utf8_lossy(&bytes);
                        Self::dispatch_line(line.trim(), &pending_bg).await;
                    }
                    CommandEvent::Stderr(bytes) => {
                        // Python's logging module writes to stderr.
                        let msg = String::from_utf8_lossy(&bytes);
                        log::debug!("[mlx-sidecar] {}", msg.trim());
                    }
                    CommandEvent::Terminated(status) => {
                        log::warn!(
                            "mlx-sidecar exited (code={:?}). \
                             It will restart on the next detect_chapters call.",
                            status.code
                        );
                        // Fail every in-flight request.
                        let mut map = pending_bg.lock().await;
                        for (_, tx) in map.drain() {
                            let _ = tx.send(Err(anyhow::anyhow!(
                                "mlx-sidecar exited unexpectedly"
                            )));
                        }
                        break;
                    }
                    _ => {}
                }
            }
        });

        Ok(SidecarInner { pending, stdin_tx })
    }

    /// Parse one stdout line and resolve the matching pending request.
    async fn dispatch_line(line: &str, pending: &PendingMap) {
        if line.is_empty() {
            return;
        }
        let resp: RawResponse = match serde_json::from_str(line) {
            Ok(r) => r,
            Err(e) => {
                log::warn!("Unparseable sidecar response ({e}): {line}");
                return;
            }
        };
        let mut map = pending.lock().await;
        if let Some(tx) = map.remove(&resp.id) {
            let result = if resp.ok {
                Ok(resp.result.unwrap_or(Value::Null))
            } else {
                Err(anyhow::anyhow!(
                    resp.error
                        .unwrap_or_else(|| "unknown sidecar error".into())
                ))
            };
            let _ = tx.send(result);
        } else {
            log::warn!(
                "Received sidecar response for unknown request id: {}",
                resp.id
            );
        }
    }
}
