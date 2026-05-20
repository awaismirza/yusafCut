/**
 * SnapshotsDialog — named restore points for the active project.
 *
 * Undo is fine for the last 50 edits but useless across restarts or for
 * pinning a "milestone" version (e.g. "Snapshot v3 — before client edits").
 *
 * Snapshots live inside the `.scribe` bundle (see Rust `snapshots` module) so
 * they travel with the file. Each entry shows label, age, segment count, and
 * total duration. Restore replaces the in-memory project with the snapshot
 * contents — wrapped in `replaceProjectBaseline` so the undo stack is reset
 * cleanly (restoring shouldn't itself be undoable).
 */

import { useCallback, useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { History, RotateCcw, Save as SaveIcon, Trash2 } from "lucide-react";
import {
  createSnapshot,
  deleteSnapshot,
  listSnapshots,
  restoreSnapshot,
  type SnapshotIndex,
} from "@/lib/ipc";
import { replaceProjectBaseline, useProjectStore } from "@/stores/projectStore";
import { useUIStore } from "@/stores/uiStore";
import { formatDuration } from "@/lib/timecode";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const seconds = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function SnapshotsDialog({ open, onOpenChange }: Props) {
  const project = useProjectStore((s) => s.project);
  const filePath = useProjectStore((s) => s.filePath);
  const pushToast = useUIStore((s) => s.pushToast);

  const [snapshots, setSnapshots] = useState<SnapshotIndex[]>([]);
  const [loading, setLoading] = useState(false);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!filePath) {
      setSnapshots([]);
      return;
    }
    setLoading(true);
    try {
      setSnapshots(await listSnapshots(filePath));
    } catch (err) {
      pushToast({
        title: "Failed to load snapshots",
        description: String(err),
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [filePath, pushToast]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const handleCreate = useCallback(async () => {
    if (!filePath) {
      pushToast({
        title: "Save the project first",
        description: "Snapshots live inside the .scribe bundle, so you need to save once.",
        variant: "destructive",
      });
      return;
    }
    setBusy(true);
    try {
      await createSnapshot(project, filePath, label.trim());
      setLabel("");
      await refresh();
      pushToast({ title: "Snapshot saved" });
    } catch (err) {
      pushToast({
        title: "Snapshot failed",
        description: String(err),
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  }, [filePath, label, project, pushToast, refresh]);

  const handleRestore = useCallback(
    async (id: string) => {
      if (!filePath) return;
      const ok = window.confirm("Restore this snapshot? Unsaved changes will be lost.");
      if (!ok) return;
      setBusy(true);
      try {
        const restored = await restoreSnapshot(filePath, id);
        replaceProjectBaseline(restored, { filePath, dirty: true });
        pushToast({ title: "Snapshot restored" });
        onOpenChange(false);
      } catch (err) {
        pushToast({
          title: "Restore failed",
          description: String(err),
          variant: "destructive",
        });
      } finally {
        setBusy(false);
      }
    },
    [filePath, onOpenChange, pushToast],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      if (!filePath) return;
      setBusy(true);
      try {
        await deleteSnapshot(filePath, id);
        await refresh();
      } catch (err) {
        pushToast({
          title: "Delete failed",
          description: String(err),
          variant: "destructive",
        });
      } finally {
        setBusy(false);
      }
    },
    [filePath, pushToast, refresh],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="h-4 w-4 text-primary" />
            Snapshots
          </DialogTitle>
          <DialogDescription>
            Named restore points stored inside the .scribe bundle. Survive restarts and travel with
            the project file.
          </DialogDescription>
        </DialogHeader>

        {filePath ? (
          <>
            <div className="flex items-center gap-2">
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Optional label — e.g. ‘before client edits’"
                className="h-9 flex-1 rounded-md border border-input bg-background px-3 text-sm"
              />
              <Button onClick={handleCreate} disabled={busy} className="gap-2">
                <SaveIcon className="h-4 w-4" /> Snapshot
              </Button>
            </div>

            <div className="flex max-h-72 flex-col gap-2 overflow-auto">
              {loading && (
                <div className="px-3 py-6 text-center text-xs text-muted-foreground">Loading…</div>
              )}
              {!loading && snapshots.length === 0 && (
                <div className="rounded-md border border-dashed border-border bg-secondary/40 px-3 py-6 text-center text-xs text-muted-foreground">
                  No snapshots yet. Take one before a risky edit and you can come back later.
                </div>
              )}
              {snapshots.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center gap-3 rounded-md border border-border bg-secondary/30 px-3 py-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium" title={s.label}>
                      {s.label}
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                      {relativeTime(s.createdAt)} · {s.segments} segment{s.segments === 1 ? "" : "s"}{" "}
                      · {formatDuration(s.durationSec)}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-2"
                    onClick={() => handleRestore(s.id)}
                    disabled={busy}
                  >
                    <RotateCcw className="h-3.5 w-3.5" /> Restore
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8 text-muted-foreground hover:text-red-400"
                    aria-label="Delete snapshot"
                    onClick={() => handleDelete(s.id)}
                    disabled={busy}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="rounded-md border border-dashed border-border bg-secondary/40 px-3 py-6 text-center text-xs text-muted-foreground">
            Save the project once before taking snapshots — they're stored inside the .scribe
            bundle.
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
