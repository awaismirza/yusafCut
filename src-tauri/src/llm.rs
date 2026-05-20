//! MLX-LLM sidecar manager.
//!
//! Responsibilities:
//!   1. Spawn the bundled `mlx-sidecar` binary as a child process on first use.
//!   2. Speak the JSON-line protocol over stdin/stdout.
//!   3. Ensure the child is killed when the Tauri app quits (CommandChild is
//!      stored in AppState and dropped on exit).
//!
//! The sidecar is started lazily on the first `call()` and kept alive for the
//! lifetime of the process. If the child exits unexpectedly the inner state is
//! cleared so the *next* `call()` automatically restarts it.
//!
//! ## Bug fix: "sidecar stdin channel closed"
//!
//! Previously, the `Terminated` event handler drained in-flight requests but
//! left `inner` as `Some(...)` holding a dead `stdin_tx`. Any subsequent
//! `call()` would see `inner.is_some()`, skip the restart, and immediately
//! fail with "sidecar stdin channel closed".
//!
//! The fix: pass an `Arc` of `inner` into the drain task so the `Terminated`
//! handler can `*inner_arc.lock().await = None`, allowing `ensure_running` to
//! restart the process correctly on the next call.
//!
//! Additionally, `call()` now clears `inner` itself when `stdin_tx.send()`
//! fails (handles the race where the sidecar exits between `spawn()` and the
//! first write).
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
type InnerArc   = Arc<Mutex<Option<SidecarInner>>>;

// ---------------------------------------------------------------------------
// LlmSidecar
// ---------------------------------------------------------------------------

/// Manages the lifecycle of the `mlx-sidecar` child process.
///
/// Stored in `AppState`; clone is cheap (all state is behind `Arc`).
#[derive(Clone, Default)]
pub struct LlmSidecar {
    /// Running sidecar state — `None` when not yet started or after a crash.
    inner: InnerArc,
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
    /// Starts the child process on first call (or restarts it after a crash).
    /// Serialises `payload` to JSON, writes the request line, and waits for
    /// the matching response line.
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
            let inner = Self::ensure_running(&mut guard, app, self.inner.clone()).await?;

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

            if inner.stdin_tx.send(line.into_bytes()).is_err() {
                // The writer task already exited (sidecar died between spawn and
                // first write). Clear inner so the next call() will restart it,
                // and remove the pending waiter we just inserted.
                inner.pending.lock().await.remove(&id);
                *guard = None;
                return Err(anyhow::anyhow!(
                    "mlx-sidecar exited before the request could be sent — \
                     please try again (the sidecar will restart automatically)"
                ));
            }
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
        inner_arc: InnerArc,
    ) -> Result<&'a mut SidecarInner> {
        if guard.is_none() {
            *guard = Some(Self::spawn(app, inner_arc).await?);
        }
        Ok(guard.as_mut().unwrap())
    }

    /// Spawn the sidecar process and return a fresh `SidecarInner`.
    ///
    /// `inner_arc` is the same `Arc` that wraps this `Option<SidecarInner>`.
    /// It is passed into the background drain task so the `Terminated` handler
    /// can reset it to `None`, enabling automatic restart on the next `call()`.
    async fn spawn(app: &AppHandle, inner_arc: InnerArc) -> Result<SidecarInner> {
        log::info!("Spawning mlx-sidecar…");

        let shell = app.shell();
        let (mut rx, mut child) = shell
            .sidecar("mlx-sidecar")
            .context("mlx-sidecar not found in app bundle — run `npm run sidecar:setup && npm run sidecar:build`")?
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
                        // Python's logging module writes to stderr — surface at
                        // warn so it's always visible without RUST_LOG=debug.
                        let msg = String::from_utf8_lossy(&bytes);
                        log::warn!("[mlx-sidecar] {}", msg.trim());
                    }
                    CommandEvent::Terminated(status) => {
                        log::warn!(
                            "mlx-sidecar exited (code={:?}). \
                             Clearing inner state so the next call restarts it.",
                            status.code
                        );

                        // Fail every in-flight request.
                        let mut map = pending_bg.lock().await;
                        for (_, tx) in map.drain() {
                            let _ = tx.send(Err(anyhow::anyhow!(
                                "mlx-sidecar exited unexpectedly"
                            )));
                        }
                        drop(map); // release pending lock before acquiring inner lock

                        // ── KEY FIX ──────────────────────────────────────────
                        // Reset inner to None so ensure_running() will restart
                        // the sidecar on the next call() instead of trying to
                        // write to the dead stdin channel.
                        *inner_arc.lock().await = None;
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
