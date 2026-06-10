// =============================================================================
// Local-only check stats (R89.LOCAL — 2026-06-05)
// =============================================================================
// Persists per-assertion / per-check stats to .cipherwake/stats.json in the
// customer's repo. Records every result the CIPHERWAKE_* blocks already
// print to stdout — pass/fail, status, severity, source, timestamp — so the
// customer can later see (via `pqcheck stats`) which checks actually
// catch real things vs. sit silent or false-flag.
//
// HARD RULE — privacy guarantee:
//   This module emits ZERO network requests. It only writes to a local file.
//   No telemetry, no analytics, no cross-repo aggregation. The customer's
//   results stay on their machine. This matches Cipherwake's "no credentials"
//   stance — "no credentials and now no data exhaust either."
//
// Cross-repo aggregation is a SEPARATE opt-in feature (paid tier hosted
// analytics) that requires explicit account configuration. That path is
// not implemented in this CLI module.
// =============================================================================

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";

const STATS_DIR = ".cipherwake";
const STATS_FILE = "stats.json";

/**
 * Stats entry shape per check id. Check ids follow a stable scheme:
 *   route:<path>            — route assertion
 *   header:<header-name>    — header invariant
 *   cookie:<name-pattern>   — cookie invariant
 *   secret:<pattern-id>     — secret scanner finding
 *   deployHealth            — deploy-not-broken
 *
 * @typedef {Object} CheckStats
 * @property {number} runs
 * @property {number} passed
 * @property {number} failed
 * @property {number} confirmedReal      — incremented when a previously-failing check now passes (inferred fix)
 * @property {number} dismissedIntentional — incremented when the customer marks the failure as intentional
 * @property {"pass"|"fail"|"unknown"} lastResult
 * @property {number|null} lastStatus
 * @property {string} lastSeenAt   — ISO timestamp
 * @property {string} severity     — last severity seen
 * @property {string} source       — "customer" | "default" | "auto" | "health" | "secret"
 */

/**
 * Walk up from cwd to find the nearest repo root (.cipherwake.json or .git).
 * Stats file lives in <repo-root>/.cipherwake/stats.json.
 */
async function findStatsDir() {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, ".cipherwake.json")) || existsSync(join(dir, ".git"))) {
      return join(dir, STATS_DIR);
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: write to cwd
  return join(process.cwd(), STATS_DIR);
}

/**
 * Load stats.json from disk. Returns empty stats object if missing or
 * malformed (we never crash the deploy-check on stats issues).
 */
export async function loadStats() {
  try {
    const statsDir = await findStatsDir();
    const path = join(statsDir, STATS_FILE);
    if (!existsSync(path)) return { version: 1, checks: {} };
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.checks) return { version: 1, checks: {} };
    return parsed;
  } catch {
    return { version: 1, checks: {} };
  }
}

/**
 * Persist stats.json. Creates .cipherwake/ if missing.
 */
async function persistStats(stats) {
  try {
    const statsDir = await findStatsDir();
    if (!existsSync(statsDir)) {
      await mkdir(statsDir, { recursive: true });
    }
    const path = join(statsDir, STATS_FILE);
    await writeFile(path, JSON.stringify(stats, null, 2), "utf8");
    return path;
  } catch {
    return null;
  }
}

/**
 * Apply a batch of check outcomes from a single deploy-check run. Each entry:
 *   { id, result: "pass"|"fail", status, severity, source }
 *
 * Inferred confirmedReal: when the previous lastResult was "fail" and the
 * new result is "pass", increment confirmedReal. This catches the "I fixed
 * the regression Cipherwake flagged" event.
 */
export async function recordResults(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const stats = await loadStats();
  const now = new Date().toISOString();
  for (const e of entries) {
    if (!e || typeof e.id !== "string") continue;
    const cur = stats.checks[e.id] || {
      runs: 0,
      passed: 0,
      failed: 0,
      confirmedReal: 0,
      dismissedIntentional: 0,
      lastResult: "unknown",
      lastStatus: null,
      lastSeenAt: now,
      severity: e.severity || "low",
      source: e.source || "default",
    };
    cur.runs += 1;
    if (e.result === "pass") {
      cur.passed += 1;
      if (cur.lastResult === "fail") cur.confirmedReal += 1;
      cur.lastResult = "pass";
    } else if (e.result === "fail") {
      cur.failed += 1;
      cur.lastResult = "fail";
    }
    cur.lastStatus = (typeof e.status === "number" || e.status === null) ? e.status : cur.lastStatus;
    cur.lastSeenAt = now;
    cur.severity = e.severity || cur.severity;
    cur.source = e.source || cur.source;
    stats.checks[e.id] = cur;
  }
  return await persistStats(stats);
}

/**
 * Mark a check as dismissed-intentional. Customer ran `pqcheck dismiss <id>`
 * after reviewing it as a false positive / intentional state.
 */
export async function markDismissed(id) {
  if (typeof id !== "string" || !id) return null;
  const stats = await loadStats();
  const cur = stats.checks[id] || { runs: 0, passed: 0, failed: 0, confirmedReal: 0, dismissedIntentional: 0, lastResult: "unknown", lastStatus: null, lastSeenAt: new Date().toISOString(), severity: "low", source: "customer" };
  cur.dismissedIntentional += 1;
  cur.lastSeenAt = new Date().toISOString();
  stats.checks[id] = cur;
  return await persistStats(stats);
}

/**
 * Mark a check as a confirmed real catch (used by `pqcheck confirm <id>`
 * when the customer wants to record it explicitly rather than relying on
 * the inferred-from-fix mechanism).
 */
export async function markConfirmed(id) {
  if (typeof id !== "string" || !id) return null;
  const stats = await loadStats();
  const cur = stats.checks[id] || { runs: 0, passed: 0, failed: 0, confirmedReal: 0, dismissedIntentional: 0, lastResult: "unknown", lastStatus: null, lastSeenAt: new Date().toISOString(), severity: "low", source: "customer" };
  cur.confirmedReal += 1;
  cur.lastSeenAt = new Date().toISOString();
  stats.checks[id] = cur;
  return await persistStats(stats);
}

/**
 * R90 (2026-06-05) — record snapshot of "what's on the public surface" so
 * the next deploy-check can diff it. Captures:
 *   - publicRoutes: list of /privacy, /terms, etc. paths returning 200
 *   - thirdPartyHosts: list of third-party script hosts loaded by the homepage
 *   - certDaysToExpiry: TLS cert remaining days
 *
 * Compared against the prior snapshot at next-deploy time to emit
 * "new since last deploy" diffs (B and C in the final build brief).
 * Snapshots live in .cipherwake/stats.json (local, no transmission).
 *
 * Returns the diff vs the prior snapshot (or null if this is the first run).
 */
export async function recordSurfaceSnapshot(snapshot) {
  try {
    const stats = await loadStats();
    if (!stats.surfaceSnapshots) stats.surfaceSnapshots = {};
    const now = new Date().toISOString();
    const prev = stats.surfaceSnapshots[snapshot.domain] || null;
    const diff = computeSurfaceDiff(prev, snapshot);
    stats.surfaceSnapshots[snapshot.domain] = {
      capturedAt: now,
      publicRoutes: snapshot.publicRoutes || [],
      thirdPartyHosts: snapshot.thirdPartyHosts || [],
      certDaysToExpiry: snapshot.certDaysToExpiry ?? null,
    };
    await persistStats(stats);
    return diff;
  } catch {
    return null;
  }
}

function computeSurfaceDiff(prev, current) {
  if (!prev) return null;
  const prevRoutes = new Set(prev.publicRoutes || []);
  const currRoutes = new Set(current.publicRoutes || []);
  const prevHosts = new Set(prev.thirdPartyHosts || []);
  const currHosts = new Set(current.thirdPartyHosts || []);
  return {
    newRoutes: [...currRoutes].filter((r) => !prevRoutes.has(r)),
    removedRoutes: [...prevRoutes].filter((r) => !currRoutes.has(r)),
    newHosts: [...currHosts].filter((h) => !prevHosts.has(h)),
    removedHosts: [...prevHosts].filter((h) => !currHosts.has(h)),
    prevSnapshotAt: prev.capturedAt,
  };
}

/**
 * Format stats as a human-readable table for `pqcheck stats`.
 */
export function formatStatsTable(stats) {
  const ids = Object.keys(stats.checks || {}).sort();
  if (ids.length === 0) return "No check results recorded yet. Run `pqcheck deploy-check` to start.";
  const lines = [];
  lines.push("Cipherwake check stats (local, never transmitted)");
  lines.push("=" .repeat(96));
  lines.push("CHECK".padEnd(40) + " RUNS  PASS  FAIL  CONFIRMED  DISMISSED  LAST  SEVERITY");
  lines.push("-" .repeat(96));
  for (const id of ids) {
    const s = stats.checks[id];
    const last = s.lastResult || "?";
    lines.push(
      id.slice(0, 39).padEnd(40) +
      String(s.runs).padStart(5) +
      String(s.passed).padStart(6) +
      String(s.failed).padStart(6) +
      String(s.confirmedReal).padStart(11) +
      String(s.dismissedIntentional).padStart(11) +
      " " + last.padEnd(5) +
      " " + (s.severity || "?")
    );
  }
  lines.push("-" .repeat(96));
  const totalRuns = ids.reduce((a, id) => a + (stats.checks[id].runs || 0), 0);
  const totalFailed = ids.reduce((a, id) => a + (stats.checks[id].failed || 0), 0);
  const totalConfirmed = ids.reduce((a, id) => a + (stats.checks[id].confirmedReal || 0), 0);
  const totalDismissed = ids.reduce((a, id) => a + (stats.checks[id].dismissedIntentional || 0), 0);
  const catchRate = totalFailed > 0 ? ((totalConfirmed / totalFailed) * 100).toFixed(0) : "—";
  lines.push(`TOTAL: ${ids.length} checks tracked, ${totalRuns} runs, ${totalFailed} failures, ${totalConfirmed} confirmed real, ${totalDismissed} dismissed.`);
  lines.push(`Confirmed-catch rate: ${catchRate}% of failures were confirmed real (a fix landed afterward).`);
  return lines.join("\n");
}
