/**
 * JobsFlyout — small popover in the StatusBar that shows the live state of
 * every background job (export, transcribe, model download, snapshot). The
 * trigger pill on the left of the bar shows a count of active jobs; clicking
 * it opens the flyout above the bar.
 *
 * The data is owned by the Rust `JobQueue` and mirrored into `useJobsStore`
 * via the `jobs:update` event; this component is a pure view over that.
 */

import { useEffect, useState } from "react";
import { Activity, CheckCircle2, Loader2, Pause, X, AlertCircle } from "lucide-react";
import { useJobsStore, activeJobs, finishedJobs } from "@/stores/jobsStore";
import type { JobSnapshot, JobStatus } from "@/lib/ipc";

function statusIcon(s: JobStatus) {
  switch (s) {
    case "running":
      return <Loader2 className="h-3 w-3 animate-spin" />;
    case "queued":
      return <Pause className="h-3 w-3" />;
    case "completed":
      return <CheckCircle2 className="h-3 w-3 text-emerald-400" />;
    case "failed":
      return <AlertCircle className="h-3 w-3 text-red-400" />;
    case "cancelled":
      return <X className="h-3 w-3 text-muted-foreground" />;
  }
}

function formatEta(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return "";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}

function JobRow({ job, onCancel }: { job: JobSnapshot; onCancel: (id: string) => void }) {
  const active = job.status === "running" || job.status === "queued";
  return (
    <div className="flex items-center gap-2 px-3 py-2 text-xs border-b border-border last:border-b-0">
      <span className="shrink-0">{statusIcon(job.status)}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-foreground">{job.title}</div>
        {active ? (
          <div className="mt-1 flex items-center gap-2">
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-border/40">
              <div
                className="h-full bg-primary transition-[width] duration-200"
                style={{ width: `${Math.max(2, Math.round(job.progress * 100))}%` }}
              />
            </div>
            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
              {Math.round(job.progress * 100)}%
              {job.etaSec !== null && job.etaSec > 0 ? ` · ${formatEta(job.etaSec)}` : ""}
            </span>
          </div>
        ) : (
          job.error && (
            <div className="mt-1 truncate text-[10px] text-red-400" title={job.error}>
              {job.error}
            </div>
          )
        )}
      </div>
      {active && (
        <button
          type="button"
          aria-label="Cancel job"
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-border/40 hover:text-foreground"
          onClick={() => onCancel(job.id)}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

export function JobsFlyout() {
  const jobs = useJobsStore((s) => s.jobs);
  const cancel = useJobsStore((s) => s.cancel);
  const [open, setOpen] = useState(false);

  const active = activeJobs(jobs);
  const finished = finishedJobs(jobs).slice(0, 5);
  const count = active.length;

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Close when clicking outside.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && el.closest("[data-jobs-flyout]")) return;
      setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  return (
    <div className="relative" data-jobs-flyout>
      <button
        type="button"
        className={`chip ${count > 0 ? "is-active" : ""}`}
        title={count > 0 ? `${count} active job${count === 1 ? "" : "s"}` : "Jobs"}
        onClick={() => setOpen((v) => !v)}
      >
        <Activity className="h-3 w-3" />
        Jobs
        {count > 0 && (
          <span className="ml-1 rounded-full bg-primary/30 px-1.5 py-0.5 text-[9px] font-medium text-primary-foreground">
            {count}
          </span>
        )}
      </button>
      {open && (
        <div
          className="absolute bottom-full left-0 mb-2 w-80 max-h-96 overflow-auto rounded-md border border-border bg-popover text-popover-foreground shadow-lg z-50"
          role="dialog"
          aria-label="Background jobs"
        >
          <div className="px-3 py-2 text-[11px] uppercase tracking-wider text-muted-foreground border-b border-border">
            Active
          </div>
          {active.length === 0 ? (
            <div className="px-3 py-3 text-xs text-muted-foreground">
              No jobs running.
            </div>
          ) : (
            active.map((j) => <JobRow key={j.id} job={j} onCancel={cancel} />)
          )}
          {finished.length > 0 && (
            <>
              <div className="px-3 py-2 text-[11px] uppercase tracking-wider text-muted-foreground border-b border-t border-border">
                Recent
              </div>
              {finished.map((j) => (
                <JobRow key={j.id} job={j} onCancel={cancel} />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
