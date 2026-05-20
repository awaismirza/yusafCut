/**
 * Frontend mirror of the Rust JobQueue.
 *
 * The Rust side owns the truth — this store just subscribes to `jobs:update`
 * events and keeps a copy so React components can render the Jobs flyout.
 *
 * The first time the app loads, we also pull `list_jobs` once so the flyout
 * reflects whatever was persisted across the restart.
 */

import { create } from "zustand";
import {
  cancelJob as cancelJobIpc,
  listJobs,
  onJobsUpdate,
  type JobSnapshot,
} from "@/lib/ipc";

interface JobsState {
  jobs: JobSnapshot[];
  /** True while we're waiting on the initial list_jobs call. */
  loading: boolean;
  setJobs: (jobs: JobSnapshot[]) => void;
  cancel: (id: string) => Promise<void>;
}

export const useJobsStore = create<JobsState>()((set) => ({
  jobs: [],
  loading: true,
  setJobs: (jobs) => set({ jobs, loading: false }),
  cancel: async (id: string) => {
    try {
      await cancelJobIpc(id);
    } catch (e) {
      // The Rust side may have already finished the job; ignore.
      console.warn("[jobs] cancel failed", e);
    }
  },
}));

/**
 * Wire up the live `jobs:update` listener. Returns an `unlisten` fn the
 * caller (`App.tsx`) should call on unmount. Also kicks off an initial fetch
 * so the flyout populates even before the first event arrives.
 */
export async function initJobsStream(): Promise<() => void> {
  // Initial pull
  try {
    const initial = await listJobs();
    useJobsStore.getState().setJobs(initial);
  } catch (e) {
    console.warn("[jobs] initial list failed", e);
    useJobsStore.setState({ loading: false });
  }
  const unlisten = await onJobsUpdate((jobs) => {
    useJobsStore.getState().setJobs(jobs);
  });
  return unlisten;
}

/** Convenience: jobs that are running or queued. */
export function activeJobs(jobs: JobSnapshot[]): JobSnapshot[] {
  return jobs.filter((j) => j.status === "running" || j.status === "queued");
}

/** Convenience: jobs that finished (completed, failed, cancelled). Newest first. */
export function finishedJobs(jobs: JobSnapshot[]): JobSnapshot[] {
  return jobs
    .filter(
      (j) =>
        j.status === "completed" || j.status === "failed" || j.status === "cancelled",
    )
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
}
