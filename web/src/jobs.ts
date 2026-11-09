import { useEffect, useState } from "react";
import { fetchJob, type Job } from "./api";

const FINAL = new Set(["done", "failed", "cancelled"]);

/** Poll a background job every 5 s until it finishes. */
export function useJob(initial: Job | null): Job | null {
  const [job, setJob] = useState<Job | null>(initial);
  useEffect(() => setJob(initial), [initial]);
  useEffect(() => {
    if (!job || FINAL.has(job.status)) return;
    const t = window.setTimeout(() => {
      fetchJob(job.id).then(setJob).catch(() => undefined);
    }, 5000);
    return () => window.clearTimeout(t);
  }, [job]);
  return job;
}

/**
 * Wait for a job to finish, for a caller that cannot carry on without it — the editor's
 * delete, which must not say "deleted" until the row actually is.
 *
 * Polls faster than `useJob` (2 s, not 5) because somebody is watching a dialog rather
 * than a status line, and locally the runner is a spawned process that finishes in a
 * second or two. Returns the finished job, or the last one it saw if the wait ran out:
 * `null`/not-final is "still going", which is a different thing to say than "failed", and
 * the caller has to say it.
 *
 * A failed poll is ignored rather than fatal — a dropped request mid-job is not a failed
 * job — but the deadline still applies, so this cannot spin forever.
 */
export async function awaitJob(
  id: string,
  onProgress?: (job: Job) => void,
  { everyMs = 2000, timeoutMs = 180_000 }: { everyMs?: number; timeoutMs?: number } = {},
): Promise<Job | null> {
  const deadline = Date.now() + timeoutMs;
  let last: Job | null = null;
  for (;;) {
    try {
      last = await fetchJob(id);
      onProgress?.(last);
      if (FINAL.has(last.status)) return last;
    } catch {
      // transient — keep waiting, the deadline below is the limit
    }
    if (Date.now() >= deadline) return last;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

export const JOB_STATUS_LABEL: Record<Job["status"], string> = {
  queued: "Queued",
  dispatched: "Waiting for a runner (about a minute)",
  running: "Running",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};
