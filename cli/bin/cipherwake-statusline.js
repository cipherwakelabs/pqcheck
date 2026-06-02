#!/usr/bin/env node
// =============================================================================
// cipherwake-statusline — reads ~/.config/cipherwake/last-scan.json and outputs
// a single-line summary for AI-coder status surfaces.
// =============================================================================
// Designed for Claude Code's `statusLine` setting (a config-level hook that
// runs any shell command and renders its stdout in the persistent status line).
// One-line install:
//
//   add to ~/.claude/settings.json:
//   { "statusLine": { "type": "command", "command": "npx cipherwake-statusline" } }
//
// Cipherwake never modifies your settings.json — paste the line yourself per
// CLAUDE.md Rule 17 (consolidated consent for any change outside our own
// config dir).
//
// The script is dependency-free + fast (<50ms on cold start) because Claude
// Code calls it on every turn. Reads a single file, formats one line, exits.
// =============================================================================

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

const GLOBAL_STATE_FILE = join(homedir(), ".config", "cipherwake", "last-scan.json");
const STALE_THRESHOLD_HOURS = 24;

// v0.16.19 — `--prepend=<command>` flag for statusLine composition. Claude
// Code's `statusLine.command` only supports ONE command, which means two
// tools (e.g. Cipherwake + PinnedAI) both writing their own statusLine
// silently clobber each other depending on install order. When a customer
// runs both, they only see whichever installed last. With --prepend, the
// Cipherwake binary runs the other tool's command first, joins its output
// with a separator, and renders Cipherwake's own line after. Result:
// `[pinned output] · ◆ Cipherwake · domain ✓ PASS · 5m ago` — both
// surfaces visible in the single statusLine slot.
//
// pqcheck setup detects an existing statusLine.command at install time
// and writes the wrapper form automatically:
//   "command": "npx --package=pqcheck@latest cipherwake-statusline --prepend='<prior-command>'"
//
// If the prior command errors (or the tool was uninstalled), this binary
// swallows the failure and just renders Cipherwake's part — never causes
// the whole statusLine to break.
const PREPEND_SEPARATOR = " · ";
const prependArg = process.argv.find((a) => a.startsWith("--prepend="));
if (prependArg) {
  const prependCmd = prependArg.slice("--prepend=".length);
  if (prependCmd) {
    try {
      // 5s soft timeout — statusLine rendering must stay snappy. If the
      // other tool hangs, we cut it off and continue with Cipherwake's part.
      // stdio: ignore on stderr so a noisy prior tool doesn't pollute the
      // bar; we want only its rendered stdout output.
      const out = execSync(prependCmd, {
        encoding: "utf8",
        timeout: 5_000,
        stdio: ["ignore", "pipe", "ignore"],
        env: process.env,
      }).trim();
      if (out) {
        process.stdout.write(out);
        process.stdout.write(PREPEND_SEPARATOR);
      }
    } catch {
      // Prepend command failed (uninstalled, timeout, errored). Skip
      // silently — never break the whole statusLine because of a
      // composition partner.
    }
  }
}

// v0.16.6 — project-aware state lookup. Walk up from CWD looking for a
// repo-local `.cipherwake/last-scan.json`. This way each project shows
// its own last scan, and switching projects doesn't bleed the previous
// project's state into the new one. Falls back to the global file when
// no project-local state exists (or when running outside a project).
//
// The walk stops at the first ancestor containing EITHER a `.git/` dir
// or a `package.json` — that's our project-root heuristic. We do not
// require both because non-Node projects (Python, Go) still have `.git/`
// but no package.json.
// pqcheck writes repo-local state to `.cipherwake/last-status.json` (writer
// uses that filename per writeLastScanFile in pqcheck.js — kept compatible).
function findProjectStateFile(startDir) {
  let dir = startDir;
  for (let i = 0; i < 20; i++) {
    const candidate = join(dir, ".cipherwake", "last-status.json");
    if (existsSync(candidate)) return candidate;
    // Stop at the project root even if no .cipherwake/ — don't bleed across
    // project boundaries by continuing up.
    const isProjectRoot = existsSync(join(dir, ".git")) || existsSync(join(dir, "package.json"));
    if (isProjectRoot) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

const cwd = process.env.PWD || process.cwd();
const projectStateFile = findProjectStateFile(cwd);
const STATE_FILE = projectStateFile || GLOBAL_STATE_FILE;

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

function formatAge(iso) {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  if (ms < 60_000) return "just now";
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

function ageHours(iso) {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso).getTime()) / (60 * 60 * 1000);
}

// --no-color / NO_COLOR support per https://no-color.org
const noColor = process.argv.includes("--no-color") || process.env.NO_COLOR;
function c(color, str) {
  if (noColor) return str;
  return `${color}${str}${C.reset}`;
}

let state;
try {
  state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
} catch {
  // No scan yet — anchor on the brand so first-time users see Cipherwake
  // every turn (and learn what the status line refers to), then nudge to
  // the command. Dim so it doesn't dominate.
  process.stdout.write(
    c(C.dim, "◆ Cipherwake · no scan yet — ") + c(C.cyan, "npx pqcheck <domain> --ai")
  );
  process.exit(0);
}

const {
  domain, score, grade, ship_decision, written_at, max_severity, unreachable,
  // v0.16.4 — preview-diff-specific fields for the 4-line render
  kind, delta_count, diff_no_change, sector_ranking, verified_signal_categories, last_changed,
  // v0.16.11 — top finding ID so REVIEW/BLOCK lines say WHAT'S WRONG
  // inline. Without this, the customer sees "⚠ REVIEW" with no cause and
  // has to run a separate `pqcheck deploy-check --ai` to find out why.
  top_issue,
} = state;
const age = ageHours(written_at);

if (age > STALE_THRESHOLD_HOURS) {
  // Stale = the cached check is too old to anchor a deploy on. Use ◌
  // (dotted circle) to signal "needs refresh" without alarming. Stays
  // muted so an old check doesn't pretend to be active state.
  process.stdout.write(
    c(C.dim, `◆ Cipherwake · ${domain || "—"} ◌ STALE · last checked ${formatAge(written_at)} — `) +
      c(C.cyan, `npx pqcheck ${domain || "<domain>"} --ai`)
  );
  process.exit(0);
}

// v0.16.6 — Single-line canonical format for ALL scan kinds. Prior versions
// rendered a 4-line "high-yield block" for preview-diff state, but it's
// overkill: the persistent statusline is read at-a-glance, not as a report.
// One line that answers 4 questions:
//   1. Is Cipherwake on?           → "◆ Cipherwake" anchor
//   2. Which domain is it watching? → cleaned hostname
//   3. Is the latest state good?    → ✓ PASS / ⚠ REVIEW / ⛔ BLOCK
//   4. How fresh is the signal?     → "12m ago"
//
// Example: ◆ Cipherwake · quantasyte.com ✓ PASS · DBR 4.7 C · stable 14d · 12m ago

// Vercel preview URLs aren't useful in the statusline — extract the project
// name when the domain field is one. Otherwise return the domain unchanged.
function cleanDomain(d) {
  if (!d) return "—";
  // Strip protocol if any leaked through.
  let s = d.replace(/^https?:\/\//, "").replace(/\/$/, "");
  // Vercel preview hostnames: <project>-<hash>-<org>.vercel.app
  // Reduce to just <project> so the customer sees "back-in-play" not
  // "back-in-play-30aoyitmn-michaels-projects-0b2351fa.vercel.app".
  const vercel = s.match(/^([a-z0-9][a-z0-9-]*?)(?:-[a-z0-9]{6,})+-[a-z0-9-]+\.vercel\.app$/i);
  if (vercel) return vercel[1] + " (preview)";
  return s;
}
const displayDomain = cleanDomain(domain);

const isUnreachable = !!unreachable;
const symbolByDecision = { pass: "✓", review: "⚠", block: "⛔" };
const colorByDecision = { pass: C.green, review: C.yellow, block: C.red };
const symbol = isUnreachable ? "⊘" : (symbolByDecision[ship_decision] || "·");
const cdec = isUnreachable ? C.red : (colorByDecision[ship_decision] || C.dim);
const labelWord = isUnreachable
  ? "UNREACHABLE"
  : (ship_decision || "—").toUpperCase();

// When unreachable, suppress DBR/severity trailing segments — they aren't
// meaningful (no score was computed) and would clutter the line.
const dbrSegment = (!isUnreachable && typeof score === "number")
  ? ` · DBR ${score.toFixed(1)}${grade ? " " + grade : ""}`
  : "";
// Severity is redundant with the PASS/REVIEW/BLOCK glyph (v0.16.6 dropped it
// from the default render). Keep variable for future use but omit from line.
const sevSegment = "";

// Drift narrative suffix. Sourced from lastChanged (preview-diff state uses
// last_changed; scan state uses state.lastChanged). "stable 14d" / "drifted Xd".
const stabilitySource = last_changed || state.lastChanged;
let stabilitySegment = "";
if (!isUnreachable && stabilitySource) {
  const dms = Date.now() - new Date(stabilitySource).getTime();
  const days = Math.floor(dms / 86400000);
  if (days <= 0) stabilitySegment = " · drifted today";
  else if (days < 7) stabilitySegment = ` · drifted ${days}d ago`;
  else stabilitySegment = ` · stable ${days}d`;
}

// v0.16.11 — terse human label for the top_issue finding ID. Only rendered
// when ship_decision is review or block (the cases where the customer needs
// to know WHY without running another command). Mapping covers the
// finding IDs from lib/findingRegistry.ts that drive verdicts; for unknown
// IDs, derive a fallback by taking the last dotted segment and replacing
// underscores with spaces. "as few words as possible" — typical render is
// 2-4 words; never more than ~30 chars.
const TOP_ISSUE_LABELS = {
  "chain.weakest_link.intermediate": "weak intermediate cert",
  "chain.weakest_link.root":         "weak root cert",
  "tls.ecdhe_only_quantum_vulnerable": "quantum-vulnerable kex",
  "tls.pqc_test_inconclusive_scanner_limit": "PQC test inconclusive",
  "tls.rsa_kex_only":                "RSA kex only",
  "tls.rsa_kex_fallback":            "RSA fallback",
  "tls.rsa_kex_accepted_legacy":     "RSA kex accepted",
  "tls.version_obsolete":            "obsolete TLS",
  "tls.domain_unreachable":          "unreachable",
  "email.spf.missing":               "no SPF",
  "email.dmarc.missing":             "no DMARC",
  "email.dkim.missing":              "no DKIM",
};
function topIssueLabel(id) {
  if (!id || id === "none") return null;
  if (TOP_ISSUE_LABELS[id]) return TOP_ISSUE_LABELS[id];
  // Fallback: last dotted segment, underscores → spaces, cap 30 chars.
  const tail = String(id).split(".").pop() || id;
  return tail.replace(/_/g, " ").slice(0, 30);
}
const issueSegment = (!isUnreachable && (ship_decision === "review" || ship_decision === "block"))
  ? (() => {
      const label = topIssueLabel(top_issue);
      return label ? ` · ${label}` : "";
    })()
  : "";

process.stdout.write(
  c(cdec, "◆") +
    " " +
    c(C.bold, "Cipherwake") +
    " " +
    c(C.dim, "·") +
    " " +
    c(C.bold, displayDomain) +
    " " +
    c(cdec, `${symbol} ${labelWord}${issueSegment}`) +
    c(C.dim, `${dbrSegment}${stabilitySegment} · ${formatAge(written_at)}`)
);
