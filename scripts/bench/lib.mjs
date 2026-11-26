/**
 * Shared by the benchmark workloads in scripts/bench: configuration from the
 * environment, timing, percentiles, and the one line each measurement prints.
 *
 * A workload prints `BENCH {json}` per measurement. scripts/e2e.mjs --suite
 * bench collects those lines into one results file with the run's
 * environment. Every number is what this run observed from the client side:
 * nothing here is a target or a capacity claim.
 */
import { randomUUID } from "node:crypto";
import { BASE } from "./common.mjs";

export { BASE };

/** A positive number from the environment, or the default. */
export function env(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number, not ${JSON.stringify(raw)}`);
  return value;
}

/** A comma-separated list of positive integers from the environment. */
export function envList(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw.split(",").map((part) => {
    const value = Number(part);
    if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must list positive integers, not ${JSON.stringify(raw)}`);
    return value;
  });
}

/** SCALE multiplies every workload's default size: 0.2 for a smoke run, 5 for a long one. */
export const SCALE = env("SCALE", 1);
export const scaled = (n) => Math.max(1, Math.round(n * SCALE));

export function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

/** Latency summary of a list of millisecond samples. */
export function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  const round = (value) => (value === null ? null : Math.round(value * 10) / 10);
  return {
    n: sorted.length,
    mean: round(sorted.length ? total / sorted.length : null),
    p50: round(quantile(sorted, 0.5)),
    p95: round(quantile(sorted, 0.95)),
    p99: round(quantile(sorted, 0.99)),
    max: round(sorted.at(-1) ?? null),
  };
}

/** Prints one measurement for the runner to collect. */
export function emit(workload, scenario, params, metrics) {
  console.log(`BENCH ${JSON.stringify({ workload, scenario, params, metrics })}`);
}

/** A fresh workspace id and a token for it from the dev claim route. */
export async function workspace() {
  const id = randomUUID();
  return { id, token: await tokenFor(id) };
}

export async function tokenFor(workspaceId) {
  const response = await fetch(`${BASE}/_tapedb/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId }),
  });
  const body = await response.json();
  if (typeof body.token !== "string") throw new Error(`no claim for ${workspaceId}: ${JSON.stringify(body)}`);
  return body.token;
}

/** One HTTP call to a workspace route; returns { ok, status, ms, body }. */
export async function call(ws, path, body) {
  const started = performance.now();
  const response = await fetch(`${BASE}/engine/workspaces/${ws.id}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ws.token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const parsed = await response.json().catch(() => null);
  return { ok: response.ok && parsed?.ok !== false, status: response.status, ms: performance.now() - started, body: parsed };
}

/** The workspace's `GET /metrics` answer (ADMIN; dev claims are OWNER), or null. */
export async function metrics(ws) {
  const result = await call(ws, "/metrics");
  return result.ok ? result.body : null;
}

/**
 * Runs `task(i)` for i in [0, total) with at most `concurrency` in flight.
 * Returns the latencies of the tasks that succeeded, the failures, and the
 * wall time.
 */
export async function pool(total, concurrency, task) {
  const latencies = [];
  const errors = {};
  let next = 0;
  const started = performance.now();
  const worker = async () => {
    while (next < total) {
      const index = next++;
      const result = await task(index).catch((error) => ({ ok: false, status: 0, error: String(error), ms: 0 }));
      if (result.ok) latencies.push(result.ms);
      else {
        const key = result.body?.error?.code ?? `http_${result.status}`;
        errors[key] = (errors[key] ?? 0) + 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
  const wallMs = performance.now() - started;
  const failed = Object.values(errors).reduce((a, b) => a + b, 0);
  return {
    latencies,
    errors,
    wallMs,
    throughput: Math.round((latencies.length / (wallMs / 1000)) * 10) / 10,
    errorRate: Math.round((failed / Math.max(1, total)) * 10_000) / 10_000,
  };
}

/** Insert ops for `n` tasks with distinct ids and titles. */
export function taskOps(prefix, n, extra = {}) {
  return Array.from({ length: n }, (_, index) => ({
    op: "insert",
    namespace: "task",
    id: `${prefix}-${index}`,
    values: { title: `${prefix}-${String(index).padStart(6, "0")}`, done: index % 3 === 0, ...extra },
  }));
}

/** Seeds `rows` tasks in transactions of `batch`. */
export async function seedTasks(ws, rows, { batch = 500, prefix = "seed", extra = {} } = {}) {
  for (let start = 0; start < rows; start += batch) {
    const n = Math.min(batch, rows - start);
    const ops = taskOps(`${prefix}${start}`, n, extra);
    const result = await call(ws, "/transact", { txId: `${prefix}-${start}`, ops });
    if (!result.ok) throw new Error(`seed failed: ${JSON.stringify(result.body)}`);
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
