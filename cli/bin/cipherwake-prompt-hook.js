#!/usr/bin/env node
// =============================================================================
// cipherwake-prompt-hook — Claude Code UserPromptSubmit hook (v0.15.1 parity)
// =============================================================================
// Fires BEFORE Claude responds to every user prompt. Injects the latest scan
// state from ~/.config/cipherwake/last-scan.json into Claude's context, so
// the AI sees ship_decision proactively (e.g., when the user says "ok deploy
// this", Claude already knows the trust posture).
//
// Different timing from cipherwake-chat-hook (PostToolUse Bash) — that one
// fires AFTER a tool runs and pushes a chat message reactively. This one
// fires BEFORE the model thinks, by injecting additionalContext via the
// hookSpecificOutput shape.
//
// Silent (no injection) when:
//   • state file missing
//   • state file > 24h old (don't anchor on stale data)
//   • ship_decision === "pass" (no need to spam the model with good news)
//
// Wire-up via `pqcheck setup --auto` writes the entry to
// ~/.claude/settings.json under `hooks.UserPromptSubmit`.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const STATE_FILE = process.env.CIPHERWAKE_STATE_FILE
  || join(homedir(), ".config", "cipherwake", "last-scan.json");

const MAX_STATE_AGE_MS = 24 * 60 * 60 * 1000; // 24h — older than this, don't inject

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    // If no stdin (manual invocation), resolve empty immediately
    if (process.stdin.isTTY) resolve("");
  });
}

function silent() {
  // Output nothing — Claude Code treats empty output as "no injection".
  process.exit(0);
}

async function main() {
  // Drain stdin (Claude Code sends a JSON event payload). We don't actually
  // need the event content here — we just decide based on cached state.
  try { await readStdin(); } catch { /* ignore */ }

  let state;
  try {
    state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    silent();
    return;
  }

  // Freshness: only inject if the last scan is recent. Anchoring Claude on
  // a week-old REVIEW state would be misleading after the user has likely
  // already fixed the issue.
  const writtenAt = state.written_at ? new Date(state.written_at).getTime() : 0;
  if (!writtenAt || Date.now() - writtenAt > MAX_STATE_AGE_MS) {
    silent();
    return;
  }

  // Only inject for non-pass states. Don't spam the model with good news on
  // every prompt — Claude already trusts that no news is good news.
  const shipDecision = String(state.ship_decision || "").toLowerCase();
  if (shipDecision !== "review" && shipDecision !== "block") {
    silent();
    return;
  }

  const emoji = shipDecision === "block" ? "⛔" : "⚠";
  const sevLabel = shipDecision === "block" ? "BLOCK" : "REVIEW";
  const dbr = typeof state.score === "number" ? state.score.toFixed(1) : "?";
  const grade = state.grade || "?";
  const maxSev = String(state.max_severity || "").toUpperCase();
  const top = state.top_issue || "—";
  const ago = Math.floor((Date.now() - writtenAt) / 60000);
  const ageStr = ago < 1 ? "just now" : ago < 60 ? `${ago}m ago` : `${Math.floor(ago / 60)}h ago`;

  // Build the context-injection block. Brevity matters — this lands in every
  // user prompt's context, so it should be a one-paragraph reminder, not a
  // multi-screen status report.
  const additionalContext =
    `${emoji} Cipherwake — latest scan of ${state.domain || "configured domain"}: ship_decision=${shipDecision} ` +
    `(${sevLabel}, DBR ${dbr} ${grade}, max ${maxSev}, last scanned ${ageStr}). ` +
    `Top issue: ${top}. ` +
    `Before announcing a deploy, run \`npx pqcheck deploy-check ${state.domain || "<domain>"} --ai\` to refresh. ` +
    `If ship_decision is still ${shipDecision}, surface the change to the user per the AI Coder Protocol ` +
    `(https://cipherwake.io/methodology/ai-coder-protocol) — don't auto-announce.`;

  // Claude Code's UserPromptSubmit hook accepts hookSpecificOutput.additionalContext
  // which is injected into the model's input on this turn. The hook returns
  // synchronously; suppressOutput hides anything on stdout from the UI.
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext,
    },
    suppressOutput: true,
  }));
}

main().catch(() => silent());
