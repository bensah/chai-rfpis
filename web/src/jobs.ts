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

export const JOB_STATUS_LABEL: Record<Job["status"], string> = {
  queued: "Queued",
  dispatched: "Waiting for a runner (about a minute)",
  running: "Running",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};
