#!/usr/bin/env node
// =============================================================================
// cipherwake-chat-hook — Claude Code PostToolUse hook
// =============================================================================
// Reads stdin (tool event JSON from Claude Code), checks if the tool was a
// pqcheck-related Bash command, reads the latest scan state, emits a
// systemMessage to Claude Code chat.
//
// Wire it up by adding to ~/.claude/settings.json:
//
//   "hooks": {
//     "PostToolUse": [{
//       "matcher": "Bash",
//       "hooks": [{
//         "type": "command",
//         "command": "npx cipherwake-chat-hook"
//       }]
//     }]
//   }
//
// `pqcheck setup --auto` does this for you (idempotently, merging with any
// existing hook configs per CLAUDE.md Rule 17).
//
// Behavior:
//   * Only emits a message if the tool was Bash + the command invoked pqcheck
//   * Only emits if last-scan.json was updated within the last 60s (i.e. this
//     pqcheck invocation actually changed state) — avoids spamming chat for
//     stale state
//   * Single line output for status-bar-style readability
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Hooks receive event JSON on stdin. If missing / malformed, exit silently.
let toolEvent;
try {
  toolEvent = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}

// Only react to Bash tool uses that invoked pqcheck or cipherwake-statusline.
if (toolEvent?.tool_name !== "Bash") {
  process.exit(0);
}
const command = String(toolEvent.tool_input?.command || "");
const isPqcheck =
  /\bpqcheck\b/.test(command) ||
  /\bcipherwake-statusline\b/.test(command);
if (!isPqcheck) {
  process.exit(0);
}

// Read the last-scan state. If missing, exit silently.
let state;
try {
  state = JSON.parse(
    readFileSync(join(homedir(), ".config", "cipherwake", "last-scan.json"), "utf8"),
  );
} catch {
  process.exit(0);
}

// Only emit if the state was updated recently (<60s). Otherwise we'd narrate
// stale state on every unrelated Bash command, which would be obnoxious.
const writtenAt = new Date(state.written_at).getTime();
if (!Number.isFinite(writtenAt)) process.exit(0);
if (Date.now() - writtenAt > 60_000) process.exit(0);

const sd = state.ship_decision || "—";
const emoji = sd === "pass" ? "✓" : sd === "block" ? "✗" : "⚠";

const parts = [`◆ Cipherwake: ${emoji} ${state.domain} ship_decision=${sd}`];
if (typeof state.score === "number") parts.push(`DBR ${state.score.toFixed(1)}${state.grade ? " " + state.grade : ""}`);
if (state.max_severity && state.max_severity !== "none") parts.push(String(state.max_severity).toUpperCase());
if (state.top_issue && state.top_issue !== "none") parts.push(`top: ${state.top_issue}`);

const message = parts.join(" · ");

// Output JSON to stdout — Claude Code reads the `systemMessage` field and
// displays it to the user in the chat scrollback.
process.stdout.write(
  JSON.stringify({
    systemMessage: message,
    suppressOutput: true,
  }),
);
process.exit(0);
