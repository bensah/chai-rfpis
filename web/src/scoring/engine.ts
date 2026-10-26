/**
 * The main thread's handle on the scoring worker.
 *
 * One worker per tab, started the first time a page asks for something. Booting costs a few
 * seconds, so NOTHING waits on it: a page renders from stored values, calls `ask(...)`, and
 * replaces them when the answer arrives. `useEngine` exposes the boot state so a page can
 * say "working out the live numbers…" rather than appearing stuck.
 */
import { useEffect, useState } from "react";
import { fetchSnapshot } from "../api";
import { PY_BUNDLE_HASH } from "../generated/py-bundle-hash";
import type {
  FeedRequest, FeedResult, OpportunityRequest, OpportunityResult, WorkerResponse,
} from "./protocol";

export type EngineState = "idle" | "starting" | "ready" | "failed";

let worker: Worker | null = null;
let started: Promise<void> | null = null;
let state: EngineState = "idle";
let detail = "";
let failure = "";
let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const listeners = new Set<() => void>();

function announce(next: EngineState, text = "") {
  state = next;
  detail = text;
  listeners.forEach((f) => f());
}

function ensure(): Promise<void> {
  if (started) return started;
  announce("starting", "Loading the scoring engine…");
  started = (async () => {
    const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const m = e.data;
      if ("progress" in m) return announce("starting", m.progress);
      const slot = pending.get(m.id);
      pending.delete(m.id);
      if (!slot) return;
      if (m.ok) slot.resolve(m.result);
      else slot.reject(new Error(m.error));
    };
    w.onerror = (e) => {
      failure = e.message || "The scoring engine could not start.";
      announce("failed", failure);
      pending.forEach((s) => s.reject(new Error(failure)));
      pending.clear();
    };
    worker = w;
    // The snapshot is everything the Python reads from the database; the API applies the
    // caller's permissions and tenant scope before handing it over.
    const snapshot = await fetchSnapshot();
    await send("boot", { bundleUrl: `/py/bundle.json?v=${PY_BUNDLE_HASH}`, snapshot });
    announce("ready");
  })().catch((e: unknown) => {
    failure = e instanceof Error ? e.message : String(e);
    announce("failed", failure);
    throw e;
  });
  return started;
}

function send(kind: string, extra: Record<string, unknown>): Promise<unknown> {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker!.postMessage({ id, kind, ...extra });
  });
}

async function ask<T>(kind: "feed" | "opportunity", payload: unknown): Promise<T> {
  await ensure();
  return (await send(kind, { payload })) as T;
}

export const scoreFeed = (payload: FeedRequest) => ask<FeedResult>("feed", payload);
export const scoreOpportunity = (payload: OpportunityRequest) =>
  ask<OpportunityResult & { analysis: Record<string, unknown> | null }>("opportunity", payload);

/** Start the engine without waiting for it — called as soon as a signed-in page mounts, so
 * the few seconds of boot overlap with the user reading what is already on screen. */
export function warmEngine(): void {
  if (!started) void ensure().catch(() => undefined);
}

export function useEngine(): { state: EngineState; detail: string; error: string } {
  const [, bump] = useState(0);
  useEffect(() => {
    const f = () => bump((n) => n + 1);
    listeners.add(f);
    return () => {
      listeners.delete(f);
    };
  }, []);
  return { state, detail, error: failure };
}
