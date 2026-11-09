/**
 * The main thread's handle on the scoring worker.
 *
 * One worker per tab, started the first time a page asks for something. Booting costs a few
 * seconds, so NOTHING waits on it: a page renders from stored values, calls `ask(...)`, and
 * replaces them when the answer arrives. `useEngine` exposes the boot state so a page can
 * say "working out the live numbers…" rather than appearing stuck.
 *
 * ONE CALLER LEFT: the Opportunity page's decision aid. The rail used to be the other, and
 * moved server-side once it was measured to need no scoring at all. This did not, and the
 * measurement is why it is still here rather than ported:
 *
 *   * `opportunity_scoring.analyse` reaches 87-95 functions of core/criteria_derive.py and
 *     43-48 of core/auto_scorer.py per call — 23 modules, several thousand lines. A
 *     TypeScript port would be a second implementation of the scoring rules, which is the
 *     class of bug this project has been bitten by twice.
 *   * The stored `alignment_score` is NOT the number this page shows. It equals
 *     `auto_scorer.auto_score`, and measured against the live database that differs from
 *     `analyse` on every RFPIS row (by ~4 points) and changes the RECOMMENDATION on 8 of
 *     40 CHAI Cameroon rows — Proceed vs Park, Park vs Decline. Reading it instead would
 *     change the answer the page gives to "should we bid?".
 *   * There is no stored per-criterion breakdown anywhere in the schema, and the page shows
 *     nine criteria with labels, bands, counts and points.
 *
 * Retiring this properly means having the `rescore` job persist the breakdown it already
 * computes in Python, after reconciling `auto_score` against `analyse` so there is one
 * number to store. Until then the engine stays, started only by the page that needs it.
 */
import { useEffect, useState } from "react";
import { fetchSnapshot } from "../api";
import { PY_BUNDLE_HASH } from "../generated/py-bundle-hash";
import type { OpportunityRequest, OpportunityResult, WorkerResponse } from "./protocol";

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

async function ask<T>(kind: "opportunity", payload: unknown): Promise<T> {
  await ensure();
  return (await send(kind, { payload })) as T;
}

export const scoreOpportunity = (payload: OpportunityRequest) =>
  ask<OpportunityResult & { analysis: Record<string, unknown> | null }>("opportunity", payload);

/** Start the engine without waiting for it. The Opportunity page calls this as it mounts,
 * so the boot overlaps with the user reading the header and the call's own details, which
 * render from the API's rows and never wait on Python. */
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
