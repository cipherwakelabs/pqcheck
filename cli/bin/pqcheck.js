#!/usr/bin/env node
// =============================================================================
// pqcheck CLI — npx pqcheck <domain>
// =============================================================================
// Tiny wrapper around the public scan API at cipherwake.io.
// Zero deps (uses node:fetch). Works under `npx pqcheck` without installation.
// =============================================================================

// R74-confirm BLOCKING #5 (GPT 2026-05-22): Node version startup guard.
// Native fetch requires Node 18+. Without this guard, pre-Node-18 users see
// "fetch is not defined" at runtime — confusing because package.json `engines`
// is not enforced by npm/npx. Fail loud + actionable.
(() => {
  const major = Number((process.versions.node || "0").split(".")[0]);
  if (Number.isFinite(major) && major < 18) {
    process.stderr.write(
      `\n  ✗ pqcheck requires Node 18 or newer (you have ${process.versions.node}).\n` +
      `    Native fetch is unavailable on this version.\n` +
      `    Install Node 18+ from https://nodejs.org or use nvm: \`nvm install 18 && nvm use 18\`\n` +
      `    Then retry: \`npx pqcheck <domain>\`\n\n`
    );
    process.exit(1);
  }
})();

const API_BASE = process.env.PQCHECK_API_BASE || "https://cipherwake.io";
const VERSION = "0.16.15";

// v0.16.15 — attribution suffix. When the CLI runs inside GitHub Actions
// (GH sets GITHUB_ACTIONS=true automatically in every step) we append
// "(pqcheck-action)" to the User-Agent so the server-side classifier
// (lib/events.ts) buckets the call as `action` rather than `cli`. Lets
// the analytics dashboard split humans/CI invocations cleanly.
//
// No new data is collected — the User-Agent string was already being
// sent on every call; this is a labeling change.
//
// Opt out via PQCHECK_DISABLE_ACTION_ATTRIBUTION=1 (UA stays plain
// `pqcheck-cli/X.Y.Z` even under GitHub Actions). The env var is only
// honored when GITHUB_ACTIONS=true — it does nothing in other contexts.
const CI_ACTION_SUFFIX =
  process.env.GITHUB_ACTIONS === "true" &&
  process.env.PQCHECK_DISABLE_ACTION_ATTRIBUTION !== "1"
    ? " (pqcheck-action)"
    : "";

// API-key support — paid tier (Founder Pro $19.99/mo launch pricing, locked while sub active) gets
// per-account monthly quotas instead of the per-IP rate limit. Set via:
//   export CIPHERWAKE_API_KEY=qpk_<32-hex>
// Anonymous CLI use still works (no env var → falls back to IP rate limit).
//
// Removed QUANTAPACT_API_KEY backwards-compat fallback 2026-05-22.
// Pre-launch, no customers had it set in production — no break.
const QP_API_KEY = (process.env.CIPHERWAKE_API_KEY || "").trim();

// Builds headers with optional Authorization. Use for every CLI → API call
// so a single env-var toggle authenticates every endpoint at once.
function apiHeaders(extra = {}) {
  const h = { accept: "application/json", "user-agent": `pqcheck-cli/${VERSION}${CI_ACTION_SUFFIX}`, ...extra };
  if (QP_API_KEY) h.authorization = `Bearer ${QP_API_KEY}`;
  return h;
}

// Helpful messaging when the server tells us auth/quota failed.
async function handleAuthError(resp) {
  if (resp.status === 401) {
    const body = await safeJSON(resp);
    if (body?.error === "invalid_api_key") {
      console.error(color("red", "CIPHERWAKE_API_KEY is invalid or revoked. Check https://cipherwake.io/account to rotate."));
      return true;
    }
  }
  if (resp.status === 429) {
    const body = await safeJSON(resp);
    if (body?.error === "monthly_quota_exceeded") {
      console.error(color("red", `Monthly quota exceeded${body.detail ? ` — ${body.detail}` : ""}. Upgrade tier at https://cipherwake.io/pricing or wait until the 1st.`));
      return true;
    }
  }
  return false;
}

const ANSI = {
  reset:   "\x1b[0m",
  bold:    "\x1b[1m",
  dim:     "\x1b[2m",
  red:     "\x1b[31m",
  green:   "\x1b[32m",
  yellow:  "\x1b[33m",
  violet:  "\x1b[35m",
  cyan:    "\x1b[36m",
};
const supportsColor = process.stdout.isTTY && process.env.TERM !== "dumb";
const color = (c, s) => (supportsColor ? `${ANSI[c]}${s}${ANSI.reset}` : s);

async function main() {
  const args = process.argv.slice(2);

  // No-args entry: show a layman's quick-start before the full usage block.
  // Behavior: argv.length === 0 prints the friendly intro then usage and exits 1.
  // --help / -h prints only usage (no intro) and exits 0.
  if (args.length === 0) {
    printQuickStart();
    printUsage();
    process.exit(1);
  }
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }
  if (args.includes("--version") || args.includes("-v")) {
    console.log(`pqcheck ${VERSION}`);
    process.exit(0);
  }

  // v0.16.13: opportunistic update-check banner. Reads cached registry
  // result from disk and prints a one-line stderr banner if a newer
  // version is published; refreshes the cache in the background for next
  // time. Never blocks the command. See maybeShowVersionBanner() for the
  // full rationale (TL;DR: prevents the npx-cached-stale-version trap
  // that caused 0.7.0 to silently run for months on existing users).
  // Awaited so the banner appears BEFORE the command output for visibility,
  // but it only reads a tiny file (no network on hot path).
  await maybeShowVersionBanner(args);

  // Subcommand dispatch.
  if (args[0] === "lock") {
    return runLockCommand(args.slice(1));
  }
  if (args[0] === "deps") {
    return runDepsCommand(args.slice(1));
  }
  if (args[0] === "diff") {
    return runDiffCommand(args.slice(1));
  }
  if (args[0] === "trust-diff") {
    // CLI v0.11.0 (locked 2026-05-16): new subcommand that calls /api/trust-diff
    // and outputs verdict in selected format. Designed for CI use via the
    // cipherwakelabs/pqcheck Action mode: trust-diff.
    return runTrustDiffCommand(args.slice(1));
  }
  if (args[0] === "preview-diff") {
    // CLI v0.14.0 (locked 2026-05-19): preview deployment vs production diff.
    // Calls /api/preview-diff with two URLs and reports application-surface
    // changes (new third-party scripts, header regressions, score drops).
    return runPreviewDiffCommand(args.slice(1));
  }
  if (args[0] === "guards") {
    // CLI v0.16.9 (2026-05-23, R80, EXPERIMENTAL): Site Guards beta.
    // Subcommands manage `.cipherwake/guards.json` and run guards against a URL.
    return runGuardsCommand(args.slice(1));
  }
  if (args[0] === "history") {
    return runHistoryCommand(args.slice(1));
  }
  if (args[0] === "changes") {
    return runChangesCommand(args.slice(1));
  }
  if (args[0] === "cert") {
    return runCertCommand(args.slice(1));
  }
  if (args[0] === "watch") {
    return runWatchCommand(args.slice(1));
  }
  if (args[0] === "release-checklist") {
    return runReleaseChecklistCommand(args.slice(1));
  }
  if (args[0] === "init") {
    return runInitCommand(args.slice(1));
  }
  if (args[0] === "deploy-check") {
    return runDeployCheckCommand(args.slice(1));
  }
  if (args[0] === "vendors") {
    return runVendorsCommand(args.slice(1));
  }
  if (args[0] === "onboard") {
    return runOnboardCommand(args.slice(1));
  }
  if (args[0] === "guard") {
    // CLI v0.15.0 — `pqcheck guard --domain X -- <deploy command>`.
    // Wraps any deploy command: runs deploy-check first, conditionally
    // executes the deploy command based on ship_decision. The strongest
    // single artifact for terminal-first AI-coder workflows because the
    // AI doesn't have to remember two commands.
    return runGuardCommand(args.slice(1));
  }
  if (args[0] === "protocol") {
    // CLI v0.15.0 — `pqcheck protocol install` opt-in installer with
    // Rule 17 consent flow. Adds the AI Coder Protocol to ~/.claude/CLAUDE.md
    // / .cursorrules (with auto/manual/no consent). Never silent.
    return runProtocolCommand(args.slice(1));
  }
  if (args[0] === "setup") {
    // CLI v0.15.0 — `pqcheck setup --auto --domain <D>` consolidated installer.
    // One command installs everything: GitHub Action workflow, AI Coder
    // Protocol across detected rules files, git pre-push hook, and
    // statusline config. The launch-story command for AI-coder workflows
    // ("one command sets you up across every AI coder").
    return runSetupCommand(args.slice(1));
  }
  if (args[0] === "debug-network" || args.includes("--debug-network")) {
    // R74-confirm SHIP #14-15 (GPT 2026-05-22): probe connectivity to every
    // upstream Cipherwake depends on + report which ones are reachable.
    // Customer-facing diagnostic for "the scan hung" / "command-not-found"
    // / "corporate proxy" / "VPN-blocked" failure modes — instead of leaving
    // them to guess, surface the actual broken hop.
    return runDebugNetworkCommand();
  }

  // Multi-domain support: positional args are domains.
  // --file reads additional domains from a newline-delimited file.
  const fileFlagIdx = args.indexOf("--file");
  let fileDomains = [];
  if (fileFlagIdx >= 0) {
    const filePath = args[fileFlagIdx + 1];
    if (!filePath) {
      console.error(color("red", "error: --file requires a path argument"));
      process.exit(1);
    }
    try {
      const fs = await import("node:fs/promises");
      const raw = await fs.readFile(filePath, "utf8");
      fileDomains = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    } catch (err) {
      console.error(color("red", `error reading --file ${filePath}: ${err.message}`));
      process.exit(1);
    }
  }

  const positional = args.filter((a) => !a.startsWith("-") && !isFlagValue(args, a));
  const domains = [...positional, ...fileDomains]
    .map((a) => normalizeDomain(a))
    .filter((d) => !!d);

  if (domains.length === 0) {
    console.error(color("red", "error: no domain provided"));
    printUsage();
    process.exit(1);
  }

  const quiet = args.includes("--quiet") || args.includes("-q");
  const format = parseFormat(args);
  const threshold = parseThreshold(args);
  const watchInterval = parseWatch(args);
  const webhookUrl = parseWebhook(args);

  if (threshold === "invalid") {
    console.error(color("red", "error: --threshold requires a number 0-10"));
    process.exit(1);
  }
  if (watchInterval === "invalid") {
    console.error(color("red", "error: --watch requires a positive number of seconds (default 300 if no value given)"));
    process.exit(1);
  }
  if (webhookUrl === "invalid") {
    console.error(color("red", "error: --webhook requires a URL starting with http:// or https://"));
    process.exit(1);
  }

  // Watch mode loop: scan, diff, optionally webhook, repeat.
  if (watchInterval !== null) {
    await runWatch({ domains, format, quiet, threshold, webhookUrl, intervalSec: watchInterval });
    return; // runWatch handles its own exit; in practice it runs until killed.
  }

  // --fresh: bypass server cache, force a fresh scan. Useful when verifying
  // a cert/key change you just deployed. Subject to a 20/hr per-IP cap on
  // the server side.
  const fresh = args.includes("--fresh") || args.includes("--force");
  const aiMode = parseAiMode(args);
  const verbose = isVerboseMode(args);  // v0.16.0 — opt-in detailed panel

  // One-shot scan(s)
  let worstExit = 0;
  for (const domain of domains) {
    const exit = await runOneScan({ domain, format, quiet, threshold, webhookUrl, multi: domains.length > 1, fresh, aiMode, verbose });
    if (exit > worstExit) worstExit = exit;
  }
  process.exit(worstExit);
}

async function runOneScan({ domain, format, quiet, threshold, webhookUrl, multi, fresh, aiMode, verbose }) {
  if (!quiet && format === "text") process.stderr.write(color("dim", `Scanning ${domain}${fresh ? " (forcing fresh)" : ""} ...`));
  let report;
  try {
    // --fresh appends ?force=1 to bypass the smart-cache. Use when verifying
    // a cert/key change you just deployed — otherwise scans hit the 1h SWR
    // cache and return up-to-1h-old data. Subject to a 20/hr per-IP cap on
    // the server side; if exceeded, the server silently downgrades to a
    // cached scan and returns that instead of erroring.
    const qs = fresh ? `?domain=${encodeURIComponent(domain)}&force=1` : `?domain=${encodeURIComponent(domain)}`;
    const resp = await fetch(`${API_BASE}/api/scan${qs}`, {
      method: "GET",
      headers: apiHeaders({ "user-agent": `pqcheck-cli/${VERSION}${CI_ACTION_SUFFIX} (scan)` }),
    });
    if (!quiet && format === "text") process.stderr.write("\r\x1b[K");
    if (!resp.ok) {
      const errBody = await safeJSON(resp);
      // Friendly per-status messages so customers see actionable guidance
      // instead of "error scanning X: 429 rate_limit_exceeded" raw HTTP
      // verbiage. Batch users scripting many scans in a row hit this hardest
      // — surface what they should do (wait + retry, or upgrade) rather than
      // leaving them to guess.
      if (resp.status === 429) {
        const retryAfter = resp.headers.get("retry-after");
        const waitMsg = retryAfter ? `Wait ${retryAfter}s then retry.` : "Wait ~60s then retry.";
        console.error(color("yellow", `⚠ Rate limit hit on ${domain} — too many scans from this IP in the current window.`));
        console.error(color("dim", `  ${waitMsg} For higher limits, get an account: ${API_BASE}/account`));
        if (errBody?.need_more?.feedback_url) {
          console.error(color("dim", `  Need much higher throughput? ${errBody.need_more.feedback_url}`));
        }
      } else if (resp.status >= 500) {
        console.error(color("red", `error scanning ${domain}: Cipherwake's scanner hit a transient issue (HTTP ${resp.status}).`));
        console.error(color("dim", `  Retry in ~1 minute. If it keeps happening, report at ${API_BASE}/feedback (include the domain + timestamp).`));
        if (errBody?.detail) console.error(color("dim", `  Detail: ${errBody.detail}`));
      } else if (resp.status === 400) {
        // Most 400s on /api/scan are "invalid domain" — typically the
        // customer typed a URL with a path or used localhost. The
        // server already returns a clear message; just present it
        // without raw HTTP noise.
        console.error(color("red", `error scanning ${domain}: ${errBody?.error || resp.statusText}`));
        if (errBody?.detail) console.error(color("dim", `  ${errBody.detail}`));
        console.error(color("dim", `  Cipherwake only scans public domains. URLs with paths, IPs, and \`localhost\` aren't supported.`));
      } else {
        console.error(color("red", `error scanning ${domain}: ${resp.status} ${errBody?.error || resp.statusText}`));
        if (errBody?.detail) console.error(color("dim", errBody.detail));
      }
      return 1;
    }
    report = await resp.json();
  } catch (err) {
    if (!quiet && format === "text") process.stderr.write("\r\x1b[K");
    console.error(color("red", `error scanning ${domain}: ${err.message}`));
    return 1;
  }

  // Webhook delivery — fire-and-forget POST with JSON body
  if (webhookUrl) {
    fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": `pqcheck-cli/${VERSION}${CI_ACTION_SUFFIX}` },
      body: JSON.stringify({ domain, report, source: "pqcheck-cli", at: new Date().toISOString() }),
    }).catch(() => { /* best-effort — never fail the scan on webhook delivery */ });
  }

  // In --quiet mode the score still goes to stdout (script-pipeable), but a
  // degraded warning lands on stderr so silent fallback to cached data can't
  // mislead a CI gate or one-off check.
  if (quiet && report._meta?.degraded) {
    console.error(`pqcheck: ⚠ ${domain} — using cached score (live probe failed: ${report._meta.degradedReason || "unknown"}; last verified ${report._meta.lastUpdated || "?"})`);
  }

  // Compute ship-decision once — needed both for AI-mode footer AND for the
  // per-user/per-repo state files that statusline/chat-hook/prompt-hook read.
  // State files must update on every successful scan, regardless of --ai, so
  // downstream agents see the same scan the human just ran.
  const findings = Array.isArray(report.findings) ? report.findings : [];
  const maxSev = highestSeverity(findings);
  let shipDecision = computeShipDecision({ maxSeverity: maxSev });
  const topFinding = [...findings].sort((a, b) => severityRank(b.severity) - severityRank(a.severity))[0];

  // Unreachable / degraded → force "block". A scan that couldn't actually
  // reach the domain (no DNS, TLS handshake failed, deploy hadn't propagated
  // yet, typo in the domain) is categorically different from "trust drift
  // detected" — we couldn't evaluate the trust surface AT ALL. "review"
  // would be too soft (the AI agent might shrug and ship); "block" properly
  // halts announcement per the AI Coder Protocol until the human confirms
  // the unreachability was expected (e.g., they know DNS is still
  // propagating) or fixes the deploy. This matches the protocol's "STOP,
  // wait for explicit override" routing.
  // Treat as "cannot evaluate" — and route through the UNREACHABLE label —
  // when either:
  //   • reachable === false  (no TCP/TLS handshake at all)
  //   • scanAvailable === false  (TCP/TLS up, but scan couldn't produce a
  //     coherent fingerprint — e.g. medium.com churning vendor scripts
  //     faster than our dual-fingerprint check)
  //
  // _meta.degraded alone is too broad (fires on cache fallback + mid-scan
  // state changes on otherwise-scoreable domains like stripe.com), so we
  // narrow to the structured failure signals the server emits.
  const unreachable = report?.reachable === false || report?.scanAvailable === false;
  if (unreachable) {
    shipDecision = "block";
  }

  // Capture reachability AFTER ship_decision override so state files reflect
  // the truth: ship_decision=block + unreachable=true means "we couldn't
  // reach it, treat as block." Downstream surfaces (statusline / VS Code
  // extension / AI banner) display the "UNREACHABLE" label when
  // unreachable=true instead of the generic "BLOCK" — more informative,
  // same protocol routing.
  await writeLastScanFile({
    domain,
    kind: "scan",
    score: typeof report.score === "number" ? report.score : null,
    grade: report.grade || null,
    max_severity: maxSev,
    ship_decision: shipDecision,
    unreachable: unreachable || false,
    top_issue: topFinding?.id || topFinding?.title || null,
  });

  // AI Coder Mode — three-layer output for Claude Code / Cursor / Aider.
  // Overrides --format when --ai is set; emits the structured block at the
  // bottom so downstream agents can parse ship_decision deterministically.
  if (aiMode) {
    let topIssue, whyMatters, nextActions;
    if (unreachable) {
      const isUnstable = report?.reason === "scan_unstable";
      topIssue = isUnstable
        ? "[REACHABILITY] Scan unstable — site changing faster than we can scan it"
        : "[REACHABILITY] Domain unreachable — TLS probe failed or DNS unresolved";
      whyMatters = report?.userMessage || report?._meta?.degradedReason || (isUnstable
        ? "The scanner reached the site but couldn't produce a coherent fingerprint — rolling deploy, rapid A/B variation, or fast vendor-script rotation. Retry usually succeeds once the site settles."
        : "The scanner couldn't reach the domain on port 443. Either DNS hasn't propagated, the deploy hasn't completed, or this domain isn't deployed at the address we expected.");
      nextActions = isUnstable
        ? [
            `Wait ~1 minute then retry: npx pqcheck deploy-check ${domain} --ai`,
            `View full report (last successful scan): ${API_BASE}/r/${domain}`,
          ]
        : [
            `Check the domain is correct (typo?): ${domain}`,
            `Verify DNS: dig +short ${domain}`,
            `Verify deploy completed and TLS is live on https://${domain}`,
            `Re-run after fix: npx pqcheck deploy-check ${domain} --ai`,
          ];
    } else {
      topIssue = topFinding
        ? `[${String(topFinding.severity || "").toUpperCase()}] ${topFinding.title || topFinding.detail || "finding"}`
        : "No findings at or above LOW severity.";
      whyMatters = topFinding?.detail || "DBR scoring measures harvest-now-decrypt-later risk. Findings reflect public-surface signals only.";
      nextActions = shipDecision === "pass"
        ? [`Domain looks healthy. View full report: ${API_BASE}/r/${domain}`]
        : [
            `Review finding above and decide if it was intentional.`,
            `View full report: ${API_BASE}/r/${domain}`,
            `Re-scan with --fresh after fix: npx pqcheck ${domain} --fresh --ai`,
          ];
    }

    // v0.16.0 high-yield rendering. Old layout was: banner + body + footer.
    // New layout: brand header → decision pulse → alerts (if any) → trust
    // posture → verified-signals summary → (verbose body if --verbose) →
    // AI footer block. The structured footer is always last so downstream
    // agents can parse ship_decision regardless of the verbose flag.
    const highSevFindings = findings.filter((f) => severityRank(f.severity) >= 3);
    const alertCount = highSevFindings.length;

    console.log("");
    console.log(formatBrandHeader(domain));
    console.log("");
    console.log(formatDecisionPulse({ shipDecision, alertCount, unreachable, diffContext: false }));

    if (unreachable) {
      // Unreachable path: surface the friendly explanation + next actions
      // immediately (no "verified signals" block — there's nothing to
      // verify if we couldn't reach the site).
      console.log(formatAiBody({ topIssue, whyMatters, nextActions }));
    } else {
      // Alerts above trust posture so the actionable change is first.
      if (alertCount > 0) {
        const alerts = formatAlertsLine(highSevFindings);
        if (alerts) console.log(alerts);
      }
      const tpl = formatTrustPostureLine(report);
      if (tpl) console.log(tpl);
      const vsl = formatVerifiedSignalsLine(report);
      if (vsl) console.log(vsl);
      if (verbose) {
        console.log("");
        console.log(formatHighYieldVerbose(report));
      } else {
        console.log(color("dim", "  Run with --verbose to see all verified signals."));
      }
    }

    console.log(formatAiFooterBlock({
      status: shipDecision,
      domain,
      kind: "scan",
      dbr: typeof report.score === "number" ? report.score.toFixed(1) : "",
      grade: report.grade || "",
      max_severity: maxSev,
      ship_decision: shipDecision,
      unreachable: unreachable ? "true" : "false",
      top_issue: topFinding?.id || topFinding?.title || "none",
      findings_high: findings.filter((f) => severityRank(f.severity) === 3).length,
      findings_critical: findings.filter((f) => severityRank(f.severity) === 4).length,
      scanned_at: new Date().toISOString(),
      advisory_only: "true",
    }));
    console.log("");

    // Threshold check still applies under --ai (script-pipeable). Otherwise
    // exit code reflects ship_decision so the caller can route on it.
    if (threshold !== null && typeof report.score === "number" && report.score >= threshold) {
      return 2;
    }
    return shipDecisionExitCode(shipDecision);
  }

  // Output dispatch
  if (quiet) {
    if (multi) {
      console.log(`${domain}\t${typeof report.score === "number" ? report.score : ""}`);
    } else {
      console.log(typeof report.score === "number" ? report.score : "");
    }
  } else if (format === "json") {
    if (multi) {
      // Per-line NDJSON when scanning multiple domains so output is pipe-friendly
      console.log(JSON.stringify(report));
    } else {
      console.log(JSON.stringify(report, null, 2));
    }
  } else if (format === "csv") {
    if (multi && this && !this.csvHeaderPrinted) {
      // Header only once, before first row
    }
    printCsvRow(report);
  } else if (format === "markdown") {
    printMarkdown(report, multi);
  } else if (format === "sarif") {
    console.log(JSON.stringify(reportToSarif(report), null, 2));
  } else if (format === "gh-action") {
    printGitHubActionAnnotations(report);
  } else {
    if (multi) console.log(color("dim", `\n──── ${domain} ────`));
    printReport(report);
  }

  if (threshold !== null && typeof report.score === "number" && report.score >= threshold) {
    if (!quiet && format === "text") {
      console.error(color("red", `threshold breach: ${domain} score ${report.score} >= ${threshold}`));
    }
    return 2;
  }
  return 0;
}

async function runWatch({ domains, format, quiet, threshold, webhookUrl, intervalSec }) {
  const previous = new Map(); // domain → previous score
  if (!quiet && format === "text") {
    console.error(color("dim", `Watching ${domains.length} domain(s), polling every ${intervalSec}s. Ctrl-C to stop.`));
  }

  // Print CSV header once if csv mode
  if (format === "csv") printCsvHeader();

  // Trap SIGINT so we exit cleanly
  let stopped = false;
  process.on("SIGINT", () => {
    stopped = true;
    if (!quiet && format === "text") console.error(color("dim", "\nStopped."));
    process.exit(0);
  });

  while (!stopped) {
    for (const domain of domains) {
      try {
        const resp = await fetch(`${API_BASE}/api/scan?domain=${encodeURIComponent(domain)}`, {
          method: "GET",
          headers: apiHeaders({ "user-agent": `pqcheck-cli/${VERSION}${CI_ACTION_SUFFIX} (watch)` }),
        });
        if (!resp.ok) continue;
        const report = await resp.json();
        const prev = previous.get(domain);
        const changed = prev !== undefined && typeof report.score === "number" && report.score !== prev;
        previous.set(domain, report.score);

        if (changed && webhookUrl) {
          fetch(webhookUrl, {
            method: "POST",
            headers: { "content-type": "application/json", "user-agent": `pqcheck-cli/${VERSION}${CI_ACTION_SUFFIX}` },
            body: JSON.stringify({
              type: "score_changed",
              domain,
              previousScore: prev,
              newScore: report.score,
              report,
              at: new Date().toISOString(),
            }),
          }).catch(() => {});
        }

        if (format === "csv") {
          printCsvRow(report);
        } else if (format === "json") {
          console.log(JSON.stringify({ ...report, _watchPreviousScore: prev ?? null, _watchChanged: changed }));
        } else if (format === "markdown") {
          printMarkdown(report, true);
        } else {
          const stamp = new Date().toISOString().slice(11, 19);
          const degradedTag = report._meta?.degraded ? color("yellow", ` ⚠ cached (${report._meta.degradedReason || "probe failed"})`) : "";
          if (changed) {
            console.log(color("yellow", `[${stamp}] ${domain}: ${prev} → ${report.score}  (${report.scoreLabel}) ${color("yellow", "★ changed")}${degradedTag}`));
          } else if (!quiet) {
            console.log(color("dim", `[${stamp}] ${domain}: ${report.score}  (${report.scoreLabel})${degradedTag}`));
          }
        }
      } catch (err) {
        if (!quiet && format === "text") console.error(color("red", `[watch] ${domain}: ${err.message}`));
      }
    }
    await sleep(intervalSec * 1000);
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function isFlagValue(args, val) {
  // True when this arg is the value following a flag like --threshold 7 or --format json
  const idx = args.indexOf(val);
  if (idx <= 0) return false;
  const prev = args[idx - 1];
  return prev === "--threshold" || prev === "--format" || prev === "--watch" || prev === "--webhook" || prev === "--file" || prev === "-o" || prev === "--allowlist";
}

function parseFormat(args) {
  if (args.includes("--json")) return "json"; // back-compat alias
  if (args.includes("--gh-action")) return "gh-action"; // GitHub Actions annotation format
  const i = args.indexOf("--format");
  if (i === -1) return "text";
  const v = (args[i + 1] || "").toLowerCase();
  if (v === "json" || v === "csv" || v === "markdown" || v === "md" || v === "sarif" || v === "gh-action") {
    return v === "md" ? "markdown" : v;
  }
  return "text";
}

function parseThreshold(args) {
  const i = args.indexOf("--threshold");
  if (i === -1) return null;
  const raw = args[i + 1];
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 10) return "invalid";
  return n;
}

function parseWatch(args) {
  const i = args.indexOf("--watch");
  if (i === -1) return null;
  const raw = args[i + 1];
  // --watch with no value defaults to 300s (5 min)
  if (raw === undefined || raw.startsWith("-")) return 300;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 10) return "invalid";
  return n;
}

function parseWebhook(args) {
  const i = args.indexOf("--webhook");
  if (i === -1) return null;
  const raw = args[i + 1];
  if (!raw || !/^https?:\/\//.test(raw)) return "invalid";
  return raw;
}

// =============================================================================
// AI Coder Mode — `--ai` / `--agent` output
// =============================================================================
// Three-layer output designed for AI-coder workflows (Claude Code / Cursor /
// Aider / etc.) where the user can't see GitHub PR comments and the chat
// scrollback buries verbose CLI output:
//
//   Layer 1 (top banner)   — un-missable one-liner with status + ship_decision
//   Layer 2 (body)         — top finding + why it matters + next action (≤12 lines)
//   Layer 3 (footer block) — machine-readable CIPHERWAKE_AI_GUARD_RESULT block
//                            that AI agents can deterministically parse to
//                            decide pass / review / block
//
// The `ship_decision` field is advisory only — Cipherwake is a scanner, not
// an authoritative deploy-blocker. The methodology page documents this
// explicitly (Rule 1).
// =============================================================================

function parseAiMode(args) {
  return args.includes("--ai") || args.includes("--agent");
}

function severityRank(s) {
  const map = { critical: 4, high: 3, medium: 2, low: 1, info: 0, none: -1 };
  return map[String(s || "none").toLowerCase()] ?? 0;
}

function highestSeverity(findings) {
  if (!Array.isArray(findings) || findings.length === 0) return "none";
  let best = "none";
  for (const f of findings) {
    if (severityRank(f.severity) > severityRank(best)) best = f.severity;
  }
  return best;
}

// Compute ship_decision: pass | review | block.
// Used in three contexts:
//   - one-shot scan: severity-only, no diff baseline
//   - trust-diff / preview-diff: severity + diff-since-baseline
//   - deploy-check: same as trust-diff (it's an alias)
//
// Decision rules (advisory only):
//   * `block`  — critical severity present
//   * `review` — high severity OR diff introduced new high-severity OR DBR drop ≥1.0
//   * `pass`   — everything else
function computeShipDecision({ maxSeverity, hasUnexpectedDiff, scoreDelta }) {
  const sev = String(maxSeverity || "none").toLowerCase();
  if (sev === "critical") return "block";
  if (sev === "high") return "review";
  if (hasUnexpectedDiff) return "review";
  if (typeof scoreDelta === "number" && scoreDelta <= -1.0) return "review";
  return "pass";
}

function aiBannerColor(shipDecision) {
  if (shipDecision === "pass") return "green";
  if (shipDecision === "block") return "red";
  return "yellow"; // review
}

function aiStatusEmoji(shipDecision) {
  if (shipDecision === "pass") return "✓";
  if (shipDecision === "block") return "✗";
  return "⚠";
}

function formatAiBanner({ domain, kind, dbr, grade, maxSeverity, shipDecision, unreachable }) {
  // When the scanner couldn't reach the domain we render "UNREACHABLE"
  // (with a distinct ⊘ glyph) instead of the generic "BLOCK" — semantically
  // clearer for the customer: their site isn't deployed / isn't responding,
  // not that we found a critical security finding.
  //
  // Suppress DBR + severity trailing segments when unreachable: even if the
  // API returned a stale cached score on a degraded scan, surfacing it next
  // to "UNREACHABLE" reads as contradictory ("how can it score X if you
  // couldn't reach it?"). The age + banner already convey the situation.
  const isUnreachable = !!unreachable;
  const emoji = isUnreachable ? "⊘" : aiStatusEmoji(shipDecision);
  const statusWord = isUnreachable
    ? "UNREACHABLE"
    : (({ pass: "PASS", review: "REVIEW", block: "BLOCK" })[shipDecision] || "REVIEW");
  const c = aiBannerColor(isUnreachable ? "block" : shipDecision);
  const dbrSegment = (!isUnreachable && typeof dbr === "number")
    ? ` · DBR ${dbr.toFixed(1)}${grade ? " " + grade : ""}`
    : "";
  const sevSegment = (!isUnreachable && maxSeverity && maxSeverity !== "none")
    ? ` · ${String(maxSeverity).toUpperCase()}`
    : "";
  const kindSegment = (kind && kind !== "scan") ? ` · ${kind}` : "";
  return color(c, `◆ Cipherwake · ${domain} ${emoji} ${statusWord}${dbrSegment}${sevSegment}${kindSegment}`);
}

function formatAiBody({ topIssue, whyMatters, nextActions }) {
  const lines = [];
  if (topIssue) {
    lines.push("");
    lines.push(color("bold", "Top finding:"));
    lines.push(`  ${topIssue}`);
  }
  if (whyMatters) {
    lines.push("");
    lines.push(color("bold", "Why it matters:"));
    lines.push(`  ${whyMatters}`);
  }
  if (Array.isArray(nextActions) && nextActions.length > 0) {
    lines.push("");
    lines.push(color("bold", "Recommended next action:"));
    for (const a of nextActions) {
      lines.push(`  ${a}`);
    }
  }
  return lines.join("\n");
}

// Emit the machine-readable block. Keys are normalized; values are
// newline-stripped. AI agents grep between the CIPHERWAKE_AI_GUARD_RESULT
// and END_CIPHERWAKE_AI_GUARD_RESULT markers and parse key=value lines.
function formatAiFooterBlock(fields) {
  const lines = ["", "CIPHERWAKE_AI_GUARD_RESULT"];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    const safeK = String(k).replace(/[\s=]/g, "_");
    const safeV = String(v).replace(/[\r\n]+/g, " ");
    lines.push(`${safeK}=${safeV}`);
  }
  lines.push("END_CIPHERWAKE_AI_GUARD_RESULT");
  return color("dim", lines.join("\n"));
}

// v0.16.13 — fail-loud AI guard for fetch/quota/server errors during
// deploy-check. Without this, a network blip during `pqcheck deploy-check
// --ai` would print a red error to stderr and exit 3 — but the AI Coder
// Protocol relies on the CIPHERWAKE_AI_GUARD_RESULT block. Missing block =
// AI agent assumes "no signal" and may continue shipping. The fix: in AI
// mode, always emit a block with ship_decision=review and a top_issue code
// the agent can route on. Behaviour in non-AI text mode is unchanged.
function emitAiGuardReviewAndExit(args, errorDetail) {
  if (parseAiMode(args)) {
    const positional = args.filter((a) => !a.startsWith("-"));
    const domain = positional[0] || "";
    const baseline = parseFlag(args, "--baseline") || "last-scan";
    try {
      console.log("");
      console.log(formatBrandHeader(domain));
      console.log("");
      console.log(color("yellow", "  ⚠ REVIEW — Cipherwake deploy-check could not complete"));
      console.log(color("dim",    `  ${errorDetail.message}`));
      console.log(color("dim",    "  Treating as REVIEW per fail-safe policy. Do NOT announce the deploy until you manually verify or rerun the check successfully."));
      console.log(formatAiFooterBlock({
        status: "review",
        domain,
        kind: "trust-diff",
        baseline,
        verdict: "review",
        delta_count: 0,
        max_severity: "unknown",
        ship_decision: "review",
        top_issue: errorDetail.code,
        top_issue_title: errorDetail.message,
        dbr: "",
        grade: "",
        quota_used: "",
        quota_limit: "",
        scanned_at: new Date().toISOString(),
        advisory_only: "true",
        error: errorDetail.code,
      }));
      console.log("");
      // Persist the review state so the IDE statusbar reflects the failure
      // (otherwise the bar stays on the previous successful scan).
      writeLastScanFile({
        domain,
        kind: "trust-diff",
        score: null,
        grade: null,
        max_severity: "unknown",
        ship_decision: "review",
        baseline,
        delta_count: 0,
        top_issue: errorDetail.code,
        error: errorDetail.code,
      }).catch(() => { /* best-effort */ });
    } catch {
      // even error path must not throw — fall through to exit
    }
  }
  process.exit(errorDetail.exitCode ?? 3);
}

// v0.16.13 — opportunistic version check. Reads a small cache file on cold
// start; if a newer version is in cache AND we haven't already banner'd
// today, prints a banner to stderr. Separately, if cache is >24h old, fires
// off a background fetch (non-blocking) whose result lands for the NEXT
// invocation. Zero network on hot path. Skipped in machine-readable formats
// (JSON/SARIF/github) so it never pollutes scripted output. The banner
// helps users who installed via `npx pqcheck` months ago and have a stale
// version cached in ~/.npm/_npx/ that they don't know is stale.
const VERSION_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
const VERSION_REGISTRY_URL = "https://registry.npmjs.org/pqcheck";

async function maybeShowVersionBanner(args) {
  // Skip in machine-parsed output formats.
  const format = parseFlag(args, "--format");
  if (format === "json" || format === "sarif" || format === "github") return;
  // Skip if explicitly disabled (env opt-out).
  if (process.env.PQCHECK_NO_UPDATE_CHECK === "1") return;

  try {
    const os = await import("node:os");
    const path = await import("node:path");
    const fs = await import("node:fs/promises");

    const cacheDir = path.join(os.homedir(), ".config", "cipherwake");
    const cachePath = path.join(cacheDir, "version-check.json");

    let cached = null;
    try {
      cached = JSON.parse(await fs.readFile(cachePath, "utf8"));
    } catch {
      // first run or unreadable — fall through
    }

    const now = Date.now();
    const stale = !cached || !cached.checked_at || (now - cached.checked_at) > VERSION_CHECK_TTL_MS;

    // 1. If cache has a known-newer version, print banner now (synchronous,
    //    cheap, no network).
    if (cached && cached.latest && isNewerVersion(cached.latest, VERSION)) {
      const lastShownAt = cached.last_shown_at || 0;
      const showThrottleMs = 6 * 60 * 60 * 1000; // at most once per 6h
      if (now - lastShownAt > showThrottleMs) {
        process.stderr.write(
          color("yellow", `\n  ⬆ pqcheck ${cached.latest} is available `) +
          color("dim",    `(you have ${VERSION}) — run: `) +
          color("bold",   "npm i -g pqcheck@latest") +
          color("dim",    "  (or: rm -rf ~/.npm/_npx && npx pqcheck@latest ...)\n\n")
        );
        // Persist that we just shown the banner so we don't spam.
        await fs.mkdir(cacheDir, { recursive: true });
        await fs.writeFile(cachePath, JSON.stringify({ ...cached, last_shown_at: now }, null, 2));
      }
    }

    // 2. If cache is stale, fire-and-forget a registry fetch so the NEXT
    //    cold start has fresh data. Detached from the await chain so it
    //    never delays exit.
    if (stale) {
      void refreshVersionCacheInBackground(cachePath);
    }
  } catch {
    // best-effort — never break the CLI for an update check
  }
}

async function refreshVersionCacheInBackground(cachePath) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    const resp = await fetch(VERSION_REGISTRY_URL, {
      headers: { "Accept": "application/json", "User-Agent": `pqcheck-cli/${VERSION}${CI_ACTION_SUFFIX}` },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) return;
    const body = await resp.json();
    const latest = body?.["dist-tags"]?.latest;
    if (!latest) return;
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    // Preserve last_shown_at so we don't reset the throttle on every refresh.
    let prior = {};
    try { prior = JSON.parse(await fs.readFile(cachePath, "utf8")); } catch { /* none */ }
    await fs.writeFile(cachePath, JSON.stringify({
      ...prior,
      latest,
      checked_at: Date.now(),
    }, null, 2));
  } catch {
    // best-effort
  }
}

function isNewerVersion(remote, local) {
  const parse = (v) => String(v).split(".").map((n) => parseInt(n, 10) || 0);
  const [a, b, c] = parse(remote);
  const [x, y, z] = parse(local);
  if (a !== x) return a > x;
  if (b !== y) return b > y;
  return c > z;
}

// v0.16.0 — high-yield output formatters.
//
// Design (per user direction 2026-05-22): every scan should deliver
// substantive insight, but the default must stay tight (3-5 lines max) so
// running pqcheck 100 times/month doesn't feel like a mini audit every
// time. The verbose panel is opt-in via `--verbose`.
//
// Three rendering tiers:
//   1. Status line (1 line):        ◆ Cipherwake · X ✓ PASS · DBR 4.7 C · stable 14d
//   2. Default CLI (3-5 lines):     "✓ PASS · no public-surface drift detected"
//                                   "✓ Trust posture: DBR 4.7 C · top 23% in fintech · stable 14d"
//                                   "✓ Verified 8 signals · scripts, headers, cookies, cert/SPKI, ..."
//   3. Verbose (--verbose, 8+ lines): full per-signal breakdown
// =============================================================================

// Plain-English percentile copy. report.sectorRanking.percentile uses
// "100 = worst, 0 = best". Customer copy inverts to "top N%" framing.
// No cryptic p-quantiles — `p23` reads like jargon; `top 23%` is universal.
function formatPercentileCopy(percentile, sectorName) {
  if (typeof percentile !== "number" || !isFinite(percentile)) return null;
  const sector = sectorName || "industry";
  if (percentile <= 10) return `top 10% in ${sector}`;
  if (percentile <= 25) return `top 25% in ${sector}`;
  if (percentile <= 50) return `above median in ${sector}`;
  if (percentile <= 75) return `below median in ${sector}`;
  if (percentile <= 90) return `bottom 25% in ${sector}`;
  return `bottom 10% in ${sector}`;
}

// "stable 14d" / "drifted 2d ago" / "first scan" depending on report data.
// Reads from report._meta.lastChanged (smartCache populates) — if not
// available, falls back to "tracked since first scan."
function formatStabilityCopy(report) {
  const lastChanged = report?._meta?.lastChanged || report?._meta?.lastUpdated;
  if (lastChanged) {
    const ms = Date.now() - new Date(lastChanged).getTime();
    const days = Math.floor(ms / 86400000);
    if (days <= 0) return "drifted today";
    if (days < 7) return `drifted ${days}d ago`;
    return `stable ${days}d`;
  }
  return null;
}

// "✓ Trust posture: DBR 4.7 C · top 23% in fintech · stable 14d"
//   - Only includes sub-segments we have data for. If we can't compute a
//     section, we omit it rather than padding with "—" / "n/a".
function formatTrustPostureLine(report) {
  const dbr = typeof report?.score === "number" ? report.score.toFixed(1) : null;
  const grade = report?.grade || "";
  if (!dbr) return null;
  const parts = [`DBR ${dbr}${grade ? " " + grade : ""}`];
  const sr = report?.sectorRanking;
  const pctCopy = formatPercentileCopy(sr?.percentile, sr?.sectorLabel || sr?.sectorName || sr?.sector);
  if (pctCopy) parts.push(pctCopy);
  const stability = formatStabilityCopy(report);
  if (stability) parts.push(stability);
  return color("green", "✓ ") + color("bold", "Trust posture: ") + parts.join(color("dim", " · "));
}

// Count verified signals from the scan report. A "signal" is something
// Cipherwake actively checked AND would surface in a diff if it changed.
// Returns: { count, categories }.
function countVerifiedSignals(report) {
  const cats = [];
  // 1. Third-party scripts
  if (report?.publicDeps?.fetched || Array.isArray(report?.publicDeps?.thirdParties)) cats.push("scripts");
  // 2. Security headers (CSP/HSTS/XFO at minimum)
  if (report?.httpHeaders?.reachable) cats.push("headers");
  // 3. Cookies (v0.16.0 — new)
  if (report?.cookies?.reachable) cats.push("cookies");
  // 4. Cert / SPKI
  if (report?.cert || report?._meta?.certSerial) cats.push("cert/SPKI");
  // 5. Source maps (v0.16.0 — new)
  if (report?.sourceMaps?.reachable) cats.push("source maps");
  // 6. TLS posture
  if (report?.publicSurface?.tlsVersion || report?.tlsVersion) cats.push("TLS");
  // 7. Mixed content — v0.16.2 promoted to dedicated probe; falls back to
  //    publicDeps inference when explicit field missing.
  if (report?.mixedContent?.probed || report?.publicDeps?.fetched) cats.push("mixed-content");
  // 8. Subdomain scale (from CT log scan)
  if (typeof report?.publicSurface?.subdomainCount === "number") cats.push("subdomain scale");
  // 9. Protected paths (v0.16.2 — the headline feature)
  if (report?.protectedPaths?.probed) cats.push("protected paths");
  return { count: cats.length, categories: cats };
}

// Default ("Verified N signals · scripts, headers, ...") is for first scans
// where there's no baseline to compare. With a baseline + no drift we
// switch to "Security-relevant surface unchanged" — it directly answers
// the customer's question ("did anything that matters change?") instead
// of just naming what we checked. User direction 2026-05-22.
function formatVerifiedSignalsLine(report, options = {}) {
  const { count, categories } = countVerifiedSignals(report);
  if (count === 0) return null;
  const head = options.diffNoChange === true
    ? "Security-relevant surface unchanged"
    : `Verified ${count} signal${count === 1 ? "" : "s"}`;
  return color("green", "✓ ") + color("bold", head) + color("dim", " · " + categories.join(", "));
}

// Default high-yield panel — 3-5 lines max. Used in `pqcheck <domain> --ai`
// and `pqcheck deploy-check --ai` when no critical findings need to be
// surfaced prominently (otherwise the alerts go above this block).
function formatHighYieldDefault(report, { shipDecision, diffContext, diffNoChange } = {}) {
  const lines = [];
  // Header pulse: "✓ PASS · no public-surface drift detected"
  //               "⚠ REVIEW · 2 public-surface changes"
  //               "⛔ BLOCK · protected path changed"
  if (diffContext) {
    lines.push(diffContext);
  }
  const tpl = formatTrustPostureLine(report);
  if (tpl) lines.push(tpl);
  // diffNoChange flag tells the verified-signals line to switch wording
  // from "Verified N signals" to "Security-relevant surface unchanged" —
  // only set this when there IS a baseline to compare against AND the
  // diff returned zero deltas.
  const vsl = formatVerifiedSignalsLine(report, { diffNoChange: !!diffNoChange });
  if (vsl) lines.push(vsl);
  lines.push(color("dim", "  Run with --verbose to see all verified signals."));
  return lines.join("\n");
}

// Verbose panel — opt-in via --verbose. Per-signal bullet breakdown.
// Used for first-run, troubleshooting, public benchmark/report pages.
// The caller renders the trust-posture line ABOVE this block, so we
// don't duplicate it here.
function formatHighYieldVerbose(report) {
  const lines = [];
  lines.push(color("green", "✓ ") + color("bold", "Verified this deploy:"));
  // Scripts
  if (Array.isArray(report?.publicDeps?.thirdParties)) {
    const hosts = report.publicDeps.thirdParties.slice(0, 6).map(d => d.host || d).filter(Boolean);
    const more = report.publicDeps.thirdParties.length > 6
      ? `, +${report.publicDeps.thirdParties.length - 6} more` : "";
    lines.push(color("dim", `  · ${hosts.length} third-party script${hosts.length === 1 ? "" : "s"} intact (${hosts.join(", ")}${more})`));
  }
  // Headers (always-on)
  const hh = report?.httpHeaders;
  if (hh?.reachable) {
    const hdrs = [];
    if (hh.csp?.present) hdrs.push("CSP enforced");
    if (hh.hsts?.present) hdrs.push(`HSTS${hh.hsts.preload ? " preload" : ""}`);
    if (hh.xFrameOptions?.present) hdrs.push(`X-Frame-Options ${hh.xFrameOptions.value || ""}`.trim());
    if (hh.xContentTypeOptions?.present) hdrs.push("X-Content-Type-Options nosniff");
    if (hh.referrerPolicy?.present) hdrs.push(`Referrer-Policy ${hh.referrerPolicy.value || ""}`.trim());
    if (hh.permissionsPolicy?.present) hdrs.push("Permissions-Policy set");
    if (hdrs.length > 0) lines.push(color("dim", `  · ${hdrs.join(" · ")}`));
  }
  // Cert
  if (report?.cert || report?._meta?.certSerial) {
    const cert = report.cert || {};
    const days = cert.notAfter
      ? Math.floor((new Date(cert.notAfter).getTime() - Date.now()) / 86400000)
      : null;
    const certLine = days !== null
      ? `Cert: ${days}d until expiry${cert.issuer ? " · issued by " + cert.issuer : ""}`
      : `Cert: ${cert.issuer || "issued"}`;
    lines.push(color("dim", `  · ${certLine}`));
  }
  // Cookies (v0.16.0)
  const ck = report?.cookies;
  if (ck?.reachable) {
    if (ck.count === 0) {
      lines.push(color("dim", `  · Cookies: none set`));
    } else {
      const flags = [];
      if (!ck.anyMissingSecure) flags.push("all Secure");
      if (!ck.anyMissingHttpOnly) flags.push("all HttpOnly");
      if (!ck.anyMissingSameSite) flags.push("all SameSite set");
      lines.push(color("dim", `  · Cookies: ${ck.count} set${flags.length ? " · " + flags.join(" + ") : ""}`));
    }
  }
  // Source maps (v0.16.0)
  const sm = report?.sourceMaps;
  if (sm?.reachable) {
    lines.push(color("dim", `  · ${sm.exposed ? `Source maps EXPOSED on ${sm.exposedCount} script(s)` : "No source maps exposed"}`));
  }
  // Mixed content
  if (Array.isArray(report?.publicDeps?.thirdParties)) {
    const insecure = report.publicDeps.thirdParties.filter(d => d.loadedOverHttps === false).length;
    lines.push(color("dim", `  · ${insecure === 0 ? "No mixed-content (all third-parties over HTTPS)" : `Mixed content: ${insecure} resource(s) over HTTP`}`));
  }
  return lines.join("\n");
}

// v0.16.3 — preview-diff per-signal comparison. Render N vs N+1 signal
// values for both sides side-by-side so the customer SEES that every
// signal was checked, even when delta_count=0. Without this, preview-diff
// was silent on non-changing signals and looked like a binary "did
// anything change" detector. With this, every preview-diff output proves
// the 9 signals were exercised on both URLs.
function formatPreviewDiffPerSignal(prev, prod, options = {}) {
  if (!prev || !prod) return null;
  const verbose = options.verbose === true;
  // v0.16.5 — caller may pass the application_surface.scripts diff so the
  // Scripts row can name the specific hosts that were added/removed
  // (preview-diff was rendering "Scripts | 2 → 3" with no indication of
  // WHICH vendor changed; the answer was buried in summary_lines above).
  const scriptDeltas = Array.isArray(options.scriptDeltas) ? options.scriptDeltas : [];
  const rows = [];
  const push = (name, l, r, extra) => rows.push({ name, prev: l, prod: r, same: l === r, extra: extra || null });

  if (typeof prev?.score === "number" || typeof prod?.score === "number") {
    const dbrL = typeof prev?.score === "number" ? `${prev.score.toFixed(1)}${prev.grade ? " " + prev.grade : ""}` : "—";
    const dbrR = typeof prod?.score === "number" ? `${prod.score.toFixed(1)}${prod.grade ? " " + prod.grade : ""}` : "—";
    push("DBR", dbrL, dbrR);
  }

  const prevScripts = prev?.publicDeps?.thirdPartyCount;
  const prodScripts = prod?.publicDeps?.thirdPartyCount;
  if (prevScripts !== undefined || prodScripts !== undefined) {
    // Sub-lines naming the specific hosts that changed (added/removed),
    // when application_surface.scripts is available. A substitution
    // (a.com → c.com, count unchanged) still surfaces because the diff
    // is computed by host-set, not by count.
    const scriptSubLines = scriptDeltas.length > 0
      ? scriptDeltas.map((s) => {
          const sigil = s.kind === "added" ? "+" : s.kind === "removed" ? "-" : "~";
          const tone = s.kind === "added" ? "yellow" : s.kind === "removed" ? "red" : "dim";
          return color(tone, `${sigil} ${s.host}`);
        })
      : null;
    push("Scripts", String(prevScripts ?? "—"), String(prodScripts ?? "—"), scriptSubLines);
  }

  const hdrSummary = (h) => {
    if (!h?.reachable) return "—";
    const flags = [];
    flags.push(h.csp?.present ? "CSP✓" : "CSP✗");
    flags.push(h.hsts?.present ? `HSTS${h.hsts.preload ? "+preload" : ""}✓` : "HSTS✗");
    flags.push(h.xFrameOptions?.present ? "XFO✓" : "XFO✗");
    return flags.join(" ");
  };
  if (prev?.httpHeaders || prod?.httpHeaders) {
    push("Headers", hdrSummary(prev?.httpHeaders), hdrSummary(prod?.httpHeaders));
  }

  const ckSummary = (c) => {
    if (!c) return "—";
    if (!c.reachable) return "unreachable";
    const issues = [];
    if (c.anyMissingSecure) issues.push("Secure");
    if (c.anyMissingHttpOnly) issues.push("HttpOnly");
    if (c.anyMissingSameSite) issues.push("SameSite");
    const tag = issues.length ? `miss:${issues.join(",")}` : "all flags";
    return `${c.count ?? 0} (${tag})`;
  };
  if (prev?.cookies || prod?.cookies) push("Cookies", ckSummary(prev?.cookies), ckSummary(prod?.cookies));

  const smSummary = (s) => {
    if (!s) return "—";
    if (!s.reachable) return "unreachable";
    if (s.exposed) return `${s.exposedCount} EXPOSED`;
    return "none exposed";
  };
  if (prev?.sourceMaps || prod?.sourceMaps) push("Source maps", smSummary(prev?.sourceMaps), smSummary(prod?.sourceMaps));

  const mcSummary = (m) => {
    if (m === null || m === undefined) return "—";
    if (typeof m === "number") return String(m);
    if (typeof m === "object") {
      if (typeof m.insecureCount === "number") return String(m.insecureCount);
      if (typeof m.count === "number") return String(m.count);
    }
    return "—";
  };
  if (prev?.mixedContent !== null || prod?.mixedContent !== null) {
    push("Mixed content", mcSummary(prev?.mixedContent), mcSummary(prod?.mixedContent));
  }

  const ppSummary = (p) => {
    if (!p?.probed) return "—";
    const protected_ = p.protectedCount ?? 0;
    const exposed = p.exposedCount ?? 0;
    const total = protected_ + exposed;
    return total === 0 ? "0/0" : `${protected_}/${total} protected`;
  };
  if (prev?.protectedPaths || prod?.protectedPaths) {
    push("Protected paths", ppSummary(prev?.protectedPaths), ppSummary(prod?.protectedPaths));
  }

  const certSummary = (c) => {
    if (!c) return "—";
    if (c.spkiSha256) return `${String(c.spkiSha256).slice(0, 10)}…`;
    return c.issuer || "—";
  };
  if (prev?.cert || prod?.cert) push("Cert SPKI", certSummary(prev?.cert), certSummary(prod?.cert));

  if (prev?.tlsVersion || prod?.tlsVersion) push("TLS", prev?.tlsVersion || "—", prod?.tlsVersion || "—");

  const prevSub = prev?.publicSurface?.subdomainCount;
  const prodSub = prod?.publicSurface?.subdomainCount;
  if (prevSub !== undefined || prodSub !== undefined) {
    push("Subdomains", String(prevSub ?? "—"), String(prodSub ?? "—"));
  }

  if (rows.length === 0) return null;

  if (!verbose) {
    // Compact 1-line summary: "✓ 9/9 signals match (preview ↔ production)"
    const sameCount = rows.filter((r) => r.same).length;
    const allMatch = sameCount === rows.length;
    const symbol = allMatch ? color("green", "✓ ") : color("yellow", "~ ");
    const head = symbol + color("bold", `${sameCount}/${rows.length} signals match`) + color("dim", " (preview ↔ production)");
    // v0.16.5 — if the Scripts row changed AND we have the host-level
    // diff, append a sub-line naming each added/removed host even in
    // compact mode. Keeps the customer from having to scroll up to
    // summary_lines to find out WHICH vendor changed.
    const scriptsRow = rows.find((r) => r.name === "Scripts");
    if (scriptsRow && scriptsRow.extra && scriptsRow.extra.length > 0) {
      const shown = scriptsRow.extra.slice(0, 5);
      const more = scriptsRow.extra.length > 5 ? color("dim", `  +${scriptsRow.extra.length - 5} more`) : "";
      return [head, ...shown.map((l) => "  " + l)].join("\n") + (more ? "\n" + more : "");
    }
    return head;
  }

  // Verbose: per-row table
  const lines = [];
  lines.push("");
  lines.push(color("bold", "Per-signal verification (preview ↔ production):"));
  const nameWidth = Math.max(...rows.map((r) => r.name.length));
  const prevWidth = Math.max(...rows.map((r) => r.prev.length));
  for (const r of rows) {
    const arrow = r.same ? color("dim", "↔") : color("yellow", "→");
    const valueColor = r.same ? "dim" : "yellow";
    lines.push(
      "  " +
      color("bold", r.name.padEnd(nameWidth)) + "  " +
      color(valueColor, r.prev.padEnd(prevWidth)) + "  " +
      arrow + "  " +
      color(valueColor, r.prod)
    );
    // v0.16.5 — sub-lines under Scripts row naming added/removed hosts.
    // Indent past the name+value columns so the per-host info reads as
    // a nested detail of the parent row, not a peer signal.
    if (r.extra && r.extra.length > 0) {
      const indent = "  " + " ".repeat(nameWidth) + "  " + " ".repeat(prevWidth) + "     ";
      for (const sub of r.extra) lines.push(indent + sub);
    }
  }
  return lines.join("\n");
}

// Helper: pretty-print 1-3 alerts (when ship_decision = review/block) ABOVE
// the trust-posture line, so the actionable change is the FIRST thing the
// customer sees. Each alert is one line with an emoji + concise summary.
function formatAlertsLine(findings, max = 3) {
  if (!Array.isArray(findings) || findings.length === 0) return null;
  const sortedAlerts = [...findings].sort(
    (a, b) => severityRank(b.severity) - severityRank(a.severity),
  );
  const lines = [];
  for (const f of sortedAlerts.slice(0, max)) {
    const sev = String(f.severity || "").toLowerCase();
    const sym = sev === "critical" ? "⛔" : sev === "high" ? "⚠" : "ⓘ";
    const c = sev === "critical" ? "red" : sev === "high" ? "yellow" : "dim";
    const title = f.title || f.id || "finding";
    lines.push(color(c, `${sym} ${title}`));
  }
  if (sortedAlerts.length > max) {
    lines.push(color("dim", `  +${sortedAlerts.length - max} more (run with --verbose)`));
  }
  return lines.join("\n");
}

function isVerboseMode(args) {
  return args.includes("--verbose") || args.includes("--explain");
}

// One-line "decision pulse" — the prominent first line that tells the customer
// the answer to "is this deploy safe to announce?" in <80 characters.
// Wording branches on context:
//   - Diff context (deploy-check / trust-diff / preview-diff): talks about
//     CHANGES vs the baseline ("no public-surface drift detected").
//   - Basic scan (no baseline): talks about FINDINGS from this scan
//     ("no high-severity findings").
function formatDecisionPulse({ shipDecision, alertCount, unreachable, diffContext }) {
  if (unreachable) {
    return color("red", "⛔ UNREACHABLE") + color("dim", " · scanner couldn't reach the domain");
  }
  const n = alertCount || 0;
  if (shipDecision === "pass") {
    const tail = diffContext
      ? "no public-surface drift detected"
      : "no high-severity findings";
    return color("green", "✓ PASS") + color("dim", " · " + tail);
  }
  if (shipDecision === "review") {
    const noun = diffContext ? "public-surface change" : "high-severity finding";
    return color("yellow", "⚠ REVIEW") + color("dim", ` · ${n} ${noun}${n === 1 ? "" : "s"}`);
  }
  if (shipDecision === "block") {
    const noun = diffContext ? "critical change" : "critical finding";
    return color("red", "⛔ BLOCK") + color("dim", ` · ${n} ${noun}${n === 1 ? "" : "s"}`);
  }
  return color("dim", "· no decision");
}

// "◆ Cipherwake — domain" — the v0.16.0 brand+domain header line. Shorter
// than the old AI banner so the decision-pulse line below it carries the
// status. The banner color stays neutral (no decision color) because the
// decision-pulse line owns that semantic.
function formatBrandHeader(domain) {
  return color("bold", "◆ Cipherwake") + color("dim", " — ") + color("bold", domain);
}

// Persist last-scan state to ~/.config/cipherwake/last-scan.json.
// Feeds the cipherwake-statusline + cipherwake-prompt-hook + cipherwake-chat-hook
// scripts so users get persistent ambient state in their AI coder's surfaces.
//
// v0.15.1 (2026-05-22): ALSO writes a per-repo state file at
// .cipherwake/last-status.json IF that directory exists in cwd (created by
// `pqcheck setup --auto`). This gives Cursor / Copilot / Continue / Cline
// agents a read-on-demand surface inside the repo — they see the latest
// trust posture for the customer's primary domain when scanning repo state.
//
// Best-effort — never throws (a write failure doesn't break the scan).
async function writeLastScanFile(payload) {
  try {
    const os = await import("node:os");
    const path = await import("node:path");
    const fs = await import("node:fs/promises");
    const enriched = { ...payload, written_at: new Date().toISOString() };

    // Per-user state file (primary, always written)
    const userDir = path.join(os.homedir(), ".config", "cipherwake");
    await fs.mkdir(userDir, { recursive: true });
    await fs.writeFile(path.join(userDir, "last-scan.json"), JSON.stringify(enriched, null, 2));

    // Per-repo state file (secondary, only if .cipherwake/ exists in cwd
    // — i.e., this repo went through `pqcheck setup --auto`). Gives Cursor/
    // Copilot/Continue/Cline agents a repo-local artifact they pick up
    // automatically when reading workspace state.
    const repoDir = path.join(process.cwd(), ".cipherwake");
    try {
      await fs.access(repoDir);
      await fs.writeFile(path.join(repoDir, "last-status.json"), JSON.stringify(enriched, null, 2));
    } catch {
      // .cipherwake/ doesn't exist here — that's fine, user didn't run setup --auto in this repo
    }
  } catch {
    // best-effort
  }
}

// Map ship_decision → exit code so CI / shell scripts can act on it
// without parsing the structured block. pass=0, review=1, block=2.
function shipDecisionExitCode(d) {
  return d === "block" ? 2 : d === "review" ? 1 : 0;
}

// ---------- format renderers (CSV + markdown) ----------

let _csvHeaderPrinted = false;
function printCsvHeader() {
  console.log("domain,score,grade,score_label,reachable,tls_version,hybrid_pqc,days_until_cert_expiry,subdomains,wildcard_cert,findings_high,findings_medium,findings_low");
  _csvHeaderPrinted = true;
}
function printCsvRow(r) {
  if (!_csvHeaderPrinted) printCsvHeader();
  const ps = r.publicSurface || {};
  const sevCount = (sev) => (r.findings || []).filter((f) => f.severity === sev).length;
  const cells = [
    csvEscape(r.domain),
    r.score ?? "",
    r.grade ?? "",
    r.scoreLabel ?? "",
    r.reachable ? "true" : "false",
    csvEscape(ps.tlsVersion ?? ""),
    ps.hybridPQC ? "true" : "false",
    ps.daysUntilCertExpiry ?? "",
    ps.subdomainCount ?? 0,
    ps.wildcardCert ? "true" : "false",
    sevCount("high") + sevCount("critical"),
    sevCount("medium"),
    sevCount("low"),
  ];
  console.log(cells.join(","));
}
function csvEscape(s) {
  // Spreadsheet-formula-injection defense (R2 finding): cells starting
  // with =, +, -, @, TAB, or CR get treated as formulas by Excel/Sheets.
  // Prefix with a literal-string ' to neutralize. Defense-in-depth even
  // though domains are shape-validated upstream.
  let v = String(s ?? "");
  if (/^[=+\-@\t\r\n]/.test(v)) {
    v = "'" + v;
  }
  if (v.includes(",") || v.includes('"') || v.includes("\n")) {
    return '"' + v.replace(/"/g, '""') + '"';
  }
  return v;
}

function printMarkdown(r, multi) {
  if (!r.reachable) {
    console.log(`### ${r.domain} — unreachable\n${r.errorMessage ? `> ${r.errorMessage}` : ""}\n`);
    return;
  }
  const ps = r.publicSurface || {};
  const lines = [];
  lines.push(`### ${r.domain} — Decryption Blast Radius **${r.score} / 10** (${r.scoreLabel}, grade ${r.grade ?? "—"})`);
  lines.push("");
  lines.push("| Signal | Value |");
  lines.push("|---|---|");
  lines.push(`| TLS | ${ps.tlsVersion ?? "?"}${ps.cipher ? ` (${ps.cipher})` : ""} |`);
  lines.push(`| Hybrid PQC | ${ps.hybridPQC ? "yes" : "no"} |`);
  lines.push(`| Cert expires | ${ps.daysUntilCertExpiry !== null && ps.daysUntilCertExpiry !== undefined ? `in ${ps.daysUntilCertExpiry} days` : "?"} |`);
  lines.push(`| HSTS | ${ps.hsts ? "enabled" : "not detected"} |`);
  lines.push(`| Subdomains | ${ps.subdomainCount ?? 0}${ps.wildcardCert ? " (wildcard cert)" : ""} |`);
  lines.push("");
  if (r.findings && r.findings.length) {
    lines.push("**Findings:**");
    lines.push("");
    for (const f of r.findings) {
      lines.push(`- **[${f.severity.toUpperCase()}]** ${f.title}`);
      lines.push(`  ${f.detail}`);
    }
    lines.push("");
  }
  lines.push(`> ⚠ Public surface only. Internal Blast Radius is typically 12–40× this score.`);
  lines.push("");
  lines.push(`Full report: ${API_BASE}/?check=${encodeURIComponent(r.domain)} · Share: ${API_BASE}/r/${encodeURIComponent(r.domain)}`);
  // Conversion CTA (generalbusiness.md principle #15): one-line activation
  // path on every value-delivery moment. Pointed at /watch/<domain>.
  // Audit-required 2026-05-14: copy matches current locked plan ($29 Starter
  // not the old "watch free / weekly digest"). PR-comment context plants
  // team-invitation idea for the eventual Growth tier upgrade.
  lines.push(`📌 **Monitor ${r.domain} continuously?** ${API_BASE}/watch/${encodeURIComponent(r.domain)}`);
  lines.push(`Cipherwake Founder Pro $19.99/mo (launch pricing, locked while subscription active) · 5 watched domains · daily scans · full CI Trust Gate · approved-vendor allowlist · webhook delivery (Slack incoming-webhook URLs work).`);
  if (multi) lines.push("\n---\n");
  console.log(lines.join("\n"));
}

function printReport(r) {
  if (!r.reachable) {
    console.log(color("red", `\n  ${r.domain} — unreachable`));
    if (r.errorMessage) console.log(color("dim", `  ${r.errorMessage}`));
    console.log("");
    return;
  }

  const labelColor =
    r.scoreLabel === "CRITICAL" ? "red" :
    r.scoreLabel === "HIGH"     ? "yellow" :
    r.scoreLabel === "MEDIUM"   ? "yellow" : "green";

  console.log("");
  console.log(`  ${color("bold", r.domain)}`);
  console.log(color("dim", "  ─────────────────────────────────────"));
  // Loud warning when the API fell back to a cached value because three live
  // probe attempts came up degraded. Devs need to know they may be looking at
  // stale data — silent fallback would erode trust in the tool.
  const meta = r._meta || {};
  if (meta.degraded) {
    const since = meta.lastUpdated ? new Date(meta.lastUpdated).toUTCString() : "unknown";
    console.log("");
    console.log(color("yellow", "  ⚠ WARNING: showing last known-good cached score"));
    console.log(color("yellow", `    Reason: ${meta.degradedReason || "unknown"}`));
    console.log(color("yellow", `    Last verified: ${since}`));
    console.log(color("dim", "    The live probe failed after 3 retries. Re-run shortly to refresh."));
    console.log("");
  }
  const degradedMark = meta.degraded ? color("yellow", " *") : "";
  console.log(`  ${color("bold", "PUBLIC SURFACE BLAST RADIUS:")} ${color(labelColor, `${r.score} / 10`)}${degradedMark} ${color(labelColor, `(${r.scoreLabel})`)}`);
  console.log("");
  console.log(color("dim", "  Public surface signals:"));
  console.log(`  • TLS:           ${r.publicSurface.tlsVersion ?? "?"} ${r.publicSurface.cipher ? color("dim", `(${r.publicSurface.cipher})`) : ""}`);
  console.log(`  • Hybrid PQC:    ${r.publicSurface.hybridPQC ? color("green", "yes") : color("yellow", "no")}`);
  console.log(`  • Cert expires:  ${r.publicSurface.daysUntilCertExpiry !== null ? `in ${r.publicSurface.daysUntilCertExpiry} days` : "?"}`);
  console.log(`  • HSTS:          ${r.publicSurface.hsts ? color("green", "enabled") : color("dim", "not detected")}`);
  console.log(`  • Subdomains:    ${r.publicSurface.subdomainCount}${r.publicSurface.wildcardCert ? color("yellow", " (wildcard cert)") : ""}`);
  console.log("");
  // Coverage line — communicates breadth of checks
  const coverage = ["TLS", "Cert chain", "Cipher class", color("violet", "★ Key reuse (CT-log)"), "Subdomains"];
  if (r.emailSecurity) coverage.push("SPF", "DMARC", "DKIM", "BIMI");
  if (r.httpHeaders && r.httpHeaders.reachable) coverage.push("HSTS", "CSP", "X-Frame", "Referrer-Policy");
  if (r.subdomainTakeover) coverage.push("Takeover");
  console.log(color("dim", "  Checked: ") + coverage.join(color("dim", " · ")));
  console.log("");

  if (r.findings && r.findings.length) {
    // Group findings by category. Quantum/cert findings come first since
    // they're the differentiator; ASM-completeness findings come after.
    const groups = { quantum: [], takeover: [], email: [], headers: [], other: [] };
    for (const f of r.findings) {
      const t = (f.title || "").toLowerCase();
      if (/spf|dmarc|dkim|bimi/.test(t)) groups.email.push(f);
      else if (/hsts|csp|x-frame|content-?type|referrer|clickjacking|server version|permissions-policy/.test(t)) groups.headers.push(f);
      else if (/takeover/.test(t)) groups.takeover.push(f);
      else if (/key reused?|key persist|reused for|cert rotation|chain weakest|rsa fallback|ecdhe|quantum/.test(t)) groups.quantum.push(f);
      else groups.other.push(f);
    }
    const sections = [
      ["quantum", "Quantum & cert exposure (our differentiator):", groups.quantum],
      ["takeover", "Subdomain takeover:", groups.takeover],
      ["email", "Email security (SPF / DMARC / DKIM / BIMI):", groups.email],
      ["headers", "HTTP header security:", groups.headers],
      ["other", "Other:", groups.other],
    ];
    for (const [key, label, arr] of sections) {
      if (!arr || arr.length === 0) continue;
      console.log(color("violet", `  ${label}`));
      for (const f of arr) {
        const sev = f.severity.toUpperCase();
        const sevColor =
          f.severity === "critical" ? "red" :
          f.severity === "high"     ? "yellow" :
          f.severity === "medium"   ? "yellow" : "dim";
        const isUnique = key === "quantum" && /key reused?|reused for|key persist/.test((f.title || "").toLowerCase());
        const star = isUnique ? color("violet", " ★ UNIQUE TO PQCHECK") : "";
        console.log(`  ${color(sevColor, `[${sev}]`)} ${f.title}${star}`);
        console.log(color("dim", `    ${f.detail}`));
      }
    }
    console.log("");
  }
  console.log(color("dim", "  ⚠  This is the PUBLIC surface only."));
  console.log(color("dim", `  ${r.internalMultiplierBenchmark}`));
  console.log("");

  // Phase C: plain-English impact headline + sector ranking
  if (r.impact && r.impact.headline) {
    console.log(color("violet", "  Plain-English impact:"));
    console.log("  " + color("dim", r.impact.headline));
    if (r.impact.dataTypeContext) {
      console.log("  " + color("dim", `Data types at risk: ${r.impact.dataTypeContext}`));
    }
    if (r.impact.sensitivityNote) {
      console.log("  " + color("dim", r.impact.sensitivityNote));
    }
    console.log("");
  }
  if (r.sectorRanking && r.sectorRanking.available) {
    var sr = r.sectorRanking;
    console.log(color("violet", `  Sector ranking:`));
    console.log(`  Among ${sr.sectorLabel}: ` + color("bold", `${sr.rank} of ${sr.total}`) + color("dim", ` (worse than ${sr.betterThanCount} peers measured)`));
    console.log("");
  } else if (r.sectorRanking && r.sectorRanking.reason) {
    console.log(color("dim", `  ${r.sectorRanking.reason}`));
    console.log("");
  }

  // Provenance pill — "Tracked by Cipherwake since X · N observations". Trust
  // signal that this isn't a one-shot probe but a historical record. Only
  // renders if we actually have prior observations for the domain.
  if (r.trackedSince) {
    const trackedDate = String(r.trackedSince).slice(0, 10);
    const obs = typeof r.observations === "number" && r.observations > 0 ? r.observations : null;
    const obsLine = obs ? ` · ${obs} observation${obs === 1 ? "" : "s"}` : "";
    console.log(color("dim", `  Tracked by Cipherwake since ${trackedDate}${obsLine}`));
    console.log("");
  }

  // Conversion CTA (generalbusiness.md principle #15): every value-delivery
  // moment surfaces the same /watch/<domain> activation path. Audit-required
  // 2026-05-14: copy must match current locked revenue plan ($29 Starter,
  // not the old "free 1-domain weekly digest").
  console.log(color("violet", `  📌 Monitor ${r.domain} daily: ${API_BASE}/watch/${encodeURIComponent(r.domain)}`));
  console.log(color("dim",    `     Cipherwake Founder Pro $19.99/mo · 5 watched domains · email alerts · launch pricing locked while subscription active · cancel anytime`));
  console.log("");
  console.log(color("dim",    `  → Full report: ${API_BASE}/?check=${encodeURIComponent(r.domain)}`));
  console.log(color("dim",    `  → Share this:  ${API_BASE}/r/${encodeURIComponent(r.domain)}`));
  console.log(color("dim",    `  → Compare two: ${API_BASE}/compare?a=${encodeURIComponent(r.domain)}&b=`));
  console.log("");
}

function normalizeDomain(raw) {
  return (raw || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .split(":")[0];
}

function isValidDomain(d) {
  if (!d || d.length < 4 || d.length > 253) return false;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d);
}

async function safeJSON(resp) {
  try { return await resp.json(); } catch { return null; }
}

// Friendly first-time intro shown when the CLI is invoked with no args.
// Goal: tell a brand-new user what this tool does + give them ONE
// command to copy-paste, before the full usage block. Modeled on
// `curl`/`gh`/`vercel` first-run output (concise, action-oriented).
function printQuickStart() {
  console.log(`
${color("bold", "👋 Welcome to pqcheck")} ${color("dim", `(v${VERSION})`)}

Cipherwake's CLI grades any website's quantum-decryption risk —
the chance that a harvest-now-decrypt-later attack could read its
TLS traffic once quantum decryption arrives.

${color("bold", "Try it:")}
  ${color("dim", "$")} npx pqcheck chase.com

${color("bold", "What you'll see:")} a single letter grade (A–F), the score components
(cipher class, cert lifetime, key rotation history, subdomain exposure),
top findings, and a link to the full interactive report.

${color("bold", "Free + open methodology.")} No account needed for single-domain scans.
Add ${color("dim", "CIPHERWAKE_API_KEY")} env var for higher rate limits + private results
(create one at ${color("dim", "https://cipherwake.io/signin")}).
`);
}

function printUsage() {
  console.log(`
${color("bold", "pqcheck")} ${color("dim", `v${VERSION}`)}

Public Surface Blast Radius — quantum-decryption risk for any domain.

${color("bold", "Commands:")}
  npx pqcheck <domain>                          Scan + print human-readable report
  npx pqcheck lock <domain>                     Generate cipherwake.lock (QXM) committable manifest
  npx pqcheck deps <domain>                     Scan all third-party origins on the page (supply-chain HNDL)
  npx pqcheck diff <old.lock> <new.lock>        Compare two QXM lockfiles; exit 2 on regression
  npx pqcheck history <domain>                  Show 90-day score history (sparkline + samples)
  npx pqcheck changes <domain>                  Summarize public attack-surface changes in last 14 days
  npx pqcheck cert <file.pem>                   Analyze a local PEM/CRT cert file (offline, no network)
  npx pqcheck watch <domain>                    Add a domain to your watched-domain list (requires CIPHERWAKE_API_KEY)
  npx pqcheck onboard <domain>                  One-command setup wizard (scan + init + vendors + checklist + open browser)
  npx pqcheck init                              Interactive scaffold for .github/workflows/cipherwake.yml
  npx pqcheck deploy-check <domain>             Pre-deploy trust gate (Trust Diff vs last scan; deploy-friendly framing) — see also: AI Coder Protocol at https://cipherwake.io/methodology/ai-coder-protocol
  npx pqcheck guard --domain <D> -- <cmd>       NEW: wrap any deploy command. Runs deploy-check first; conditionally runs <cmd> based on ship_decision. The strongest single artifact for AI-coder workflows.
  npx pqcheck protocol install                  NEW: install the AI Coder Protocol into your CLAUDE.md / .cursorrules (Rule 17 consent flow)
  npx pqcheck guards <init|list|run>            EXPERIMENTAL (BETA): manage Site Guards (.cipherwake/guards.json) — runtime policies for source-maps / mixed-content / approved-hosts / protected-paths / cookie-flags / link-integrity. See: https://cipherwake.io/methodology/site-guards
  npx pqcheck release-checklist [domain]        Print a pre-release trust checklist (markdown, offline)
  npx pqcheck vendors export <domain>           Write cipherwake.vendors.json from observed third-party scripts
  npx pqcheck vendors check <domain>            Compare current scan to lockfile; exit 4 on new origins (Free CI gate)
  npx pqcheck vendors sync <domain>             Pull approved-vendor list from your account (Starter+)

${color("bold", "Multi-domain:")}
  npx pqcheck a.com b.com c.com                 Multi-domain scan (positional)
  npx pqcheck --file domains.txt                Bulk scan from a newline-separated file (# comments allowed)

${color("bold", "Output formats:")}
  --format text                                 Human-readable (default)
  --format json (or --json)                     Raw JSON / NDJSON for multi
  --format markdown                             GitHub-issue / Slack-ready Markdown
  --format csv                                  Spreadsheet-friendly CSV row
  --format sarif                                SARIF 2.1.0 for GitHub Code Scanning upload
  --gh-action                                   GitHub Actions ::notice/::warning/::error annotations

${color("bold", "Common flags:")}
  -h, --help                       Show this help
  -v, --version                    Show version
  --threshold <0-10>               Exit 2 if score meets or exceeds this (CI gate)
  -q, --quiet                      Print only the numeric score
  --watch [seconds]                Poll every N seconds (default 300) and report changes
  --webhook <url>                  POST scan results to a URL (one-shot or each watch tick)
  --fresh                          Bypass server cache, force a fresh scan (subject to 20/hr per-IP cap)

${color("bold", "Subcommand-specific:")}
  pqcheck deps:
    --lock                                       Also write cipherwake-deps.lock + .md
    -o <dir>                                     Output directory for --lock files
    --max=<N>                                    Max third parties to scan (default 20)
    --allowlist <file>                           Exit 3 if any third-party not in allowlist (CI gate)
    --baseline <file>                            Compare current hosts to baseline JSON; mark new ones
    --write-baseline                             Overwrite the --baseline file with current scan
    --fail-on-new                                Exit 4 if any NEW host since baseline (Polyfill.io-style supply-chain CI gate)
  pqcheck lock:
    -o <dir>                                     Output directory
    --stdout                                     Print JSON to stdout instead of writing files
  pqcheck history:
    --days <N>                                   History window (default 90)
    --json                                       Raw JSON

${color("bold", "Exit codes:")}
  0   success
  1   usage / network / scan error
  2   score met or exceeded --threshold (or diff regression)
  3   allowlist violation (deps --allowlist)
  4   supply-chain change detected — new host(s) since baseline (deps --fail-on-new)

${color("bold", "Examples:")}
  npx pqcheck chase.com
  npx pqcheck mybank.com --threshold 7      ${color("dim", "# fail CI if score ≥ 7")}
  npx pqcheck mybank.com --watch 600        ${color("dim", "# poll locally every 10 min, log on change (no API key required)")}
  npx pqcheck deps stripe.com --lock
  npx pqcheck deps acme.com --allowlist allowed-vendors.txt   ${color("dim", "# CI vendor-risk gate")}
  npx pqcheck deps acme.com --baseline .pqcheck-baseline.json --write-baseline   ${color("dim", "# capture initial state")}
  npx pqcheck deps acme.com --baseline .pqcheck-baseline.json --fail-on-new      ${color("dim", "# fail PR on new third party")}
  npx pqcheck diff main.lock pr.lock        ${color("dim", "# regression detection in PR")}
  npx pqcheck history cipherwake.io
  npx pqcheck cert ./mycert.pem             ${color("dim", "# offline cert analysis")}
  npx pqcheck --file domains.txt --format json > scans.ndjson
  npx pqcheck mybank.com --format sarif > pqcheck.sarif   ${color("dim", "# upload to Code Scanning")}
  npx pqcheck mybank.com --gh-action        ${color("dim", "# inline PR annotations")}

Backed by the patented Decryption Blast Radius methodology.
${color("violet", "https://cipherwake.io")}
`);
}

// =============================================================================
// `pqcheck lock` — QXM (Quantum Exposure Manifest) generator
// =============================================================================
// Generates two files committable to a git repo:
//   cipherwake.lock          — stable JSON manifest (machine-readable)
//   cipherwake-report.md     — human-readable summary (renders on GitHub)
//
// Like SBOM / package-lock.json / cargo audit / snyk test outputs — devs commit
// these to track quantum exposure as a first-class technical concern.
//
// Filename history: this tool was previously named Quantapact, and earlier
// versions wrote `quantapact.lock` / `quantapact-report.md`. We permanently
// support reading EITHER filename; existing repos with the old name keep
// working forever. When re-locking in a directory that has the legacy file,
// we overwrite it in place rather than silently creating a new file alongside.
// New repos (no existing lockfile) get the new default `cipherwake.lock`.
//
// Usage:
//   npx pqcheck lock <domain>           Write to ./cipherwake.lock + .md
//                                       (or preserves ./quantapact.lock if present)
//   npx pqcheck lock <domain> -o dir/   Write into a specific directory
//   npx pqcheck lock <domain> --stdout  Print JSON to stdout (no files)
//   npx pqcheck lock                    Read domain from existing
//                                       cipherwake.lock OR quantapact.lock, else error
// =============================================================================

// Discover an existing lockfile in `dir`, preferring the new name but
// accepting the legacy name. Returns { lockPath, mdPath, isLegacy } if found,
// or null if neither exists. Read-anywhere, write-back-to-same-name policy.
async function discoverExistingLockfile(fs, path, dir) {
  const candidates = [
    { lockName: "cipherwake.lock", mdName: "cipherwake-report.md", isLegacy: false },
    { lockName: "quantapact.lock", mdName: "quantapact-report.md", isLegacy: true },
  ];
  for (const c of candidates) {
    const lockPath = path.join(dir, c.lockName);
    try {
      await fs.access(lockPath);
      return { lockPath, mdPath: path.join(dir, c.mdName), isLegacy: c.isLegacy };
    } catch { /* try next */ }
  }
  return null;
}

async function runLockCommand(args) {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const crypto = await import("node:crypto");

  const stdout = args.includes("--stdout");
  const outIdx = args.indexOf("-o");
  const outDir = outIdx >= 0 ? args[outIdx + 1] : ".";

  // Find the domain — either positional arg, or read from existing lockfile
  const positional = args.filter((a) => !a.startsWith("-") && a !== outDir);
  let domain = positional.length > 0 ? normalizeDomain(positional[0]) : null;

  // Discover any existing lockfile (new or legacy). Used both for re-lock
  // domain auto-detection AND to preserve the filename on write.
  const existing = await discoverExistingLockfile(fs, path, outDir);

  if (!domain) {
    if (existing) {
      try {
        const content = await fs.readFile(existing.lockPath, "utf8");
        const parsed = JSON.parse(content);
        domain = parsed.domain;
        if (!stdout) {
          const baseName = path.basename(existing.lockPath);
          console.error(color("dim", `Re-locking from existing ${baseName} (domain: ${domain})`));
        }
      } catch {
        console.error(color("red", `error: could not parse existing ${path.basename(existing.lockPath)}`));
        process.exit(1);
      }
    } else {
      console.error(color("red", "error: no domain provided and no existing cipherwake.lock found"));
      console.error(color("dim", "Usage: npx pqcheck lock <domain>"));
      process.exit(1);
    }
  }

  if (!isValidDomain(domain)) {
    console.error(color("red", `error: invalid domain '${domain}'`));
    process.exit(1);
  }

  if (!stdout) process.stderr.write(color("dim", `Scanning ${domain} for QXM lockfile...`));

  let report;
  try {
    const resp = await fetch(`${API_BASE}/api/scan?domain=${encodeURIComponent(domain)}`, {
      method: "GET",
      headers: apiHeaders({ "user-agent": `pqcheck-cli/${VERSION}${CI_ACTION_SUFFIX} (lock)` }),
    });
    if (!stdout) process.stderr.write("\r\x1b[K");
    if (!resp.ok) {
      const errBody = await safeJSON(resp);
      console.error(color("red", `error: ${resp.status} ${errBody?.error || resp.statusText}`));
      process.exit(1);
    }
    report = await resp.json();
  } catch (err) {
    if (!stdout) process.stderr.write("\r\x1b[K");
    console.error(color("red", `error: ${err.message}`));
    process.exit(1);
  }

  const manifest = buildQxmManifest(report, crypto);
  const json = JSON.stringify(manifest, null, 2) + "\n";

  if (stdout) {
    console.log(json);
    return;
  }

  // Write both files. Filename policy: if a legacy quantapact.lock already
  // exists in this directory, overwrite it in place (preserve user's
  // committed filename — no surprise renames in their repo). Otherwise
  // default to the new cipherwake.lock.
  const lockPath = existing
    ? existing.lockPath
    : path.join(outDir, "cipherwake.lock");
  const mdPath = existing
    ? existing.mdPath
    : path.join(outDir, "cipherwake-report.md");
  const md = renderQxmMarkdown(manifest);

  try {
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(lockPath, json);
    await fs.writeFile(mdPath, md);
  } catch (err) {
    console.error(color("red", `error writing files: ${err.message}`));
    process.exit(1);
  }

  console.log("");
  console.log(`  ${color("bold", "QXM lockfile written")} for ${color("violet", domain)}:`);
  console.log("");
  console.log(`  ${color("green", "✓")} ${lockPath}`);
  console.log(`  ${color("green", "✓")} ${mdPath}`);
  console.log("");
  console.log(`  ${color("dim", "Decryption Blast Radius:")} ${color("bold", manifest.score + " / 10")} (Grade ${manifest.grade}, ${manifest.scoreLabel})`);
  console.log(`  ${color("dim", "Findings:")} ${manifest.findings.length} (${manifest.findings.filter((f) => f.severity === "high" || f.severity === "critical").length} high/critical)`);
  console.log("");
  console.log(color("dim", "  Commit these to your repo to track quantum exposure as a versioned artifact."));
  console.log(color("dim", "  Re-run `npx pqcheck lock` to refresh; diffs surface real changes in PRs."));
  console.log("");
  console.log(color("violet", `  → Verify online: ${API_BASE}/r/${encodeURIComponent(domain)}`));
  console.log("");
  process.exit(0);
}

function buildQxmManifest(report, crypto) {
  // Stable hash of the underlying scan, useful for dedup + change detection in CI
  const hashInput = JSON.stringify({
    domain: report.domain,
    score: report.score,
    grade: report.grade,
    findings: (report.findings || []).map((f) => ({ s: f.severity, t: f.title })),
    publicSurface: report.publicSurface,
  });
  const evidenceHash = crypto.createHash("sha256").update(hashInput).digest("hex").slice(0, 32);

  // Tessera recommendation classification (waitlist-shape; SDK not yet shipped)
  const tesseraNeeded = (report.findings || []).some((f) =>
    /key reused?|reused for|key persist|rsa fallback|chain weakest|hybrid pqc/i.test(f.title || ""),
  );

  return {
    schema: "https://cipherwake.io/schemas/qxm/v1",
    schemaVersion: 1,
    generator: `pqcheck-cli/${VERSION}${CI_ACTION_SUFFIX}`,
    generatedAt: report.generatedAt || new Date().toISOString(),
    domain: report.domain,
    reachable: !!report.reachable,
    score: report.score,
    grade: report.grade,
    scoreLabel: report.scoreLabel,
    publicSurface: report.publicSurface || null,
    findings: (report.findings || []).map((f) => ({
      severity: f.severity,
      title: f.title,
      detail: f.detail,
    })),
    impact: report.impact || null,
    sectorRanking: report.sectorRanking || null,
    components: report.components || null,
    evidence: {
      evidenceHash,
      methodology: "https://cipherwake.io/methodology",
      shareableReport: `https://cipherwake.io/r/${encodeURIComponent(report.domain)}`,
      badge: `https://cipherwake.io/badge/${encodeURIComponent(report.domain)}.svg`,
    },
    remediation: {
      tessera: tesseraNeeded ? "join-waitlist" : "not-needed",
      tesseraWaitlist: "https://cipherwake.io/feedback?source=qxm-tessera-interest",
      notes: tesseraNeeded
        ? "Findings include cryptographic exposure that Tessera SDK is being designed to remediate. Tessera is in development; join the waitlist to be notified when ready."
        : "No quantum-decryption-relevant findings requiring Tessera remediation at this time.",
    },
  };
}

function renderQxmMarkdown(m) {
  const lines = [];
  lines.push(`# Quantum Exposure Manifest — \`${m.domain}\``);
  lines.push("");
  lines.push(`> **Decryption Blast Radius:** ${m.score} / 10 (Grade ${m.grade}, ${m.scoreLabel})`);
  lines.push(`> Generated by [pqcheck](https://cipherwake.io) at ${m.generatedAt}`);
  lines.push("");
  if (!m.reachable) {
    lines.push(`*${m.domain} was not reachable at scan time.*`);
    lines.push("");
    return lines.join("\n");
  }

  lines.push("## Public-surface signals");
  lines.push("");
  lines.push("| Signal | Value |");
  lines.push("|---|---|");
  const ps = m.publicSurface || {};
  lines.push(`| TLS version | ${ps.tlsVersion ?? "?"}${ps.cipher ? ` (${ps.cipher})` : ""} |`);
  lines.push(`| Hybrid PQC | ${ps.hybridPQC ? "yes" : "no"} |`);
  lines.push(`| Cert expires in | ${ps.daysUntilCertExpiry ?? "?"} days |`);
  lines.push(`| HSTS | ${ps.hsts ? "enabled" : "not detected"} |`);
  lines.push(`| Subdomains | ${ps.subdomainCount ?? 0}${ps.wildcardCert ? " (wildcard cert)" : ""} |`);
  if (ps.keyReuseLongestYears) {
    lines.push(`| **Key reuse window** | **${ps.keyReuseLongestYears} years** across ${ps.keyReuseCertsObserved ?? "?"} cert rotations |`);
  }
  lines.push("");

  if (m.findings && m.findings.length) {
    lines.push("## Findings");
    lines.push("");
    for (const f of m.findings) {
      lines.push(`### \`[${f.severity.toUpperCase()}]\` ${f.title}`);
      lines.push("");
      lines.push(f.detail);
      lines.push("");
    }
  }

  if (m.impact && m.impact.headline) {
    lines.push("## Plain-English impact");
    lines.push("");
    lines.push(`> ${m.impact.headline}`);
    lines.push("");
  }

  if (m.sectorRanking && m.sectorRanking.available) {
    lines.push("## Sector ranking");
    lines.push("");
    lines.push(`Among ${m.sectorRanking.sectorLabel}: **${m.sectorRanking.rank} of ${m.sectorRanking.total}** (worse than ${m.sectorRanking.betterThanCount} peers measured).`);
    lines.push("");
  }

  lines.push("## Remediation");
  lines.push("");
  lines.push(`- **Tessera SDK status for this domain:** \`${m.remediation.tessera}\``);
  lines.push(`- ${m.remediation.notes}`);
  lines.push(`- [Join Tessera remediation waitlist](${m.remediation.tesseraWaitlist})`);
  lines.push("");

  lines.push("## Evidence");
  lines.push("");
  lines.push("| | |");
  lines.push("|---|---|");
  lines.push(`| Methodology | ${m.evidence.methodology} |`);
  lines.push(`| Shareable report | ${m.evidence.shareableReport} |`);
  lines.push(`| Embeddable badge | \`${m.evidence.badge}\` |`);
  lines.push(`| Evidence hash | \`${m.evidence.evidenceHash}\` |`);
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("*Public-surface measurements only. Internal Blast Radius (east-west traffic, internal databases, VPN tunnels, backup pipelines) is typically 12–40× this score. Re-run `npx pqcheck lock` to refresh; commit the result to your repo to surface changes in pull requests.*");
  lines.push("");
  return lines.join("\n");
}

// =============================================================================
// `pqcheck deps` — supply-chain HNDL scan for a target domain
// =============================================================================
// Fetches the public HTML of the target domain, extracts third-party origins
// referenced via <script src>, <iframe src>, <link href>, <img src>, then runs
// /api/scan against each unique third party. Outputs a sorted summary + an
// optional committable lockfile (cipherwake-deps.lock; legacy quantapact-deps.lock
// is overwritten in place if present, see write-path comments below).
//
// Parallel to the browser extension's Dependencies tab, exposed as a CLI for
// CI integration: gate PR builds on third-party crypto posture.
//
// Usage:
//   npx pqcheck deps <domain>           Scan + print summary table
//   npx pqcheck deps <domain> --json    JSON output (pipe to jq, etc.)
//   npx pqcheck deps <domain> --lock    Also write cipherwake-deps.lock + .md
//   npx pqcheck deps <domain> -o dir/   Output directory for --lock files
//   npx pqcheck deps <domain> --max=20  Cap on third parties scanned (default 20)
// =============================================================================

async function runDepsCommand(args) {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");

  const json = args.includes("--json");
  const lock = args.includes("--lock");
  const outIdx = args.indexOf("-o");
  const outDir = outIdx >= 0 ? args[outIdx + 1] : ".";
  const maxArg = args.find((a) => a.startsWith("--max="));
  const maxThirdParties = maxArg ? Math.max(1, parseInt(maxArg.slice(6), 10) || 20) : 20;

  // Allowlist support: --allowlist <path> reads newline-separated host patterns.
  // If a third-party host is NOT in the allowlist, the scan exits non-zero with code 3.
  // Useful as a CI gate for vendor-risk teams: "fail PR if any unapproved third-party appears."
  const allowlistIdx = args.indexOf("--allowlist");
  let allowlist = null;
  if (allowlistIdx >= 0) {
    const allowlistPath = args[allowlistIdx + 1];
    try {
      const fs2 = await import("node:fs/promises");
      const raw = await fs2.readFile(allowlistPath, "utf8");
      allowlist = new Set(raw.split(/\r?\n/).map(l => l.trim().toLowerCase()).filter(l => l && !l.startsWith("#")));
    } catch (err) {
      console.error(color("red", `error reading --allowlist: ${err.message}`));
      process.exit(1);
    }
  }

  // Baseline support (v0.7.8+): --baseline <path> compares this scan's third
  // parties to a stored baseline JSON file. New hosts get a NEW flag in
  // output. With --fail-on-new, the CLI exits with code 4 if any new hosts
  // appeared — turning the scan into a Polyfill.io-style supply-chain change
  // detector for CI pipelines. --write-baseline overwrites the baseline file
  // with the current scan's hosts (use after deliberately adding a vendor).
  const baselineIdx = args.indexOf("--baseline");
  const baselinePath = baselineIdx >= 0 ? args[baselineIdx + 1] : null;
  const writeBaseline = args.includes("--write-baseline");
  const failOnNew = args.includes("--fail-on-new");
  let baselineHosts = null;
  if (baselinePath) {
    try {
      const fs2 = await import("node:fs/promises");
      const raw = await fs2.readFile(baselinePath, "utf8");
      const parsed = JSON.parse(raw);
      baselineHosts = new Set((parsed.thirdParties || parsed.hosts || []).map((h) =>
        typeof h === "string" ? h.toLowerCase() : (h.host || "").toLowerCase()
      ).filter(Boolean));
    } catch (err) {
      // File missing is OK on first run — treat as empty baseline (everything is "new")
      if (err && err.code === "ENOENT") {
        baselineHosts = new Set();
      } else {
        console.error(color("red", `error reading --baseline: ${err.message}`));
        process.exit(1);
      }
    }
  }

  const positional = args.filter((a) => !a.startsWith("-") && a !== outDir);
  const domain = positional.length > 0 ? normalizeDomain(positional[0]) : null;
  if (!domain || !isValidDomain(domain)) {
    console.error(color("red", "error: pqcheck deps requires a valid domain"));
    console.error(color("dim", "Usage: npx pqcheck deps <domain> [--json|--lock] [-o dir/] [--max=N]"));
    process.exit(1);
  }

  if (!json) process.stderr.write(color("dim", `Fetching ${domain} HTML...`));
  const fetched = await fetchPageHTML(domain);
  if (!json) process.stderr.write("\r\x1b[K");
  if (!fetched) {
    console.error(color("red", `error: could not fetch https://${domain}/`));
    process.exit(1);
  }
  const { html, headerCsp } = fetched;
  const metaCsp = extractMetaCsp(html);
  const cspVerdict = classifyCsp(headerCsp, metaCsp);

  const refs = extractThirdPartyRefs(html, domain);
  if (refs.length === 0) {
    if (json) {
      console.log(JSON.stringify({ domain, scannedAt: new Date().toISOString(), thirdParties: [], summary: { uniqueOrigins: 0, totalReferences: 0 } }, null, 2));
    } else {
      console.log("");
      console.log(`  ${color("violet", domain)} ${color("dim", "·")} ${color("bold", "no third-party origins detected")}`);
      console.log(color("dim", "  (page is fully first-party, or HTML didn't load script/iframe/link refs)"));
      console.log("");
    }
    return;
  }

  // Group by host, dedupe
  const byHost = new Map();
  for (const r of refs) {
    if (!byHost.has(r.host)) byHost.set(r.host, { host: r.host, types: new Set(), occurrences: 0, anyMissingSri: false, allHttps: true });
    const e = byHost.get(r.host);
    // SRI status — host is flagged "no SRI" if ANY reference to it lacks integrity.
    // Only counts for script type (iframes/links/imgs don't support SRI).
    if (r.type === "script" && !r.sri) e.anyMissingSri = true;
    if (!r.loadedOverHttps) e.allHttps = false;
    e.types.add(r.type);
    e.occurrences += 1;
  }
  const uniqueHosts = Array.from(byHost.values()).slice(0, maxThirdParties);

  if (!json) process.stderr.write(color("dim", `Scanning ${uniqueHosts.length} third-party origins...`));

  // Scan each host (parallel batches of 4 to avoid hammering the API)
  const BATCH = 4;
  const results = [];
  for (let i = 0; i < uniqueHosts.length; i += BATCH) {
    const batch = uniqueHosts.slice(i, i + BATCH);
    const batchResults = await Promise.all(
      batch.map(async (h) => {
        try {
          const r = await fetch(`${API_BASE}/api/scan?domain=${encodeURIComponent(h.host)}&source=cli-deps`, {
            headers: apiHeaders({ "user-agent": `pqcheck-cli/${VERSION}${CI_ACTION_SUFFIX} (deps)` }),
          });
          if (!r.ok) return { ...h, types: Array.from(h.types), scan: null, error: `${r.status}` };
          const body = await r.json();
          return {
            ...h,
            types: Array.from(h.types),
            scan: {
              grade: body.grade,
              score: body.score,
              reachable: body.reachable,
              hybridPQC: body.publicSurface?.hybridPQC ?? false,
            },
          };
        } catch (e) {
          return { ...h, types: Array.from(h.types), scan: null, error: e.message };
        }
      })
    );
    results.push(...batchResults);
  }
  if (!json) process.stderr.write("\r\x1b[K");

  // Sort: F first (worst), then D, C, B, A; unreachable/error to bottom
  const gradeRank = { F: 5, D: 4, C: 3, B: 2, A: 1 };
  results.sort((a, b) => {
    const ar = a.scan?.grade ? gradeRank[a.scan.grade] || 0 : -1;
    const br = b.scan?.grade ? gradeRank[b.scan.grade] || 0 : -1;
    return br - ar;
  });

  const summary = buildDepsSummary(results);

  // Baseline diff (v0.7.8+): compare current hosts to baseline hosts.
  // newHosts = hosts in current scan that weren't in the baseline.
  // missingHosts = hosts in baseline that aren't in the current scan.
  // Each result gets a `.isNew` flag for downstream rendering.
  let newHosts = [];
  let missingHosts = [];
  if (baselineHosts) {
    const currentHostSet = new Set(results.map((r) => r.host));
    newHosts = results.map((r) => r.host).filter((h) => !baselineHosts.has(h));
    missingHosts = Array.from(baselineHosts).filter((h) => !currentHostSet.has(h));
    // Don't paint every row as *NEW* on the first run (empty baseline) — there
    // is no prior state to be new relative to. The summary line still says
    // "first run; all hosts will be captured" so the user knows.
    const baselineIsFirstRun = baselineHosts.size === 0;
    for (const r of results) {
      r.isNew = baselineIsFirstRun ? false : !baselineHosts.has(r.host);
    }
  }

  // Build manifest
  const manifest = {
    $schema: "https://cipherwake.io/schemas/deps/v1",
    schemaVersion: "1.2", // bumped for CSP + vendor classification fields
    domain,
    scannedAt: new Date().toISOString(),
    tool: "pqcheck-cli",
    toolVersion: VERSION,
    summary,
    csp: {
      quality: cspVerdict.quality,           // "absent" | "weak" | "strict"
      source: cspVerdict.source,             // "header" | "meta" | null
    },
    baseline: baselineHosts ? {
      file: baselinePath,
      newHosts,
      missingHosts,
      isFirstRun: baselineHosts.size === 0,
    } : null,
    thirdParties: results.map((r) => ({
      host: r.host,
      types: r.types,
      occurrences: r.occurrences,
      sri: { allScriptsHaveSri: !r.anyMissingSri, allHttps: r.allHttps },
      vendor: classifyVendor(r.host),        // { name, category } or null
      isNew: r.isNew || false,
      scan: r.scan,
      error: r.error,
    })),
    evidence: {
      methodology: `${API_BASE}/methodology/browser-extension`,
      reportLink: `${API_BASE}/r/${domain}`,
    },
  };

  // --write-baseline: overwrite the baseline file with current hosts. Used
  // after deliberately adding a vendor (e.g., 'we added Stripe, update the
  // baseline so the next scan doesn't flag Stripe as new').
  if (writeBaseline && baselinePath) {
    try {
      const fs2 = await import("node:fs/promises");
      const baselinePayload = {
        $schema: "https://cipherwake.io/schemas/deps-baseline/v1",
        domain,
        capturedAt: new Date().toISOString(),
        toolVersion: VERSION,
        thirdParties: results.map((r) => ({ host: r.host, sri: !r.anyMissingSri })),
      };
      await fs2.writeFile(baselinePath, JSON.stringify(baselinePayload, null, 2) + "\n", "utf8");
      if (!json) console.error(color("dim", `✓ wrote baseline to ${baselinePath} (${results.length} hosts)`));
    } catch (err) {
      console.error(color("red", `error writing --baseline: ${err.message}`));
      process.exit(1);
    }
  }

  // --fail-on-new: exit code 4 if any new hosts appeared since the baseline.
  // The CI gate for supply-chain change detection.
  if (failOnNew && baselineHosts && newHosts.length > 0 && baselineHosts.size > 0) {
    if (!json) {
      console.error(color("red", `\nFAIL: ${newHosts.length} new third-party host${newHosts.length > 1 ? "s" : ""} appeared since baseline:`));
      for (const h of newHosts) console.error(color("red", `  + ${h}`));
      console.error(color("dim", `\n  Use --write-baseline to accept these additions, or audit them as a potential supply-chain change.`));
    }
    if (json) console.log(JSON.stringify(manifest, null, 2));
    process.exit(4);
  }

  if (json) {
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }

  // Pretty terminal table
  console.log("");
  console.log(`  ${color("bold", "Supply-chain HNDL exposure")} for ${color("violet", domain)}`);
  console.log(`  ${color("dim", `${summary.uniqueOrigins} unique third-party origins · ${summary.totalReferences} references · weakest: ${summary.weakestLink?.host ?? "—"} (${summary.weakestLink?.grade ?? "—"})`)}`);
  // CSP-quality summary line — single line, site-wide. Mirrors the banner the
  // extension shows on the Supply Chain tab.
  if (cspVerdict.quality === "absent") {
    console.log(`  ${color("red", "✗ No CSP enforcement")} ${color("dim", "— vendor swaps go undetected by the browser")}`);
  } else if (cspVerdict.quality === "weak") {
    console.log(`  ${color("yellow", "⚠ CSP is permissive")} ${color("dim", `— uses unsafe-inline / wildcards / data: (${cspVerdict.source})`)}`);
  } else if (cspVerdict.quality === "strict") {
    console.log(`  ${color("green", "✓ Strict CSP enforced")} ${color("dim", `(${cspVerdict.source})`)}`);
  }
  if (baselineHosts) {
    const baselineSize = baselineHosts.size;
    if (baselineSize === 0) {
      console.log(`  ${color("dim", `Baseline: ${baselinePath} is empty — first run; all hosts will be captured.`)}`);
    } else {
      const newColor = newHosts.length > 0 ? "yellow" : "green";
      const newLabel = newHosts.length > 0 ? `${newHosts.length} NEW since baseline` : "no new hosts since baseline";
      const missingPart = missingHosts.length > 0 ? `, ${missingHosts.length} missing` : "";
      console.log(`  ${color(newColor, newLabel)}${color("dim", `${missingPart} · baseline ${baselinePath}`)}`);
    }
  }
  console.log("");
  console.log(`  ${color("dim", "GRADE  HOST                                          VENDOR (CATEGORY)        PQC  SRI  TYPES")}`);
  console.log(`  ${color("dim", "─────  ─────────────────────────────────────────  ──────────────────────  ───  ───  ─────")}`);
  for (const r of results) {
    const gradeStr = r.scan?.grade ?? "?";
    const gradeColored = gradeStr === "A" ? color("green", gradeStr) : gradeStr === "F" || gradeStr === "D" ? color("red", gradeStr) : color("yellow", gradeStr);
    const hostRaw = r.host + (r.isNew ? " *NEW*" : "");
    const host = hostRaw.length > 41 ? hostRaw.slice(0, 40) + "…" : (r.host.padEnd(r.isNew ? 35 : 41, " ") + (r.isNew ? color("yellow", " *NEW*") : ""));
    const pqc = r.scan?.hybridPQC ? color("green", "yes") : color("dim", "no ");
    const hasScript = (r.types || []).includes("script");
    const sriCell = !hasScript ? color("dim", "n/a") : r.anyMissingSri ? color("yellow", "off") : color("green", "on ");
    const types = r.types.join(",");
    // Vendor classification — "(New Relic · errors)" beats "bam.nr-data.net"
    // for comprehension. Padded to 22 chars so the table columns stay aligned.
    // Heuristic matches return `name: null` and just a category — render as
    // "(cdn — inferred)" to signal we're guessing without claiming certainty.
    const vendor = classifyVendor(r.host);
    let vendorStrRaw;
    if (vendor?.name) {
      vendorStrRaw = `${vendor.name} (${vendor.category})`;
    } else if (vendor?.category) {
      vendorStrRaw = `(${vendor.category} — inferred)`;
    } else {
      vendorStrRaw = "—";
    }
    const vendorTruncated = vendorStrRaw.length > 22 ? vendorStrRaw.slice(0, 21) + "…" : vendorStrRaw.padEnd(22, " ");
    const vendorColored = color("dim", vendorTruncated);
    console.log(`  ${gradeColored.padEnd(8, " ")}  ${host}  ${vendorColored}  ${pqc}  ${sriCell}  ${color("dim", types)}`);
  }
  console.log("");
  if (baselineHosts && baselineHosts.size > 0 && newHosts.length > 0) {
    console.log(`  ${color("yellow", "⚠")} ${color("dim", `${newHosts.length} new third-party host${newHosts.length > 1 ? "s" : ""} not in baseline. Audit, then run with --write-baseline to accept.`)}`);
    console.log("");
  }
  console.log(`  ${color("dim", "Each row scanned via")} ${color("violet", "/api/scan")}${color("dim", " · /methodology/browser-extension explains scoring")}`);
  console.log("");

  if (lock) {
    // Filename policy mirrors `pqcheck lock`: prefer the new cipherwake-deps.lock,
    // but if a legacy quantapact-deps.lock exists in this dir, overwrite that one
    // in place so the user's repo doesn't suddenly grow a second lockfile.
    const fsSync = await import("node:fs");
    const legacyDepsLock = path.join(outDir, "quantapact-deps.lock");
    const legacyDepsMd = path.join(outDir, "quantapact-deps-report.md");
    const hasLegacy = fsSync.existsSync(legacyDepsLock);
    const lockPath = hasLegacy
      ? legacyDepsLock
      : path.join(outDir, "cipherwake-deps.lock");
    const mdPath = hasLegacy
      ? legacyDepsMd
      : path.join(outDir, "cipherwake-deps-report.md");
    try {
      await fs.mkdir(outDir, { recursive: true });
      await fs.writeFile(lockPath, JSON.stringify(manifest, null, 2));
      await fs.writeFile(mdPath, depsManifestToMarkdown(manifest));
      console.log(`  ${color("bold", "Wrote")} ${color("violet", lockPath)} ${color("dim", "and")} ${color("violet", mdPath)}`);
      console.log(`  ${color("dim", "Commit these to track third-party crypto posture changes in PR diffs.")}`);
      console.log("");
    } catch (err) {
      console.error(color("red", `error writing lockfile: ${err.message}`));
      process.exit(1);
    }
  }

  // Allowlist gate: exit non-zero if any third-party host isn't in the allowlist.
  if (allowlist) {
    const violations = results.filter(r => !allowlist.has(r.host));
    if (violations.length > 0) {
      if (!json) {
        console.error("");
        console.error(color("red", `  ✗ Allowlist violation: ${violations.length} third-party origin(s) not in allowlist:`));
        for (const v of violations) console.error(`    - ${v.host}`);
        console.error("");
      }
      process.exit(3);
    } else if (!json) {
      console.log(`  ${color("green", "✓")} ${color("dim", "All third-party origins on allowlist.")}`);
      console.log("");
    }
  }
}

async function fetchPageHTML(domain) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const resp = await fetch(`https://${domain}/`, {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "User-Agent": `pqcheck-cli/${VERSION}${CI_ACTION_SUFFIX} (deps; +https://cipherwake.io)` },
    });
    clearTimeout(t);
    if (!resp.ok) return null;
    const html = await resp.text();
    // Also capture the CSP header so the deps view can show the site-wide
    // enforcement level. Report-only header is ignored (not enforced).
    const headerCsp = resp.headers.get("content-security-policy") || "";
    return { html, headerCsp };
  } catch {
    return null;
  }
}

// Scrape <meta http-equiv="Content-Security-Policy" content="..."> from HTML
// as a fallback when the response header is absent.
function extractMetaCsp(html) {
  const re = /<meta[^>]*\bhttp-equiv\s*=\s*["']?content-security-policy["']?[^>]*\bcontent\s*=\s*["']([^"']+)["']/i;
  const m = html.match(re);
  return m ? m[1] : "";
}

// Site-level CSP-quality classifier. Mirrors lib/serviceCatalog.ts and the
// extension's classifyCsp(). Three buckets: absent / weak / strict.
function classifyCsp(headerCsp, metaCsp) {
  const policy = ((headerCsp || "").trim() || (metaCsp || "").trim()).toLowerCase();
  if (!policy) return { quality: "absent", source: null, raw: "" };
  const weakSignals = ["'unsafe-inline'", "'unsafe-eval'", "'unsafe-hashes'", " * ", " *;", "data:", "blob:"];
  const weak = weakSignals.some((sig) => policy.includes(sig));
  return {
    quality: weak ? "weak" : "strict",
    source: (headerCsp || "").trim() ? "header" : "meta",
    raw: policy,
  };
}

// Compact vendor catalog — covers ~50 most common third-party origins so the
// pretty table can show "(New Relic · errors)" instead of just "bam.nr-data.net".
// Mirror of lib/serviceCatalog.ts + extension/popup.js SERVICE_CATALOG; keep
// the three in sync when adding vendors.
const SERVICE_CATALOG = {
  "googletagmanager.com": { name: "Google Tag Manager", category: "analytics" },
  "google-analytics.com": { name: "Google Analytics", category: "analytics" },
  "googleadservices.com": { name: "Google Ads", category: "ads" },
  "doubleclick.net": { name: "Google DoubleClick", category: "ads" },
  "googleapis.com": { name: "Google APIs", category: "cdn" },
  "gstatic.com": { name: "Google Static", category: "cdn" },
  "recaptcha.net": { name: "Google reCAPTCHA", category: "captcha" },
  "youtube.com": { name: "YouTube", category: "social" },
  "cloudflare.com": { name: "Cloudflare", category: "cdn" },
  "cdnjs.cloudflare.com": { name: "Cloudflare cdnjs", category: "cdn" },
  "cloudflareinsights.com": { name: "Cloudflare Web Analytics", category: "analytics" },
  "challenges.cloudflare.com": { name: "Cloudflare Turnstile", category: "captcha" },
  "stripe.com": { name: "Stripe", category: "payments" },
  "js.stripe.com": { name: "Stripe Checkout", category: "payments" },
  "amazonaws.com": { name: "AWS S3", category: "cdn" },
  "cloudfront.net": { name: "AWS CloudFront", category: "cdn" },
  "clarity.ms": { name: "Microsoft Clarity", category: "analytics" },
  "azureedge.net": { name: "Azure CDN", category: "cdn" },
  "facebook.com": { name: "Facebook", category: "social" },
  "facebook.net": { name: "Facebook Pixel", category: "ads" },
  "fbcdn.net": { name: "Facebook CDN", category: "cdn" },
  "connect.facebook.net": { name: "Facebook Pixel", category: "ads" },
  "twitter.com": { name: "Twitter (X)", category: "social" },
  "linkedin.com": { name: "LinkedIn", category: "social" },
  "snap.licdn.com": { name: "LinkedIn Tracking", category: "ads" },
  "use.typekit.net": { name: "Adobe Fonts", category: "fonts" },
  "typekit.net": { name: "Adobe Fonts", category: "fonts" },
  "paypal.com": { name: "PayPal", category: "payments" },
  "auth0.com": { name: "Auth0", category: "auth" },
  "okta.com": { name: "Okta", category: "auth" },
  "intercomcdn.com": { name: "Intercom", category: "support" },
  "zendesk.com": { name: "Zendesk", category: "support" },
  "sentry.io": { name: "Sentry", category: "errors" },
  "browser.sentry-cdn.com": { name: "Sentry", category: "errors" },
  "js-agent.newrelic.com": { name: "New Relic", category: "errors" },
  "bam.nr-data.net": { name: "New Relic", category: "errors" },
  "datadoghq.com": { name: "Datadog", category: "errors" },
  "browser-intake-datadoghq.com": { name: "Datadog RUM", category: "errors" },
  "mailchimp.com": { name: "Mailchimp", category: "analytics" },
  "hubspot.com": { name: "HubSpot", category: "analytics" },
  "js.hubspot.com": { name: "HubSpot Tracking", category: "analytics" },
  "segment.com": { name: "Segment", category: "analytics" },
  "amplitude.com": { name: "Amplitude", category: "analytics" },
  "mxpnl.com": { name: "Mixpanel", category: "analytics" },
  "hotjar.com": { name: "Hotjar", category: "analytics" },
  "plausible.io": { name: "Plausible Analytics", category: "analytics" },
  "js.hcaptcha.com": { name: "hCaptcha", category: "captcha" },
  "cdn.jsdelivr.net": { name: "jsDelivr CDN", category: "cdn" },
  "unpkg.com": { name: "unpkg CDN", category: "cdn" },
  "code.jquery.com": { name: "jQuery CDN", category: "cdn" },
  "akamaihd.net": { name: "Akamai CDN", category: "cdn" },
  "akamaized.net": { name: "Akamai CDN", category: "cdn" },
  "fastly.net": { name: "Fastly CDN", category: "cdn" },
  "bootstrapcdn.com": { name: "Bootstrap CDN", category: "cdn" },
  "maxcdn.bootstrapcdn.com": { name: "Bootstrap CDN", category: "cdn" },
  "cookielaw.org": { name: "OneTrust Cookie Consent", category: "consent" },
  "cookiebot.com": { name: "Cookiebot", category: "consent" },
  "vimeo.com": { name: "Vimeo", category: "social" },
  "shopify.com": { name: "Shopify", category: "ecommerce" },
  "cdn.shopify.com": { name: "Shopify CDN", category: "ecommerce" },
  "tiktok.com": { name: "TikTok", category: "social" },
};

// Conservative heuristic patterns — same as lib/serviceCatalog.ts + popup.js.
// Used when a host isn't in the explicit catalog. Doesn't name the vendor
// (we don't know), but assigns a high-confidence category like "cdn" or
// "ads" so unknown hosts aren't blank.
const HEURISTIC_PATTERNS = [
  // CDN
  { re: /^cdn[.-]/, category: "cdn" },
  { re: /^static\./, category: "cdn" },
  { re: /^assets\./, category: "cdn" },
  { re: /\.cloudfront\.net$/, category: "cdn" },
  { re: /\.akamai(?:edge|hd|ized)?\.net$/, category: "cdn" },
  { re: /\.fastly\.net$/, category: "cdn" },
  { re: /\.azureedge\.net$/, category: "cdn" },
  // Analytics / RUM
  { re: /^analytics?\./, category: "analytics" },
  { re: /^metrics?\./, category: "analytics" },
  { re: /^telemetry\./, category: "analytics" },
  { re: /^rum\./, category: "analytics" },
  // Ads
  { re: /^ads?[.-]/, category: "ads" },
  { re: /^adserver\./, category: "ads" },
  { re: /^pubads\./, category: "ads" },
  { re: /\.advertising\./, category: "ads" },
  // Consent / cookies
  { re: /^consent\./, category: "consent" },
  { re: /^cookies?\./, category: "consent" },
  { re: /^gdpr\./, category: "consent" },
  // Fonts
  { re: /^fonts?\./, category: "fonts" },
  // Errors / monitoring
  { re: /^sentry[.-]/, category: "errors" },
];

function classifyVendor(host) {
  if (!host) return null;
  const lower = host.toLowerCase();
  if (SERVICE_CATALOG[lower]) return SERVICE_CATALOG[lower];
  for (const pattern of Object.keys(SERVICE_CATALOG)) {
    if (lower === pattern || lower.endsWith("." + pattern)) {
      return SERVICE_CATALOG[pattern];
    }
  }
  for (const { re, category } of HEURISTIC_PATTERNS) {
    if (re.test(lower)) {
      // Inferred — no vendor name, just the category. CLI consumers (the
      // pretty table + JSON output) check `name === null` to distinguish
      // from explicit catalog matches.
      return { name: null, category };
    }
  }
  return null;
}

function extractThirdPartyRefs(html, targetDomain) {
  const out = [];
  const targetRoot = registeredDomain(targetDomain);

  // For <script> tags specifically, capture the FULL tag so we can extract
  // the integrity attribute (SRI). Other tag types use simple src/href match.
  const scriptTagRe = /<script\b([^>]*)>/gi;
  let m;
  while ((m = scriptTagRe.exec(html)) !== null) {
    const attrs = m[1] || "";
    const srcMatch = attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    if (!srcMatch) continue;
    const integrityMatch = attrs.match(/\bintegrity\s*=\s*["']([^"']+)["']/i);
    try {
      const u = new URL(srcMatch[1], `https://${targetDomain}`);
      if (u.protocol !== "http:" && u.protocol !== "https:") continue;
      const host = u.hostname.toLowerCase();
      if (!host || host === targetDomain || registeredDomain(host) === targetRoot) continue;
      out.push({
        host,
        type: "script",
        sri: !!(integrityMatch && integrityMatch[1].trim()),
        loadedOverHttps: u.protocol === "https:",
      });
    } catch { /* relative URL or malformed */ }
  }

  // Non-script types: iframe / link / img — no SRI applies
  const otherPatterns = [
    { type: "iframe", re: /<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi },
    { type: "link",   re: /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi },
    { type: "img",    re: /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi },
  ];
  for (const { type, re } of otherPatterns) {
    let mm;
    while ((mm = re.exec(html)) !== null) {
      try {
        const u = new URL(mm[1], `https://${targetDomain}`);
        if (u.protocol !== "http:" && u.protocol !== "https:") continue;
        const host = u.hostname.toLowerCase();
        if (!host || host === targetDomain || registeredDomain(host) === targetRoot) continue;
        out.push({ host, type, sri: false, loadedOverHttps: u.protocol === "https:" });
      } catch { /* relative URL or malformed */ }
    }
  }
  return out;
}

// Cheap registered-domain helper — covers common 2-label TLDs (co.uk, com.au, etc.)
function registeredDomain(host) {
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const last2 = parts.slice(-2).join(".");
  const doubleTLDs = new Set([
    "co.uk", "co.jp", "co.nz", "co.za", "com.au", "com.br", "com.cn", "com.mx",
    "com.tr", "ne.jp", "ac.uk", "gov.uk", "org.uk", "edu.au", "gov.au",
  ]);
  if (doubleTLDs.has(last2)) return parts.slice(-3).join(".");
  return last2;
}

function buildDepsSummary(results) {
  const byGrade = { A: 0, B: 0, C: 0, D: 0, F: 0, "?": 0 };
  let totalRefs = 0;
  let scoreSum = 0;
  let scoreN = 0;
  let pqcCount = 0;
  let weakest = null;
  for (const r of results) {
    totalRefs += r.occurrences;
    const g = r.scan?.grade ?? "?";
    byGrade[g] = (byGrade[g] || 0) + 1;
    if (typeof r.scan?.score === "number") {
      scoreSum += r.scan.score;
      scoreN += 1;
      if (!weakest || r.scan.score > weakest.score) {
        weakest = { host: r.host, grade: r.scan.grade, score: r.scan.score };
      }
    }
    if (r.scan?.hybridPQC) pqcCount += 1;
  }
  return {
    uniqueOrigins: results.length,
    totalReferences: totalRefs,
    byGrade,
    averageScore: scoreN > 0 ? Math.round((scoreSum / scoreN) * 10) / 10 : null,
    hybridPQCCount: pqcCount,
    weakestLink: weakest,
  };
}

function depsManifestToMarkdown(m) {
  const lines = [];
  lines.push(`# Supply-chain HNDL exposure: ${m.domain}`);
  lines.push("");
  lines.push(`Scanned at \`${m.scannedAt}\` by \`${m.tool}@${m.toolVersion}\`.`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- **Unique third-party origins:** ${m.summary.uniqueOrigins}`);
  lines.push(`- **Total references:** ${m.summary.totalReferences}`);
  lines.push(`- **Average HNDL score:** ${m.summary.averageScore ?? "—"} / 10`);
  lines.push(`- **Hybrid-PQC origins:** ${m.summary.hybridPQCCount} / ${m.summary.uniqueOrigins}`);
  if (m.summary.weakestLink) {
    lines.push(`- **Weakest link:** \`${m.summary.weakestLink.host}\` — grade ${m.summary.weakestLink.grade}, score ${m.summary.weakestLink.score}`);
  }
  lines.push("");
  lines.push("## Grade distribution");
  lines.push("");
  lines.push("| Grade | Count |");
  lines.push("|---|---|");
  for (const g of ["A", "B", "C", "D", "F", "?"]) {
    if ((m.summary.byGrade[g] || 0) > 0) lines.push(`| ${g} | ${m.summary.byGrade[g]} |`);
  }
  lines.push("");
  lines.push("## Third parties");
  lines.push("");
  lines.push("| Grade | Host | PQC | Types | Occurrences |");
  lines.push("|---|---|---|---|---|");
  for (const tp of m.thirdParties) {
    const grade = tp.scan?.grade ?? "?";
    const pqc = tp.scan?.hybridPQC ? "yes" : "no";
    lines.push(`| ${grade} | \`${tp.host}\` | ${pqc} | ${tp.types.join(", ")} | ${tp.occurrences} |`);
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("*Methodology: [/methodology/browser-extension](" + m.evidence.methodology + "). Re-run `npx pqcheck deps " + m.domain + " --lock` to refresh; commit the lockfile to track changes in pull requests.*");
  lines.push("");
  return lines.join("\n");
}

// =============================================================================
// SARIF + GitHub Action output formats
// =============================================================================

// Derive a SARIF-stable rule ID from a finding. Prefer the registry's stable
// `id` (e.g., "tls.rsa_kex_fallback") so the same finding gets the same
// ruleId every run — without it, GitHub Code Scanning treats a reordered
// finding list as a fresh batch of new findings, blowing up the triage UX.
// Short non-crypto hash for SARIF rule-ID disambiguation. djb2-style.
// Pure JS so it works in both Node and the CLI bundle. 8-char hex output
// is enough entropy to disambiguate distinct legacy findings without
// becoming churn-prone — same input string always produces the same hash.
function shortHash(input) {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function stableRuleId(f) {
  if (f && typeof f.id === "string" && f.id.length > 0) {
    // Normalize: if a registry ID already carries the `pqcheck.` prefix
    // (which happened before this helper existed), don't double-prefix
    // it into `pqcheck.pqcheck.tls...`. Strip and reattach.
    const id = f.id.replace(/^pqcheck\./i, "");
    return `pqcheck.${id}`;
  }
  // Fallback for legacy findings emitted without the registry — slug the
  // title. Still stable across runs (same input → same output).
  const title = f?.title || "finding";
  const detail = f?.detail || "";
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  // GPT adversarial review 2026-05-12: legacy findings with similar
  // titles ("No HSTS header" vs "No HSTS Header!") both slug to
  // "no_hsts_header" and would collide in SARIF, causing GitHub Code
  // Scanning to merge unrelated findings. Append a short hash of the
  // full (title + detail) so semantically-different findings get
  // distinct rule IDs even when their slugged titles match.
  const disambiguator = shortHash(`${title}|${detail}`);
  if (slug.length === 0) {
    return `pqcheck.legacy.unnamed.${disambiguator}`;
  }
  return `pqcheck.legacy.${slug}.${disambiguator}`;
}

// Deduplicate the `rules` array — multiple findings can share the same
// underlying rule (e.g., two cert findings both pinned to `cert.expired`).
// SARIF's rule list must contain each rule once.
function dedupeRules(findings) {
  const seen = new Set();
  const out = [];
  for (const f of findings) {
    const id = stableRuleId(f);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(f);
  }
  return out;
}

function reportToSarif(report) {
  // SARIF 2.1.0 minimal schema for security findings.
  // Spec: https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html
  const findings = Array.isArray(report.findings) ? report.findings : [];
  const sevMap = { critical: "error", high: "error", medium: "warning", low: "note" };
  return {
    $schema: "https://docs.oasis-open.org/sarif/sarif/v2.1.0/cos02/schemas/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs: [{
      tool: {
        driver: {
          name: "pqcheck",
          version: VERSION,
          informationUri: "https://cipherwake.io",
          // Stable rule IDs — anchored to the finding's registry id (e.g.
          // "tls.rsa_kex_fallback") when present, otherwise a slug derived
          // from the title. Previously used positional pqcheck-${i+1} which
          // made GitHub Code Scanning see every reorder as a "new" finding,
          // poisoning the dedup/triage UX. Stable IDs let Code Scanning
          // recognize the same rule across runs.
          rules: dedupeRules(findings).map((f) => ({
            id: stableRuleId(f),
            name: (f.title || "finding").replace(/[^A-Za-z0-9]/g, "_"),
            shortDescription: { text: f.title || "finding" },
            fullDescription: { text: f.detail || f.title || "finding" },
            defaultConfiguration: { level: sevMap[f.severity] || "note" },
          })),
        },
      },
      results: findings.map((f) => ({
        ruleId: stableRuleId(f),
        level: sevMap[f.severity] || "note",
        message: { text: `${f.title || "finding"}${f.detail ? ` — ${f.detail}` : ""}` },
        // GitHub Code Scanning requires file: scheme (or relative path) for
        // artifactLocation.uri — https:// URIs are rejected. Use a virtual
        // relative path so findings show up cleanly in the Security tab.
        locations: [{
          physicalLocation: {
            artifactLocation: { uri: `cipherwake-scan/${report.domain || "unknown"}.txt` },
            region: { startLine: 1, startColumn: 1 },
          },
        }],
        properties: {
          domain: report.domain,
          score: report.score,
          grade: report.grade,
          severity: f.severity,
          reportUrl: `https://www.cipherwake.io/r/${report.domain || ""}`,
        },
      })),
      properties: {
        score: report.score,
        grade: report.grade,
        domain: report.domain,
      },
    }],
  };
}

function printGitHubActionAnnotations(report) {
  // GitHub Actions workflow command syntax: https://docs.github.com/en/actions/using-workflows/workflow-commands-for-github-actions
  const findings = Array.isArray(report.findings) ? report.findings : [];
  const sevMap = { critical: "error", high: "error", medium: "warning", low: "notice" };
  // Surface degraded-cache state as a workflow warning so it lands in the
  // PR check summary — devs need to know they may be gating on stale data.
  if (report._meta?.degraded) {
    const reason = String(report._meta.degradedReason || "live probe failed").replace(/[\r\n]/g, " ").replace(/::/g, ":");
    const since = String(report._meta.lastUpdated || "unknown");
    console.log(`::warning title=Cipherwake: cached score (live probe failed)::Showing last known-good score from ${since}. Reason: ${reason}. Re-run shortly for a fresh probe.`);
  }
  // Top-line score/grade as a notice
  console.log(`::notice title=Cipherwake: ${report.domain}::Grade ${report.grade || "?"} · score ${report.score ?? "?"} / 10`);
  for (const f of findings) {
    const cmd = sevMap[f.severity] || "notice";
    const title = (f.title || "finding").replace(/[\r\n]/g, " ");
    const msg = (f.detail || f.title || "").replace(/[\r\n]/g, " ").replace(/::/g, ":");
    console.log(`::${cmd} title=${title}::${msg}`);
  }
}

// =============================================================================
// `pqcheck history` — show recent score history for a domain
// =============================================================================

async function runHistoryCommand(args) {
  const json = args.includes("--json");
  const positional = args.filter((a) => !a.startsWith("-"));
  const domain = positional.length > 0 ? normalizeDomain(positional[0]) : null;
  if (!domain || !isValidDomain(domain)) {
    console.error(color("red", "error: pqcheck history requires a valid domain"));
    console.error(color("dim", "Usage: npx pqcheck history <domain> [--json]"));
    process.exit(1);
  }
  const days = (() => {
    const i = args.indexOf("--days");
    if (i === -1) return 90;
    const n = parseInt(args[i + 1] || "90", 10);
    return Number.isFinite(n) && n > 0 && n <= 365 ? n : 90;
  })();

  let h;
  try {
    const r = await fetch(`${API_BASE}/api/history?domain=${encodeURIComponent(domain)}&days=${days}`, {
      headers: apiHeaders({ "user-agent": `pqcheck-cli/${VERSION}${CI_ACTION_SUFFIX} (history)` }),
    });
    if (!r.ok) {
      console.error(color("red", `error: ${r.status} ${r.statusText}`));
      process.exit(1);
    }
    h = await r.json();
  } catch (err) {
    console.error(color("red", `error: ${err.message}`));
    process.exit(1);
  }

  if (json) {
    console.log(JSON.stringify(h, null, 2));
    return;
  }

  const points = Array.isArray(h?.points) ? h.points : [];
  if (points.length === 0) {
    console.log(`  ${color("violet", domain)} ${color("dim", "·")} no history found`);
    console.log(color("dim", "  (need at least one previous scan; try `npx pqcheck " + domain + "` first)"));
    return;
  }
  const sorted = points.slice().reverse(); // oldest → newest
  const first = sorted[0].score;
  const last = sorted[sorted.length - 1].score;
  const delta = last - first;
  const min = Math.min(...sorted.map(p => p.score));
  const max = Math.max(...sorted.map(p => p.score));
  const trend = Math.abs(delta) < 0.1 ? "→ flat" : delta > 0 ? `↑ +${delta.toFixed(1)} (worsened)` : `↓ ${delta.toFixed(1)} (improved)`;

  console.log("");
  console.log(`  ${color("bold", domain)} ${color("dim", "·")} score history (${days}d, ${sorted.length} samples)`);
  console.log(`  ${color("dim", `range ${min.toFixed(1)} – ${max.toFixed(1)} · trend ${trend}`)}`);
  console.log("");
  // Compact ASCII sparkline (flat → centered dots; varying → ramp blocks)
  const isFlat = Math.abs(max - min) < 0.05;
  let bar = "";
  if (isFlat) {
    bar = "·".repeat(sorted.length);
  } else {
    const range = max - min;
    const ramp = "▁▂▃▄▅▆▇█";
    for (const p of sorted) {
      const idx = Math.min(ramp.length - 1, Math.floor(((p.score - min) / range) * (ramp.length - 1)));
      bar += ramp[idx];
    }
  }
  console.log(`  ${color("violet", bar)}`);
  console.log("");
  // Tail of recent samples — accept either recordedAt or scannedAt or date
  console.log(`  ${color("dim", "Recent samples (most-recent first):")}`);
  for (const p of points.slice(0, 8)) {
    const dateRaw = p.recordedAt || p.scannedAt || p.date || "";
    const date = String(dateRaw).slice(0, 10) || "—".padEnd(10, " ");
    console.log(`    ${color("dim", date)}  score ${color("bold", p.score?.toFixed(1) ?? "?")}  grade ${p.grade ?? "?"}`);
  }
  console.log("");
}

// =============================================================================
// `pqcheck changes <domain>` — surface observation-table deltas for a domain
// =============================================================================
// Hits /api/changes-summary which aggregates the new observation tables
// shipped 2026-05-13 (subdomain_observations, script_observations,
// posture_snapshots, cert_observations). Returns "N attack-surface changes
// in last 14d" + breakdown. Devs use this in CI ("did anything change since
// yesterday?") and in PR descriptions ("attached: 3 changes detected since
// last week").

async function runChangesCommand(args) {
  const json = args.includes("--json");
  const positional = args.filter((a) => !a.startsWith("-"));
  const domain = positional.length > 0 ? normalizeDomain(positional[0]) : null;
  if (!domain || !isValidDomain(domain)) {
    console.error(color("red", "error: pqcheck changes requires a valid domain"));
    console.error(color("dim", "Usage: npx pqcheck changes <domain> [--json]"));
    process.exit(1);
  }

  let summary;
  try {
    const r = await fetch(`${API_BASE}/api/changes-summary?domain=${encodeURIComponent(domain)}`, {
      headers: apiHeaders({ "user-agent": `pqcheck-cli/${VERSION}${CI_ACTION_SUFFIX} (changes)` }),
    });
    if (!r.ok) {
      console.error(color("red", `error: ${r.status} ${r.statusText}`));
      process.exit(1);
    }
    summary = await r.json();
  } catch (err) {
    console.error(color("red", `error: ${err.message}`));
    process.exit(1);
  }

  if (json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const tracked = summary.trackedSince;
  const total = summary.changes?.last14d ?? 0;
  const b = summary.breakdown ?? {};
  console.log("");
  console.log(`  ${color("bold", domain)} ${color("dim", "·")} attack-surface change summary`);

  if (!tracked) {
    console.log(color("dim", "  No observation history yet. Run `npx pqcheck " + domain + "` to start accumulating."));
    console.log("");
    return;
  }

  const trackedDate = String(tracked).slice(0, 10);
  console.log(color("dim", `  Tracking since ${trackedDate}`));
  console.log("");

  if (total === 0) {
    console.log(`  ${color("green", "✓")} No public attack-surface changes detected in the last 14 days.`);
    console.log("");
    return;
  }

  console.log(`  ${color("yellow", "⚠")} ${color("bold", total)} change${total === 1 ? "" : "s"} detected in the last 14 days:`);
  console.log("");
  if (b.newSubdomains14d) {
    console.log(`    ${color("violet", "•")} ${color("bold", b.newSubdomains14d)} new subdomain${b.newSubdomains14d === 1 ? "" : "s"} observed in CT logs or live scans`);
  }
  if (b.newScripts14d) {
    console.log(`    ${color("violet", "•")} ${color("bold", b.newScripts14d)} new third-party script host${b.newScripts14d === 1 ? "" : "s"} loaded`);
  }
  if (b.newCertKeys14d) {
    console.log(`    ${color("violet", "•")} ${color("bold", b.newCertKeys14d)} new SPKI fingerprint${b.newCertKeys14d === 1 ? "" : "s"} (cert rotation with new key)`);
  }
  console.log("");
  console.log(color("dim", `  Full changelog: ${API_BASE}/domain/${domain}/security-changelog`));
  console.log("");
}

// =============================================================================
// `pqcheck diff` — diff two QXM lockfiles
// =============================================================================

/**
 * `pqcheck trust-diff <domain>` — compare current public trust posture vs a
 * baseline via /api/trust-diff. Phase 2 launch feature (CLI v0.11.0).
 *
 * Inputs:
 *   --baseline    last-week | last-month | last-scan | <ISO date>  (default: last-week)
 *   --fail-on     any | low | medium | high | critical              (default: high)
 *   --format      pretty | json | sarif | github                    (default: pretty)
 *
 * Exit codes:
 *   0 = pass     — no deltas at or above fail-on severity
 *   1 = warn     — deltas observed but below fail-on threshold
 *   2 = fail     — deltas observed at or above fail-on threshold
 *   3 = error    — auth/quota/network failure
 *
 * Authentication paths (per server's applyRepoQuota — supports all three):
 *   • CIPHERWAKE_API_KEY=qpk_... (paid quota, higher cap, off-Actions usage)
 *   • GITHUB_ACTIONS=true + id-token (OIDC, keyless, Free 100 calls/repo/mo)
 *   • No auth (anonymous per-IP rate limit — first-use friction-free path)
 *
 * R74-confirm friction fix (GPT 2026-05-22): previously the CLI hard-gated
 * on CIPHERWAKE_API_KEY before even attempting the call, which broke the
 * frictionless first-use AI-coder funnel. The hard-gate was gratuitous —
 * the server has supported anonymous calls since the applyRepoQuota
 * middleware shipped. Now the CLI just attempts the call with whatever
 * auth context is available; server applies the appropriate quota path.
 */
// R74-confirm friction fix (GPT 2026-05-22): when deploy-check has no
// baseline yet (first-deploy of a brand-new domain), fall through to
// /api/scan and emit ship_decision based on current absolute findings.
// This makes `pqcheck deploy-check <new-domain> --ai` work on first call
// with zero setup — no API key, no prior scan, nothing.
async function runScanBasedDeployCheck(domain, args) {
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": `pqcheck-cli/${VERSION}${CI_ACTION_SUFFIX}`,
  };
  if (QP_API_KEY) headers["Authorization"] = `Bearer ${QP_API_KEY}`;

  let resp;
  try {
    resp = await fetch(`${API_BASE}/api/scan?domain=${encodeURIComponent(domain)}`, { headers });
  } catch (err) {
    // v0.16.17 — the v0.16.13 fail-loud AI guard fix was applied to the main
    // trust-diff deploy-check path but missed THIS fallback path (no-baseline
    // first-deploy), so a network blip on the very first `pqcheck deploy-check
    // <new-domain> --ai` exited 3 with no CIPHERWAKE_AI_GUARD_RESULT block.
    // The calling AI agent then had no ship_decision to route on and could
    // silently continue shipping — exactly the failure mode the protocol
    // exists to prevent. Same emit-block-and-exit pattern as trust-diff.
    console.error(color("red", `error: network failure calling /api/scan: ${err.message}`));
    return emitAiGuardReviewAndExit(args, {
      code: "deploy_check_fetch_failed",
      message: `Network failure calling /api/scan: ${err?.message || "fetch failed"}`,
      exitCode: 3,
    });
  }
  if (!resp.ok) {
    // v0.16.17 — same fix as above for the HTTP-non-OK path. The 429 case
    // is especially load-bearing: a brand new AI-coder workflow trying its
    // first deploy-check on a fresh project will commonly hit per-IP rate
    // limits, get a bare `error: /api/scan returned 429`, and exit 3 with no
    // guard block. The AI agent then has nothing to parse. Emitting a
    // ship_decision=review block with a quota-specific error code lets the
    // agent surface the rate-limit problem to the user instead of silently
    // continuing. Surface the body message + auth hint when available so
    // the user knows whether to wait or get an API key.
    const body = await safeJSON(resp);
    const statusLabel = resp.status === 429
      ? "rate-limited"
      : resp.status === 401 || resp.status === 403
        ? "auth failed"
        : `${resp.status}`;
    console.error(color("red", `error: /api/scan returned ${resp.status} (${statusLabel})`));
    if (body?.message) console.error(color("dim", body.message));
    if (body?.hint) console.error(color("dim", body.hint));
    if (resp.status === 429) {
      console.error(color("dim", "Higher quota via free API key (no card): https://cipherwake.io/account#api-keys"));
    }
    const code = resp.status === 429
      ? "deploy_check_rate_limited"
      : resp.status === 401 || resp.status === 403
        ? "deploy_check_auth_failed"
        : "deploy_check_scan_failed";
    const message = resp.status === 429
      ? (body?.message || "Per-IP rate limit hit on /api/scan. Wait ~1 minute or use an API key for higher quota.")
      : body?.message || `Cipherwake /api/scan returned ${resp.status}.`;
    return emitAiGuardReviewAndExit(args, { code, message, exitCode: 3 });
  }
  const report = await resp.json();
  const findings = Array.isArray(report.findings) ? report.findings : [];
  const maxSev = highestSeverity(findings);
  let shipDecision = computeShipDecision({ maxSeverity: maxSev });
  const topFinding = [...findings].sort((a, b) => severityRank(b.severity) - severityRank(a.severity))[0];

  // Unreachable / degraded → force "block" with an UNREACHABLE display label
  // downstream. See main scan path for the rationale: an undeployed-or-broken
  // domain can't be evaluated, so the AI agent must halt announcement and ask
  // the human (was this expected? did the deploy fail?). The `unreachable`
  // field travels in the state file + structured block so statusline /
  // VS Code ext / chat-hook can render "UNREACHABLE" instead of generic
  // "BLOCK" — semantically clearer for this specific failure mode.
  // Treat as "cannot evaluate" — and route through the UNREACHABLE label —
  // when either:
  //   • reachable === false  (no TCP/TLS handshake at all)
  //   • scanAvailable === false  (TCP/TLS up, but scan couldn't produce a
  //     coherent fingerprint — e.g. medium.com churning vendor scripts
  //     faster than our dual-fingerprint check)
  //
  // _meta.degraded alone is too broad (fires on cache fallback + mid-scan
  // state changes on otherwise-scoreable domains like stripe.com), so we
  // narrow to the structured failure signals the server emits.
  const unreachable = report?.reachable === false || report?.scanAvailable === false;
  if (unreachable) {
    shipDecision = "block";
  }

  let topIssue, whyMatters, nextActions;
  if (unreachable) {
    const isUnstable = report?.reason === "scan_unstable";
    topIssue = isUnstable
      ? "[REACHABILITY] Scan unstable — site changing faster than we can scan it"
      : "[REACHABILITY] Domain unreachable — TLS probe failed or DNS unresolved";
    whyMatters = report?.userMessage || report?._meta?.degradedReason || (isUnstable
      ? "The scanner reached the site but couldn't produce a coherent fingerprint — rolling deploy, rapid A/B variation, or fast vendor-script rotation. Retry usually succeeds once the site settles."
      : "The scanner couldn't reach the domain on port 443. Either DNS hasn't propagated, the deploy hasn't completed, or this domain isn't deployed at the address we expected.");
    nextActions = isUnstable
      ? [
          `Wait ~1 minute then retry: npx pqcheck deploy-check ${domain} --ai`,
          `View full report (last successful scan): ${API_BASE}/r/${domain}`,
        ]
      : [
          `Check the domain is correct (typo?): ${domain}`,
          `Verify DNS: dig +short ${domain}`,
          `Verify deploy completed and TLS is live on https://${domain}`,
          `Re-run after fix: npx pqcheck deploy-check ${domain} --ai`,
        ];
  } else {
    topIssue = topFinding
      ? `[${String(topFinding.severity || "").toUpperCase()}] ${topFinding.title || topFinding.detail || "finding"}`
      : "No findings at or above LOW severity.";
    whyMatters = topFinding?.detail || "DBR scoring measures harvest-now-decrypt-later risk on the public TLS surface.";
    nextActions = shipDecision === "pass"
      ? [`Domain looks healthy on first scan. View full report: ${API_BASE}/r/${domain}`]
      : [
          `Review finding above and decide if it was intentional.`,
          `View full report: ${API_BASE}/r/${domain}`,
          `Subsequent deploy-checks will diff against this scan as baseline.`,
        ];
  }

  // v0.16.0 high-yield rendering — same shape as runOneScan but with the
  // "first-deploy" context line above the brand header (since this path
  // fires only when there's no baseline to diff against).
  const verbose = isVerboseMode(args);
  const highSevFindings = findings.filter((f) => severityRank(f.severity) >= 3);
  const alertCount = highSevFindings.length;

  console.log("");
  console.log(color("dim", `  ℹ first deploy-check for ${domain} — using current scan state (no baseline yet to diff against)`));
  console.log("");
  console.log(formatBrandHeader(domain));
  console.log("");
  console.log(formatDecisionPulse({ shipDecision, alertCount, unreachable, diffContext: true }));

  if (unreachable) {
    console.log(formatAiBody({ topIssue, whyMatters, nextActions }));
  } else {
    if (alertCount > 0) {
      const alerts = formatAlertsLine(highSevFindings);
      if (alerts) console.log(alerts);
    }
    const tpl = formatTrustPostureLine(report);
    if (tpl) console.log(tpl);
    const vsl = formatVerifiedSignalsLine(report);
    if (vsl) console.log(vsl);
    if (verbose) {
      console.log("");
      console.log(formatHighYieldVerbose(report));
    } else {
      console.log(color("dim", "  Run with --verbose to see all verified signals."));
    }
  }

  console.log(formatAiFooterBlock({
    status: shipDecision,
    domain,
    kind: "scan",
    dbr: report.score,
    grade: report.grade,
    max_severity: maxSev,
    ship_decision: shipDecision,
    unreachable: unreachable ? "true" : "false",
    top_issue: unreachable
      ? "findings.reachability.unreachable"
      : (topFinding ? `findings.${topFinding.id || "unknown"}` : "none"),
    findings_high: findings.filter((f) => severityRank(f.severity) >= severityRank("high")).length,
    findings_critical: findings.filter((f) => severityRank(f.severity) >= severityRank("critical")).length,
    scanned_at: new Date().toISOString(),
    advisory_only: true,
    note: unreachable
      ? "domain unreachable on port 443; deploy may have failed or DNS not propagated"
      : "first-deploy: no baseline yet, scored on current state",
  }));

  await writeLastScanFile({
    domain,
    kind: "scan",
    score: typeof report.score === "number" ? report.score : null,
    grade: report.grade || null,
    max_severity: maxSev,
    ship_decision: shipDecision,
    unreachable: unreachable || false,
    top_issue: unreachable
      ? "findings.reachability.unreachable"
      : (topFinding?.id || topFinding?.title || null),
    note: unreachable
      ? "domain unreachable on port 443; deploy may have failed or DNS not propagated"
      : "first-deploy: no baseline yet, scored on current state",
  });

  // Exit code: 0 on pass, non-zero on review/block (matches deploy-check contract)
  process.exit(shipDecision === "pass" ? 0 : 1);
}

async function runTrustDiffCommand(args) {
  const positional = args.filter((a) => !a.startsWith("-") && !isFlagValue(args, a));
  if (positional.length === 0) {
    console.error(color("red", "error: pqcheck trust-diff requires a domain"));
    console.error(color("dim", "Usage: npx pqcheck trust-diff <domain> [--baseline last-week] [--fail-on high] [--format pretty|json|sarif|github]"));
    process.exit(3);
  }
  const domain = normalizeDomain(positional[0]);
  if (!domain) {
    console.error(color("red", `error: invalid domain "${positional[0]}"`));
    process.exit(3);
  }

  const baseline = parseFlag(args, "--baseline") || "last-week";
  const failOn = parseFlag(args, "--fail-on") || "high";
  const format = parseFlag(args, "--format") || "pretty";

  // Build headers conditionally — Authorization is set ONLY if the user has
  // an API key. Without it, the server's applyRepoQuota falls through to the
  // anonymous per-IP rate limit path (just like /api/scan).
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": `pqcheck-cli/${VERSION}${CI_ACTION_SUFFIX}`,
  };
  if (QP_API_KEY) {
    headers["Authorization"] = `Bearer ${QP_API_KEY}`;
  }

  let resp;
  try {
    resp = await fetch(`${API_BASE}/api/trust-diff`, {
      method: "POST",
      headers,
      body: JSON.stringify({ domain, baseline, fail_on: failOn }),
    });
  } catch (err) {
    console.error(color("red", `error: network failure calling /api/trust-diff: ${err.message}`));
    // v0.16.13: in AI mode, emit a ship_decision=review block so the
    // calling agent doesn't silently treat a fetch failure as "no signal".
    return emitAiGuardReviewAndExit(args, {
      code: "deploy_check_fetch_failed",
      message: `Network failure: ${err?.message || "fetch failed"}`,
      exitCode: 3,
    });
  }

  if (resp.status === 401 || resp.status === 403) {
    await handleAuthError(resp);
    return emitAiGuardReviewAndExit(args, {
      code: "deploy_check_auth_failed",
      message: `Authorization failed (${resp.status}). Check CIPHERWAKE_API_KEY or hit /account#api-keys.`,
      exitCode: 3,
    });
  }
  if (resp.status === 429) {
    const body = await safeJSON(resp);
    console.error(color("red", "error: Trust Diff API quota exceeded"));
    if (body?.message) console.error(color("dim", body.message));
    console.error(color("dim", "Higher quota via free API key (no card): https://cipherwake.io/account#api-keys"));
    return emitAiGuardReviewAndExit(args, {
      code: "deploy_check_quota_exceeded",
      message: body?.message || "Trust Diff monthly quota exceeded — upgrade or wait for monthly reset.",
      exitCode: 3,
    });
  }
  // R74-confirm friction fix #2 (GPT 2026-05-22): 404 on first-deploy is
  // expected — the domain has never been scanned, so there's no baseline to
  // diff against. Instead of asking the user to run `pqcheck <domain>` first
  // (a friction step that breaks the AI-coder funnel), automatically fall
  // through to /api/scan, populate the cache, and emit ship_decision based
  // on the scan's current absolute state. Subsequent deploy-checks will
  // have a baseline and produce a real drift verdict.
  if (resp.status === 404 && parseAiMode(args)) {
    return await runScanBasedDeployCheck(domain, args);
  }
  if (!resp.ok) {
    const body = await safeJSON(resp);
    console.error(color("red", `error: /api/trust-diff returned ${resp.status}`));
    if (body?.message) console.error(color("dim", body.message));
    if (body?.hint) console.error(color("dim", body.hint));
    return emitAiGuardReviewAndExit(args, {
      code: "deploy_check_server_error",
      message: body?.message || `Cipherwake server returned ${resp.status}.`,
      exitCode: 3,
    });
  }

  const result = await resp.json();
  const verdict = result.verdict || "pass";
  const deltas = Array.isArray(result.deltas) ? result.deltas : [];

  // AI Coder Mode — three-layer output (banner / body / structured block).
  if (parseAiMode(args)) {
    const maxSev = highestSeverity(deltas);
    const hasUnexpectedDiff = deltas.length > 0;
    const shipDecision = computeShipDecision({ maxSeverity: maxSev, hasUnexpectedDiff });
    const topDelta = [...deltas].sort((a, b) => severityRank(b.severity) - severityRank(a.severity))[0];

    const topIssue = topDelta
      ? `[${String(topDelta.severity || "").toUpperCase()}] ${topDelta.title || topDelta.type}${topDelta.what_changed ? ` — ${topDelta.what_changed}` : ""}`
      : "No deltas observed since baseline.";
    const whyMatters = topDelta
      ? `This change happened between your baseline (${baseline}) and now. If it's an intentional change you shipped, accept it. If unexpected, your domain's posture drifted without an associated deploy — investigate before the diff compounds.`
      : `Your public trust posture is stable since ${baseline}. No CSP / HSTS / cert / SPKI / DMARC / vendor-script regressions.`;
    const nextActions = shipDecision === "pass"
      ? [`Posture stable. Safe to announce deploy.`]
      : [
          `Review each delta and decide if it was intentional.`,
          `If intentional: accept (no action needed in CI; quota tick recorded).`,
          `If not intentional: revert the deploy or investigate the drift source.`,
        ];

    // v0.16.0 high-yield rendering for trust-diff.
    const verbose = isVerboseMode(args);
    const diffNoChange = deltas.length === 0;
    const fakeReport = {
      domain,
      score: result.current_score,
      grade: result.current_grade,
      _meta: { lastChanged: result.last_changed },
      sectorRanking: result.sectorRanking,
    };

    console.log("");
    console.log(formatBrandHeader(domain));
    console.log("");
    console.log(formatDecisionPulse({ shipDecision, alertCount: deltas.length, unreachable: false, diffContext: true }));

    if (deltas.length > 0) {
      // Surface top deltas as alerts
      const alertFindings = deltas.slice(0, 3).map((d) => ({
        severity: d.severity || "medium",
        title: d.title || d.what_changed || d.type || "drift",
        id: d.id,
      }));
      const alerts = formatAlertsLine(alertFindings);
      if (alerts) console.log(alerts);
      if (deltas.length > 3) console.log(color("dim", `  +${deltas.length - 3} more (run with --verbose)`));
    }
    const tpl = formatTrustPostureLine(fakeReport);
    if (tpl) console.log(tpl);
    const vsl = formatVerifiedSignalsLine(fakeReport, { diffNoChange });
    if (vsl) console.log(vsl);
    if (!verbose) {
      console.log(color("dim", "  Run with --verbose to see all verified signals."));
    }

    console.log(formatAiFooterBlock({
      status: shipDecision,
      domain,
      kind: "trust-diff",
      baseline,
      verdict,
      delta_count: deltas.length,
      max_severity: maxSev,
      ship_decision: shipDecision,
      top_issue: topDelta?.id || topDelta?.type || "none",
      top_issue_title: topDelta?.title || "",
      dbr: typeof result.current_score === "number" ? result.current_score.toFixed(1) : "",
      grade: result.current_grade || "",
      quota_used: result.quota?.used_this_month ?? "",
      quota_limit: result.quota?.monthly_limit ?? "",
      scanned_at: new Date().toISOString(),
      advisory_only: "true",
    }));
    console.log("");

    await writeLastScanFile({
      domain,
      kind: "trust-diff",
      score: typeof result.current_score === "number" ? result.current_score : null,
      grade: result.current_grade || null,
      max_severity: maxSev,
      ship_decision: shipDecision,
      baseline,
      delta_count: deltas.length,
      top_issue: topDelta?.id || topDelta?.title || null,
    });

    process.exit(shipDecisionExitCode(shipDecision));
  }

  // Format output
  if (format === "json") {
    console.log(JSON.stringify(result, null, 2));
  } else if (format === "sarif") {
    console.log(JSON.stringify(trustDiffToSarif(result), null, 2));
  } else if (format === "github") {
    // GitHub Actions workflow command output
    for (const d of deltas) {
      const sev = d.severity === "critical" || d.severity === "high" ? "error" : d.severity === "medium" ? "warning" : "notice";
      const msg = `${d.title || d.type}: ${d.what_changed || ""}`.replace(/\n/g, "%0A").replace(/\r/g, "");
      console.log(`::${sev}::${msg}`);
    }
    console.log(`\nTrust Diff verdict: ${verdict.toUpperCase()} — ${deltas.length} delta${deltas.length === 1 ? "" : "s"} observed.`);
    console.log(`Quota: ${result.quota?.used_this_month || 0}/${result.quota?.monthly_limit || 0} used.`);
  } else {
    // pretty (default)
    console.log("");
    console.log(`  ${color("bold", "Cipherwake Trust Diff")}`);
    console.log(`  ${color("dim", `${domain} · baseline=${baseline} · fail-on=${failOn}`)}`);
    console.log("");
    if (deltas.length === 0) {
      console.log(`  ${color("green", "✓ No deltas observed")}`);
    } else {
      const colorByLevel = (sev) => sev === "critical" ? "red" : sev === "high" ? "red" : sev === "medium" ? "yellow" : "dim";
      for (const d of deltas) {
        const sevTag = d.severity ? `[${d.severity.toUpperCase()}]` : "";
        console.log(`  ${color(colorByLevel(d.severity), sevTag)} ${d.title || d.type}`);
        if (d.what_changed) console.log(`    ${color("dim", d.what_changed)}`);
      }
    }
    console.log("");
    const verdictColor = verdict === "fail" ? "red" : verdict === "warn" ? "yellow" : "green";
    console.log(`  Verdict: ${color(verdictColor, verdict.toUpperCase())}`);
    console.log(`  Quota: ${result.quota?.used_this_month || 0}/${result.quota?.monthly_limit || 0} used this month`);
    if (result.upgrade_hint) {
      console.log("");
      console.log(`  ${color("dim", "💡 " + result.upgrade_hint)}`);
    }
  }

  // Exit code based on verdict
  if (verdict === "fail") process.exit(2);
  if (verdict === "warn") process.exit(1);
  process.exit(0);
}

/**
 * `pqcheck preview-diff --preview <URL> --production <URL>` — compare a preview
 * deployment URL against a production canonical URL. Surfaces new third-party
 * scripts, security-header regressions, and DBR score drops. CLI v0.14.0.
 *
 * Inputs:
 *   --preview <URL>       Preview deployment URL (required)
 *   --production <URL>    Production canonical URL (required)
 *   --compare-transport   Include TLS/cert/SPKI in verdict (default off — preview
 *                         URLs are typically edge-hosted by Vercel/Netlify/Cloudflare
 *                         and direct transport comparison is noise).
 *   --fail-on <severity>  any | low | medium | high | critical (default high).
 *                         Honored on paid tiers; Free is report-only.
 *   --format              pretty (default) | json
 *
 * Exit codes match trust-diff: 0 pass · 1 warn · 2 fail · 3 error.
 *
 * Authentication paths (server's applyRepoQuota supports all three):
 *   • CIPHERWAKE_API_KEY=qpk_... (paid quota, higher cap)
 *   • GITHUB_ACTIONS=true + id-token (OIDC, keyless, Free 100 calls/repo/mo)
 *   • No auth (anonymous per-IP rate limit — frictionless first-use)
 *
 * R74-confirm friction fix (GPT 2026-05-22): the hard-gate on API key has
 * been removed; server applyRepoQuota handles all 3 auth paths, including
 * anonymous per-IP rate limit for frictionless first use.
 */
// v0.16.6 R76 — collect custom protected paths from flags + config file.
// Returns a sanitized array (max 20 entries, each ≤200 chars, starts with "/").
// Server applies the same sanitizer, so anything that gets past this still
// gets filtered server-side — defense in depth.
async function loadCustomProtectedPaths(args) {
  const out = [];
  // Source 1: --protected-path flag, repeatable
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--protected-path" && i + 1 < args.length) {
      out.push(args[i + 1]);
    }
  }
  // Source 2: .cipherwake/config.json `protectedPaths`
  try {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const cfgPath = path.join(process.cwd(), ".cipherwake", "config.json");
    const raw = await fs.readFile(cfgPath, "utf8");
    const cfg = JSON.parse(raw);
    if (Array.isArray(cfg.protectedPaths)) {
      for (const p of cfg.protectedPaths) {
        if (typeof p === "string") out.push(p);
      }
    }
  } catch {
    // No config file or invalid JSON — that's fine, fall back to flag-only.
  }
  // Sanitize + dedupe + cap
  const seen = new Set();
  const sanitized = [];
  for (const p of out) {
    const trimmed = String(p).trim();
    if (trimmed.length === 0 || trimmed.length > 200) continue;
    if (!trimmed.startsWith("/")) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    sanitized.push(trimmed);
    if (sanitized.length >= 20) break;
  }
  return sanitized;
}

// v0.16.9 R80 — EXPERIMENTAL Site Guards. Load .cipherwake/guards.json
// (when --guards flag is present). Returns a {version, guards[]} object or
// null when --guards is absent / file missing / invalid. Sanitization runs
// AGAIN server-side via sanitizeGuardsConfig — both layers run so the API
// never trusts arbitrary structure that landed in the request body.
async function loadSiteGuards(args) {
  if (!args.includes("--guards")) return null;
  try {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const cfgPath = path.join(process.cwd(), ".cipherwake", "guards.json");
    const raw = await fs.readFile(cfgPath, "utf8");
    const cfg = JSON.parse(raw);
    if (!cfg || typeof cfg !== "object" || !Array.isArray(cfg.guards)) return null;
    // Pass through more-or-less verbatim; server sanitizes. We don't try to
    // duplicate the full sanitizer here — just sanity-check the shape so we
    // don't ship obviously bad payloads.
    return {
      version: typeof cfg.version === "number" ? cfg.version : 1,
      guards: cfg.guards.slice(0, 50),
    };
  } catch {
    return null;
  }
}

// v0.16.8 — collect first-party host overrides from flags + config file.
// PSL-backed subdomain auto-promote happens server-side regardless (scanning
// quantasyte.com always treats *.quantasyte.com as first-party). This list
// is the escape hatch for multi-domain shops whose owned hosts live under
// DIFFERENT registrable domains (acme.com + acmecdn.net). Up to 50 entries,
// each must pass a strict hostname regex (lowercase alphanumeric + hyphen
// labels separated by dots, no leading/trailing/double dots, ≤253 chars).
// Server applies the same sanitizer — defense in depth.
//
// Source priority:
//   1. --first-party-host flag, repeatable (e.g. --first-party-host api.acme.com)
//   2. .cipherwake/config.json `firstPartyHosts: string[]` in CWD
const FIRST_PARTY_HOST_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
async function loadFirstPartyHosts(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--first-party-host" && i + 1 < args.length) {
      out.push(args[i + 1]);
    }
  }
  try {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const cfgPath = path.join(process.cwd(), ".cipherwake", "config.json");
    const raw = await fs.readFile(cfgPath, "utf8");
    const cfg = JSON.parse(raw);
    if (Array.isArray(cfg.firstPartyHosts)) {
      for (const h of cfg.firstPartyHosts) {
        if (typeof h === "string") out.push(h);
      }
    }
  } catch {
    // No config file or invalid JSON — fall back to flag-only.
  }
  const seen = new Set();
  const sanitized = [];
  for (const h of out) {
    const norm = String(h).trim().toLowerCase();
    if (norm.length === 0 || norm.length > 253) continue;
    if (!FIRST_PARTY_HOST_RE.test(norm)) continue;
    if (seen.has(norm)) continue;
    seen.add(norm);
    sanitized.push(norm);
    if (sanitized.length >= 50) break;
  }
  return sanitized;
}

// v0.16.9 R80 — EXPERIMENTAL Site Guards subcommand surface.
// Subcommands:
//   pqcheck guards init [--domain D]   — create .cipherwake/guards.json with default guard set
//   pqcheck guards list                 — show configured guards + mode/severity
//   pqcheck guards run --preview URL    — run guards against a URL via preview-diff
//                       --production URL  (required because guards run as part of the same scan path)
//
// The full activate/observe/disable/approve-host/add-protected-path surface from
// the original spec is intentionally deferred — those are JSON edits the user
// can do by hand against `.cipherwake/guards.json`. We can add the editor sugar
// once the core flow has soaked in real use.
async function runGuardsCommand(args) {
  const sub = args[0];
  if (!sub || sub === "--help" || sub === "-h") {
    console.log(`${color("bold", "pqcheck guards")} — Site Guards beta (EXPERIMENTAL)`);
    console.log("");
    console.log("Subcommands:");
    console.log(`  ${color("cyan", "init")} [--domain D]              Create .cipherwake/guards.json with default guards`);
    console.log(`  ${color("cyan", "list")}                            Show configured guards from .cipherwake/guards.json`);
    console.log(`  ${color("cyan", "run")} --preview URL --production URL`);
    console.log(`                                  Run guards against a URL (uses preview-diff path)`);
    console.log("");
    console.log("Or pass " + color("bold", "--guards") + " to " + color("bold", "pqcheck preview-diff") + " to run guards alongside the diff.");
    console.log("");
    console.log(color("yellow", "BETA: Site Guards are experimental. New guards default to observe mode."));
    console.log(color("dim", "Docs: https://cipherwake.io/methodology/site-guards"));
    return;
  }
  if (sub === "init") return runGuardsInitCommand(args.slice(1));
  if (sub === "list") return runGuardsListCommand(args.slice(1));
  if (sub === "run") return runGuardsRunCommand(args.slice(1));
  console.error(color("red", `error: unknown guards subcommand: ${sub}`));
  console.error(color("dim", "Run `pqcheck guards --help` for usage."));
  process.exit(1);
}

async function runGuardsInitCommand(args) {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const domain = parseFlag(args, "--domain") || "your-domain.com";
  const force = args.includes("--force");
  const cfgDir = path.join(process.cwd(), ".cipherwake");
  const cfgPath = path.join(cfgDir, "guards.json");
  try {
    await fs.access(cfgPath);
    if (!force) {
      console.error(color("yellow", `warn: ${cfgPath} already exists. Pass --force to overwrite.`));
      process.exit(1);
    }
  } catch { /* file doesn't exist, fine */ }
  // Default set mirrors lib/siteGuards.ts defaultGuardsConfig — duplicated here
  // to avoid an import dependency from the CLI bundle on the TS lib at runtime.
  const defaults = {
    version: 1,
    domain,
    firstPartyHosts: [],
    guards: [
      { id: "no-source-maps", type: "source_map_exposure", mode: "observe", severity: "review" },
      { id: "no-mixed-content", type: "mixed_content", mode: "observe", severity: "review" },
      { id: "approved-hosts", type: "approved_hosts", mode: "observe", severity: "review", approvedHosts: [] },
      { id: "protected-admin", type: "protected_path", path: "/admin", expect: "401_or_302", mode: "observe", severity: "block" },
      { id: "session-cookie-flags", type: "cookie_flags", cookieNamePattern: "(?:session|sess|auth|token|sid|csrf|jwt)", require: ["Secure", "HttpOnly"], sameSiteMinimum: "Lax", mode: "observe", severity: "block" },
      { id: "primary-links-resolve", type: "link_integrity", mode: "observe", severity: "review" },
    ],
  };
  await fs.mkdir(cfgDir, { recursive: true });
  await fs.writeFile(cfgPath, JSON.stringify(defaults, null, 2) + "\n");
  console.log(color("green", `✓ wrote ${cfgPath}`));
  console.log(color("dim", "  6 guards configured · all in observe mode (default)"));
  console.log(color("dim", "  Edit guards.json to flip to active mode or seed approvedHosts."));
  console.log(color("dim", "  Then: npx pqcheck preview-diff --preview <URL> --production <URL> --guards"));
}

async function runGuardsListCommand(_args) {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const cfgPath = path.join(process.cwd(), ".cipherwake", "guards.json");
  let cfg;
  try {
    cfg = JSON.parse(await fs.readFile(cfgPath, "utf8"));
  } catch (err) {
    console.error(color("red", `error: could not read ${cfgPath}: ${err.message}`));
    console.error(color("dim", "Run `pqcheck guards init` to create one."));
    process.exit(1);
  }
  const guards = Array.isArray(cfg.guards) ? cfg.guards : [];
  if (guards.length === 0) {
    console.log(color("dim", "(no guards configured)"));
    return;
  }
  console.log(`${color("bold", `${guards.length} guard${guards.length === 1 ? "" : "s"}`)}${cfg.domain ? color("dim", ` · ${cfg.domain}`) : ""}`);
  for (const g of guards) {
    const mode = g.mode ?? "observe";
    const modeChip = mode === "active" ? color("cyan", `[${mode}]`)
      : mode === "disabled" ? color("dim", `[${mode}]`)
      : color("yellow", `[${mode}]`);
    const sev = color("dim", `· ${g.severity ?? "review"}`);
    console.log(`  ${modeChip} ${color("bold", g.id)} (${g.type}) ${sev}`);
  }
  console.log("");
  console.log(color("yellow", "BETA — Site Guards are experimental. Observe-mode guards never affect CI."));
}

async function runGuardsRunCommand(args) {
  // Convenience wrapper — re-runs preview-diff with --guards forced on.
  // Useful for "just run my guards, don't think about preview-diff" UX.
  if (!args.includes("--guards")) args = ["--guards", ...args];
  return runPreviewDiffCommand(args);
}

async function runPreviewDiffCommand(args) {
  const previewUrl = parseFlag(args, "--preview");
  const productionUrl = parseFlag(args, "--production");
  if (!previewUrl || !productionUrl) {
    console.error(color("red", "error: pqcheck preview-diff requires --preview and --production URLs"));
    console.error(color("dim", "Usage: npx pqcheck preview-diff --preview https://preview-xyz.vercel.app --production https://example.com [--compare-transport] [--fail-on high] [--format pretty|json] [--protected-path /api/admin/export]... [--first-party-host api.acme.com]..."));
    process.exit(3);
  }

  const compareTransport = args.includes("--compare-transport");
  const failOn = parseFlag(args, "--fail-on") || "high";
  const format = parseFlag(args, "--format") || "pretty";

  // R66 (B4 / Q4.2 fix): policy_mode mirrors --fail-on intent.
  // `--fail-on none` (or `off`) → report-only; anything else → fail mode.
  // Server silently downgrades on Free tier; paid tier honors fail.
  // This makes the CLI exit-code semantics actually fire for paid users.
  const policyMode = ["none", "off", ""].includes(String(failOn).toLowerCase())
    ? "report"
    : "fail";

  // v0.16.6 R76 — custom protected paths. Source priority:
  //   1. --protected-path flag (repeatable, e.g. --protected-path /api/admin/export)
  //   2. .cipherwake/config.json `protectedPaths: string[]` in CWD
  // Sanitized + capped server-side. Lets each customer probe their own auth-
  // gated routes alongside the universal default list.
  const customProtectedPaths = await loadCustomProtectedPaths(args);

  // v0.16.8 — first-party host overrides. Server unconditionally treats
  // subdomains of the scanned hostname as first-party (PSL-backed); this
  // list adds owned hosts whose registrable domains differ.
  const customFirstPartyHosts = await loadFirstPartyHosts(args);

  // v0.16.9 R80 — EXPERIMENTAL Site Guards. Only loaded when --guards flag
  // is present; otherwise the request includes no site_guards block and the
  // response's site_guards array stays empty.
  const siteGuardsPayload = await loadSiteGuards(args);

  const headers = {
    "Content-Type": "application/json",
    "User-Agent": `pqcheck-cli/${VERSION}${CI_ACTION_SUFFIX}`,
  };
  if (QP_API_KEY) {
    headers["Authorization"] = `Bearer ${QP_API_KEY}`;
  }

  let resp;
  try {
    resp = await fetch(`${API_BASE}/api/preview-diff`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        preview_url: previewUrl,
        production_url: productionUrl,
        compare_transport: compareTransport,
        fail_on: failOn,
        policy_mode: policyMode,
        ...(customProtectedPaths.length > 0 ? { protected_paths: customProtectedPaths } : {}),
        ...(customFirstPartyHosts.length > 0 ? { first_party_hosts: customFirstPartyHosts } : {}),
        ...(siteGuardsPayload ? { site_guards: siteGuardsPayload } : {}),
      }),
    });
  } catch (err) {
    console.error(color("red", `error: network failure calling /api/preview-diff: ${err.message}`));
    process.exit(3);
  }

  if (resp.status === 401 || resp.status === 403) {
    await handleAuthError(resp);
    process.exit(3);
  }
  if (resp.status === 429) {
    const body = await safeJSON(resp);
    console.error(color("red", "error: Preview Diff API quota exceeded for this month"));
    if (body?.message) console.error(color("dim", body.message));
    process.exit(3);
  }
  if (!resp.ok) {
    const body = await safeJSON(resp);
    console.error(color("red", `error: /api/preview-diff returned ${resp.status}`));
    if (body?.message) console.error(color("dim", body.message));
    // Server-side may return a `hint` field on rejected inputs (e.g. localhost
    // / private-IP URLs surface the tunnel-options hint). Print it so the
    // user knows what to do next instead of just seeing the rejection.
    if (body?.hint) console.error(color("dim", body.hint));
    process.exit(3);
  }

  const result = await resp.json();
  const verdict = result?.result?.verdict || "pass";
  const summaryLines = result?.result?.summary_lines || [];
  // v0.16.6 R78 — plain-English "what this means" sentence per finding,
  // parallel to summaryLines. Renders as a dim sub-line under each tech
  // line so non-security readers see the consequence at a glance.
  const summaryLinesHuman = result?.result?.summary_lines_human || [];

  // AI Coder Mode — three-layer output (banner / body / structured block).
  if (parseAiMode(args)) {
    const maxSev = result?.result?.max_severity || "none";
    const hasUnexpectedDiff = summaryLines.some((l) => !/no meaningful/i.test(l));
    const prevScore = result?.preview?.score;
    const prodScore = result?.production?.score;
    const scoreDelta = (typeof prevScore === "number" && typeof prodScore === "number")
      ? Number((prevScore - prodScore).toFixed(2))
      : null;
    const shipDecision = computeShipDecision({ maxSeverity: maxSev, hasUnexpectedDiff, scoreDelta });

    const firstDelta = summaryLines.find((l) => !/no meaningful/i.test(l));
    const topIssue = firstDelta || "No meaningful application-surface changes between preview and production.";
    const whyMatters = hasUnexpectedDiff
      ? `Preview URL introduces application-surface changes vs production. If you intentionally added (e.g.) a new third-party script or relaxed a CSP, accept and merge. If unexpected, the change is hidden in this PR's bundle — investigate before merge.`
      : `Your preview is application-equivalent to production. No new vendors, no header regressions, no DBR score drop.`;
    const nextActions = shipDecision === "pass"
      ? [`Preview matches production. Safe to merge.`]
      : [
          `Review the changes above in this PR before merging.`,
          `Each "+ New third-party script" is a real new third-party request your users will make on this deploy.`,
          `Each "- CSP weakened" or "~ HSTS weakened" reduces production safety.`,
        ];

    // v0.16.3 high-yield rendering for preview-diff. Uses the per-side
    // `signals` snapshot returned by /api/preview-diff so the customer
    // sees N vs N+1 on every signal (not just the binary "no drift").
    // Falls back to the v0.16.2 shape when the server hasn't deployed
    // the signals snapshot yet (older API response).
    const verbose = isVerboseMode(args);
    const diffNoChange = !hasUnexpectedDiff;
    const prevSig = result?.preview?.signals || null;
    const prodSig = result?.production?.signals || null;
    // Brand header uses the production hostname (e.g. "quantapact.com")
    // not the full Vercel preview URL, so the customer doesn't see
    // "◆ Cipherwake — https://quantapact-k3y...vercel.app".
    const headerDomain = result?.production?.hostname || result?.production?.domain || productionUrl;
    // Synthesize a report-shaped object from the production-side signals
    // snapshot so the existing trust-posture + verified-signals helpers
    // (which read .score, .grade, .sectorRanking, .cookies, etc.) work
    // without changes.
    const reportLike = prodSig ? {
      domain: headerDomain,
      score: prodSig.score,
      grade: prodSig.grade,
      _meta: { lastChanged: prodSig.lastChanged },
      sectorRanking: prodSig.sectorRanking,
      publicDeps: prodSig.publicDeps ? { fetched: true, thirdParties: new Array(prodSig.publicDeps.thirdPartyCount || 0) } : null,
      httpHeaders: prodSig.httpHeaders,
      cookies: prodSig.cookies,
      sourceMaps: prodSig.sourceMaps,
      mixedContent: prodSig.mixedContent,
      cert: prodSig.cert,
      tlsVersion: prodSig.tlsVersion,
      publicSurface: prodSig.publicSurface,
      protectedPaths: prodSig.protectedPaths,
    } : {
      // Fallback: legacy server, only score/grade available.
      domain: headerDomain,
      score: prevScore,
      grade: result?.preview?.grade,
      _meta: { lastChanged: result?.production?.lastChanged },
      sectorRanking: result?.production?.sectorRanking,
    };
    // Render top deltas as alert lines (1 per finding, max 3)
    const deltaLines = summaryLines.filter((l) => !/no meaningful/i.test(l));

    console.log("");
    console.log(formatBrandHeader(headerDomain) + color("dim", "  (preview ↔ production)"));
    console.log("");
    console.log(formatDecisionPulse({ shipDecision, alertCount: deltaLines.length, unreachable: false, diffContext: true }));

    if (deltaLines.length > 0) {
      // v0.16.6 R78 — find the matching human-readable line for each tech
      // line. summaryLinesHuman is parallel-indexed to summaryLines, so we
      // re-derive the index from the original (unfiltered) summaryLines
      // array.
      for (const dl of deltaLines.slice(0, 3)) {
        const sym = dl.startsWith("⛔") || dl.startsWith("-") ? "red" : dl.startsWith("⚠") || dl.startsWith("~") ? "yellow" : "dim";
        console.log(color(sym, dl));
        const idx = summaryLines.indexOf(dl);
        const human = idx >= 0 ? summaryLinesHuman[idx] : null;
        if (human) console.log(color("dim", `   → ${human}`));
      }
      if (deltaLines.length > 3) console.log(color("dim", `  +${deltaLines.length - 3} more (run with --verbose)`));
    }
    const tpl = formatTrustPostureLine(reportLike);
    if (tpl) console.log(tpl);
    const vsl = formatVerifiedSignalsLine(reportLike, { diffNoChange });
    if (vsl) console.log(vsl);
    // v0.16.3 — per-signal N vs N+1 comparison. Renders ALWAYS (default and
    // --verbose), in different shapes:
    //   - default: 1-line "9/9 signals match (preview ↔ production)" so the
    //     customer sees the checks fired without scrolling
    //   - --verbose: per-row table with both sides spelled out
    const scriptDeltas = Array.isArray(result?.result?.application_surface?.scripts)
      ? result.result.application_surface.scripts
      : [];
    const psl = formatPreviewDiffPerSignal(prevSig, prodSig, { verbose, scriptDeltas });
    if (psl) console.log(psl);
    if (!verbose) {
      console.log(color("dim", "  Run with --verbose to see per-signal breakdown."));
    }

    // (Old banner + body removed in v0.16.2; new high-yield layout above
    // replaces them. AI footer still lands below for downstream agents.)
    if (verbose) {
      console.log("");
      console.log(formatAiBody({ topIssue, whyMatters, nextActions }));
    }
    console.log(formatAiFooterBlock({
      status: shipDecision,
      domain: result?.production?.domain || productionUrl,
      kind: "preview-diff",
      preview_url: previewUrl,
      production_url: productionUrl,
      verdict,
      max_severity: maxSev,
      delta_count: summaryLines.filter((l) => !/no meaningful/i.test(l)).length,
      ship_decision: shipDecision,
      preview_dbr: typeof prevScore === "number" ? prevScore.toFixed(1) : "",
      production_dbr: typeof prodScore === "number" ? prodScore.toFixed(1) : "",
      score_delta: scoreDelta !== null ? scoreDelta.toString() : "",
      top_issue: firstDelta || "none",
      scanned_at: new Date().toISOString(),
      advisory_only: "true",
    }));
    console.log("");

    // v0.16.4 — write the data the statusline needs to render its
    // 4-line preview-diff state (brand header + decision pulse + trust
    // posture + verified signals). For non-preview-diff kinds we keep
    // the 1-line statusline; only preview-diff gets the bigger format.
    const verifiedSignalCats = (() => {
      try { return countVerifiedSignals(reportLike).categories; } catch { return null; }
    })();
    await writeLastScanFile({
      domain: result?.production?.hostname || result?.production?.domain || productionUrl,
      kind: "preview-diff",
      preview_url: previewUrl,
      production_url: productionUrl,
      // v0.16.4 — score/grade come from the PRODUCTION side so the trust
      // posture line reflects the live customer site, not the in-flight
      // preview. (Was prevScore before — wrong reference.)
      score: typeof prodSig?.score === "number" ? prodSig.score : (typeof prevScore === "number" ? prevScore : null),
      grade: prodSig?.grade || null,
      max_severity: maxSev,
      ship_decision: shipDecision,
      delta_count: summaryLines.filter((l) => !/no meaningful/i.test(l)).length,
      diff_no_change: diffNoChange,
      sector_ranking: prodSig?.sectorRanking || null,
      verified_signal_categories: verifiedSignalCats,
      last_changed: prodSig?.lastChanged || null,
    });

    process.exit(shipDecisionExitCode(shipDecision));
  }

  if (format === "json") {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("");
    console.log(`  ${color("bold", "Cipherwake Preview Trust Diff")}`);
    console.log(`  ${color("dim", `preview=${previewUrl}`)}`);
    console.log(`  ${color("dim", `production=${productionUrl}`)}`);
    const prevScore = result?.preview?.score;
    const prodScore = result?.production?.score;
    if (typeof prevScore === "number" || typeof prodScore === "number") {
      console.log(`  ${color("dim", `DBR: preview=${typeof prevScore === "number" ? prevScore.toFixed(1) : "—"} · production=${typeof prodScore === "number" ? prodScore.toFixed(1) : "—"}`)}`);
    }
    console.log("");
    console.log(`  ${color("bold", "Application surface:")}`);
    if (summaryLines.length === 0 || (summaryLines.length === 1 && /no meaningful/i.test(summaryLines[0]))) {
      console.log(`    ${color("green", "✓ No meaningful application-surface changes detected.")}`);
    } else {
      // v0.16.6 R78 — pretty mode renders the tech line + dim layman sub-line.
      for (let i = 0; i < summaryLines.length; i++) {
        const line = summaryLines[i];
        const human = summaryLinesHuman[i];
        const c = line.startsWith("+") ? "yellow" : line.startsWith("-") ? "red" : "dim";
        console.log(`    ${color(c, line)}`);
        if (human) console.log(`      ${color("dim", "→ " + human)}`);
      }
    }
    console.log("");
    // v0.16.9 R80 — EXPERIMENTAL Site Guards rendering. Only shown when the
    // server returned a non-empty site_guards array. Renders status tally
    // (passed / failed / not_checked / probe_failed / not_applicable) then
    // per-guard one-liners. Observe-mode failures are labeled "observation"
    // so the customer reads them as informational. Active-mode failures use
    // the same prefix as preview-diff findings.
    const siteGuards = Array.isArray(result?.site_guards) ? result.site_guards : [];
    if (siteGuards.length > 0) {
      console.log(`  ${color("bold", "Site Guards")} ${color("yellow", "(BETA)")}`);
      const tally = { pass: 0, fail: 0, not_checked: 0, probe_failed: 0, not_applicable: 0 };
      for (const g of siteGuards) {
        tally[g.status] = (tally[g.status] ?? 0) + 1;
      }
      const tallyParts = [];
      if (tally.pass > 0) tallyParts.push(color("green", `${tally.pass} passed`));
      if (tally.fail > 0) tallyParts.push(color("red", `${tally.fail} failed`));
      if (tally.not_checked > 0) tallyParts.push(color("dim", `${tally.not_checked} disabled`));
      if (tally.probe_failed > 0) tallyParts.push(color("yellow", `${tally.probe_failed} probe-failed`));
      if (tally.not_applicable > 0) tallyParts.push(color("dim", `${tally.not_applicable} n/a`));
      console.log(`    ${siteGuards.length} guards checked: ${tallyParts.join(color("dim", " · "))}`);
      for (const g of siteGuards) {
        const isFail = g.status === "fail";
        const isPass = g.status === "pass";
        const isObserve = g.mode === "observe";
        const mark = isFail
          ? (isObserve ? color("yellow", "◌") : color("red", "⛔"))
          : isPass ? color("green", "✓")
          : g.status === "probe_failed" ? color("yellow", "?")
          : color("dim", "·");
        const label = isFail && isObserve
          ? color("dim", "observation:")
          : isFail ? color("red", "fail:")
          : color("dim", `${g.status}:`);
        console.log(`    ${mark} ${color("bold", g.id)} ${label} ${g.message}`);
        if (g.human) {
          console.log(`      ${color("dim", "→ " + g.human)}`);
        }
      }
      console.log("");
    }
    const transport = result?.result?.transport || {};
    if (transport.preview_is_edge_hosted) {
      console.log(`  ${color("dim", `Transport: preview is edge-hosted (${transport.preview_cert_issuer ?? "unknown"}) — informational only.`)}`);
    } else if (transport.preview_cert_issuer && transport.preview_cert_issuer !== transport.production_cert_issuer) {
      console.log(`  ${color("dim", `Transport: cert issuer differs (${transport.production_cert_issuer ?? "—"} → ${transport.preview_cert_issuer ?? "—"}).`)}`);
    }
    console.log("");
    const verdictColor = verdict === "fail" ? "red" : verdict === "warn" ? "yellow" : "green";
    console.log(`  Verdict: ${color(verdictColor, verdict.toUpperCase())} (max severity: ${result?.result?.max_severity || "info"})`);
    console.log(`  Tier: ${result?.tier || "free"} · policy: ${result?.policy_mode_effective || "report"}`);
    if (result.upgrade_hint) {
      console.log("");
      console.log(`  ${color("dim", "💡 " + result.upgrade_hint)}`);
    }
    console.log("");
  }

  if (verdict === "fail") process.exit(2);
  if (verdict === "warn") process.exit(1);
  process.exit(0);
}

/**
 * Convert /api/trust-diff response to SARIF 2.1.0 for upload via
 * github/codeql-action/upload-sarif@v3. Each delta becomes a result with
 * level = error|warning|note based on severity.
 */
function trustDiffToSarif(result) {
  const deltas = Array.isArray(result.deltas) ? result.deltas : [];
  const rules = [...new Set(deltas.map((d) => d.type))].map((type) => ({
    id: type,
    name: type,
    shortDescription: { text: type.replace(/_/g, " ").toLowerCase() },
    helpUri: `https://cipherwake.io/methodology/change-briefs#${type.toLowerCase()}`,
  }));
  const results = deltas.map((d) => ({
    ruleId: d.type,
    level: d.severity === "critical" || d.severity === "high" ? "error" : d.severity === "medium" ? "warning" : "note",
    message: { text: `${d.title || d.type}: ${d.what_changed || ""}` },
    locations: [{
      physicalLocation: {
        artifactLocation: { uri: `cipherwake://${result.domain || "domain"}` },
      },
    }],
  }));
  return {
    $schema: "https://schemastore.azurewebsites.net/schemas/json/sarif-2.1.0-rtm.5.json",
    version: "2.1.0",
    runs: [{
      tool: {
        driver: {
          name: "Cipherwake Trust Diff",
          version: VERSION,
          informationUri: "https://cipherwake.io",
          rules,
        },
      },
      results,
    }],
  };
}

function parseFlag(args, name) {
  const idx = args.indexOf(name);
  if (idx === -1 || idx === args.length - 1) return null;
  return args[idx + 1];
}

async function runDiffCommand(args) {
  const fs = await import("node:fs/promises");
  const json = args.includes("--json");
  const positional = args.filter((a) => !a.startsWith("-"));
  if (positional.length !== 2) {
    console.error(color("red", "error: pqcheck diff requires two lockfile paths"));
    console.error(color("dim", "Usage: npx pqcheck diff old.lock new.lock [--json]"));
    process.exit(1);
  }
  let oldLock, newLock;
  try {
    oldLock = JSON.parse(await fs.readFile(positional[0], "utf8"));
    newLock = JSON.parse(await fs.readFile(positional[1], "utf8"));
  } catch (err) {
    console.error(color("red", `error reading lockfile: ${err.message}`));
    process.exit(1);
  }

  const diff = computeLockDiff(oldLock, newLock);
  if (json) {
    console.log(JSON.stringify(diff, null, 2));
    process.exit(diff.regressed ? 2 : 0);
  }

  console.log("");
  console.log(`  ${color("bold", "Cipherwake lockfile diff")}`);
  console.log(`  ${color("dim", `${positional[0]} → ${positional[1]}`)}`);
  console.log("");
  if (diff.scoreChange !== null) {
    const arrow = diff.scoreChange > 0 ? color("red", "↑") : diff.scoreChange < 0 ? color("green", "↓") : color("dim", "→");
    const direction = diff.scoreChange > 0 ? "worsened" : diff.scoreChange < 0 ? "improved" : "unchanged";
    console.log(`  Score: ${color("bold", diff.oldScore?.toFixed(1) ?? "?")} → ${color("bold", diff.newScore?.toFixed(1) ?? "?")} ${arrow} ${diff.scoreChange.toFixed(1)} (${direction})`);
  }
  if (diff.gradeChange) {
    const colored = diff.regressed ? color("red", diff.newGrade) : color("green", diff.newGrade);
    console.log(`  Grade: ${diff.oldGrade ?? "?"} → ${colored}`);
  }
  if (diff.componentChanges?.length > 0) {
    console.log("");
    console.log(`  ${color("dim", "Component changes:")}`);
    for (const c of diff.componentChanges) {
      const arrow = c.change > 0 ? color("red", "↑") : color("green", "↓");
      console.log(`    ${c.name.padEnd(20, " ")} ${c.before?.toFixed(2) ?? "?"} → ${c.after?.toFixed(2) ?? "?"}  ${arrow} ${Math.abs(c.change).toFixed(2)}`);
    }
  }
  if (diff.findingsAdded?.length > 0) {
    console.log("");
    console.log(`  ${color("red", "+ New findings:")}`);
    for (const f of diff.findingsAdded) console.log(`    [${f.severity}] ${f.title}`);
  }
  if (diff.findingsResolved?.length > 0) {
    console.log("");
    console.log(`  ${color("green", "- Resolved findings:")}`);
    for (const f of diff.findingsResolved) console.log(`    [${f.severity}] ${f.title}`);
  }
  console.log("");
  process.exit(diff.regressed ? 2 : 0);
}

function computeLockDiff(oldLock, newLock) {
  const oldScore = typeof oldLock?.score === "number" ? oldLock.score : oldLock?.summary?.score;
  const newScore = typeof newLock?.score === "number" ? newLock.score : newLock?.summary?.score;
  const oldGrade = oldLock?.grade || oldLock?.summary?.grade;
  const newGrade = newLock?.grade || newLock?.summary?.grade;
  const scoreChange = (typeof oldScore === "number" && typeof newScore === "number") ? Math.round((newScore - oldScore) * 100) / 100 : null;
  const componentChanges = [];
  const oldComp = oldLock?.components || {};
  const newComp = newLock?.components || {};
  for (const k of Object.keys({ ...oldComp, ...newComp })) {
    const before = typeof oldComp[k]?.contribution === "number" ? oldComp[k].contribution : null;
    const after = typeof newComp[k]?.contribution === "number" ? newComp[k].contribution : null;
    if (before !== null && after !== null && Math.abs(after - before) >= 0.05) {
      componentChanges.push({ name: k, before, after, change: Math.round((after - before) * 100) / 100 });
    }
  }
  // Findings comparison by title
  const oldFindings = Array.isArray(oldLock?.findings) ? oldLock.findings : [];
  const newFindings = Array.isArray(newLock?.findings) ? newLock.findings : [];
  const oldTitles = new Set(oldFindings.map(f => f.title));
  const newTitles = new Set(newFindings.map(f => f.title));
  const findingsAdded = newFindings.filter(f => !oldTitles.has(f.title));
  const findingsResolved = oldFindings.filter(f => !newTitles.has(f.title));
  const regressed = (typeof scoreChange === "number" && scoreChange > 0.1) || findingsAdded.some(f => f.severity === "high" || f.severity === "critical");
  return {
    oldScore, newScore, oldGrade, newGrade, scoreChange,
    gradeChange: oldGrade !== newGrade,
    componentChanges,
    findingsAdded, findingsResolved,
    regressed,
  };
}

// =============================================================================
// `pqcheck cert <pem-file>` — analyze a local cert file (offline)
// =============================================================================

// `pqcheck watch <domain>` — adds the given domain to the user's watched-
// domain list via the authenticated /api/watched-domains POST. Requires
// CIPHERWAKE_API_KEY env var. Closes the CLI ↔ account loop: developers
// who use the CLI can now opt into persistent monitoring from the same
// surface without leaving the terminal.
async function runWatchCommand(args) {
  const positional = args.filter((a) => !a.startsWith("-"));
  if (positional.length === 0) {
    console.error(color("red", "error: pqcheck watch requires a domain"));
    console.error(color("dim", "Usage: npx pqcheck watch <domain>"));
    console.error("");
    console.error(color("dim", "Example: npx pqcheck watch chase.com"));
    process.exit(1);
  }
  if (!QP_API_KEY) {
    const rawDomain = positional[0] ? String(positional[0]).trim().toLowerCase() : "";
    const looksLikeDomain = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(rawDomain);
    console.error(color("red", "error: pqcheck watch requires CIPHERWAKE_API_KEY (paid tier)"));
    console.error("");
    console.error(color("dim", "Two ways to add this domain:"));
    if (looksLikeDomain) {
      console.error(color("dim", `  1. Sign up + click "Watch" in your browser:`));
      console.error(color("dim", `       ${API_BASE}/watch/${rawDomain}`));
    } else {
      console.error(color("dim", `  1. Sign up + click "Watch" in your browser:`));
      console.error(color("dim", `       ${API_BASE}/watch/<your-domain>`));
    }
    console.error(color("dim", `  2. Stay on the CLI — sign up + rotate an API key:`));
    console.error(color("dim", `       ${API_BASE}/signin`));
    console.error(color("dim", `       ${API_BASE}/account  (rotate key)`));
    console.error(color("dim", `       export CIPHERWAKE_API_KEY=qpk_...`));
    console.error("");
    console.error(color("dim", `Just want to poll locally without an account? Use --watch instead:`));
    console.error(color("dim", `  npx pqcheck ${looksLikeDomain ? rawDomain : "<your-domain>"} --watch 600`));
    console.error(color("dim", `  (No API key required. Polls every N seconds, logs on score change.)`));
    process.exit(1);
  }

  const raw = positional[0];
  const domain = normalizeDomain(raw);
  if (!isValidDomain(domain)) {
    console.error(color("red", `error: '${raw}' is not a valid domain`));
    process.exit(1);
  }

  console.log("");
  console.log(color("violet", `  📌 Adding ${domain} to your watched-domain list…`));

  let resp;
  try {
    resp = await fetch(`${API_BASE}/api/watched-domains`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": "Bearer " + QP_API_KEY,
      },
      body: JSON.stringify({ domain }),
    });
  } catch (err) {
    console.error(color("red", `  network error: ${err.message ?? err}`));
    process.exit(1);
  }

  if (resp.status === 401 || resp.status === 403) {
    console.error(color("red", `  authentication failed (HTTP ${resp.status})`));
    console.error(color("dim", `  Your API key may be invalid or revoked. Regenerate at ${API_BASE}/account`));
    process.exit(1);
  }

  let out = {};
  try { out = await resp.json(); } catch { /* ignore */ }

  if (!resp.ok) {
    if (out.error === "domain_already_watched") {
      console.log(color("dim", `  ${domain} is already on your watched-domain list.`));
      console.log(color("dim", `  Manage at: ${API_BASE}/account`));
      process.exit(0);
    }
    if (out.error === "tier_cap_exceeded") {
      console.error(color("red", `  ${out.message || "Tier cap reached."}`));
      console.error(color("dim", `  See pricing: ${API_BASE}/pricing`));
      process.exit(1);
    }
    if (out.error === "invalid_domain") {
      console.error(color("red", `  ${domain} is not a valid hostname.`));
      process.exit(1);
    }
    console.error(color("red", `  add failed: ${out.message || out.error || `HTTP ${resp.status}`}`));
    process.exit(1);
  }

  console.log("");
  console.log(color("green", `  ✓ Now watching ${domain}.`));
  console.log("");
  if (out.verificationInstructions) {
    const v = out.verificationInstructions;
    console.log(color("bold", "  Next: verify ownership"));
    console.log(color("dim", `  Pick ONE method:`));
    console.log("");
    console.log(color("dim", `    DNS TXT     — name:  ${v.dnsTxt?.recordName}`));
    console.log(color("dim", `                  value: ${v.dnsTxt?.recordValue}`));
    console.log("");
    console.log(color("dim", `    HTTP file   — url:   ${v.wellKnown?.url}`));
    console.log(color("dim", `                  body:  ${v.wellKnown?.body}`));
    console.log("");
    console.log(color("dim", `  After adding the record, click 'Verify now' at ${API_BASE}/account`));
    console.log(color("dim", `  or run: npx pqcheck watch ${domain} --verify  (coming soon)`));
  }
  console.log("");
  process.exit(0);
}

async function runCertCommand(args) {
  const fs = await import("node:fs/promises");
  const crypto = await import("node:crypto");
  const json = args.includes("--json");
  const positional = args.filter((a) => !a.startsWith("-"));
  if (positional.length === 0) {
    console.error(color("red", "error: pqcheck cert requires a cert file path"));
    console.error(color("dim", "Usage: npx pqcheck cert <path-to-pem-or-crt> [--json]"));
    process.exit(1);
  }

  let pemData;
  try {
    pemData = await fs.readFile(positional[0], "utf8");
  } catch (err) {
    console.error(color("red", `error reading cert file: ${err.message}`));
    process.exit(1);
  }

  let cert;
  try {
    cert = new crypto.X509Certificate(pemData);
  } catch (err) {
    console.error(color("red", `error parsing cert: ${err.message}`));
    console.error(color("dim", "Expected a PEM-encoded X.509 cert (.pem, .crt, .cer)."));
    process.exit(1);
  }

  const validFrom = new Date(cert.validFrom);
  const validTo = new Date(cert.validTo);
  const daysLeft = Math.round((validTo.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  const sigAlg = (cert.publicKey?.asymmetricKeyType || "unknown").toUpperCase();
  const keyBits = cert.publicKey?.asymmetricKeyDetails?.modulusLength || cert.publicKey?.asymmetricKeyDetails?.namedCurve || "?";
  const sans = (cert.subjectAltName || "").split(",").map(s => s.trim()).filter(Boolean);
  const isWildcard = sans.some(s => s.includes("*."));

  // Quantum exposure assessment
  let quantumNote;
  if (sigAlg === "RSA" && Number(keyBits) >= 2048) {
    quantumNote = "RSA-" + keyBits + " — broken by Shor's algorithm once a CRQC exists";
  } else if (sigAlg === "EC" || sigAlg === "ECDSA") {
    quantumNote = "ECDSA (" + keyBits + ") — broken by Shor's algorithm once a CRQC exists";
  } else if (sigAlg === "ED25519") {
    quantumNote = "Ed25519 — broken by Shor's algorithm once a CRQC exists";
  } else {
    quantumNote = sigAlg + " — quantum exposure unknown";
  }

  const result = {
    file: positional[0],
    subject: cert.subject,
    issuer: cert.issuer,
    serialNumber: cert.serialNumber,
    validFrom: validFrom.toISOString(),
    validTo: validTo.toISOString(),
    daysUntilExpiry: daysLeft,
    keyAlgorithm: sigAlg,
    keyBits,
    sans,
    isWildcard,
    isCA: cert.ca,
    quantumExposure: quantumNote,
  };

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log("");
  console.log(`  ${color("bold", "Cert analysis")}: ${color("violet", positional[0])}`);
  console.log("");
  console.log(`  Subject:    ${cert.subject}`);
  console.log(`  Issuer:     ${cert.issuer}`);
  console.log(`  Valid:      ${validFrom.toISOString().slice(0, 10)} → ${validTo.toISOString().slice(0, 10)} (${daysLeft} days remaining)`);
  console.log(`  Serial:     ${cert.serialNumber}`);
  console.log(`  Key:        ${sigAlg}-${keyBits}`);
  console.log(`  SANs (${sans.length}): ${sans.slice(0, 4).join(", ")}${sans.length > 4 ? ", ..." : ""}`);
  console.log(`  Wildcard:   ${isWildcard ? "yes" : "no"}`);
  console.log(`  CA cert:    ${cert.ca ? "yes" : "no"}`);
  console.log("");
  console.log(`  ${color("yellow", "Quantum exposure:")} ${quantumNote}`);
  console.log("");
}

// =============================================================================
// `pqcheck release-checklist [domain]` — pre-release trust checklist generator
// =============================================================================
// Outputs a markdown checklist for teams to paste into release notes or run
// as a pre-deploy gate. Pure offline (no API call). Domain is optional —
// when present, the checklist is interpolated; when absent, a `<your-domain>`
// placeholder is left for the user to fill.
//
// Habit-loop feature locked 2026-05-16: turns Cipherwake into part of the
// release ritual without heavy integrations. See [[cipherwake-launch-plan-2026-05]].
// Free tier — no API quota consumed.
// =============================================================================

async function runReleaseChecklistCommand(args) {
  const positional = args.filter((a) => !a.startsWith("-"));
  const raw = positional[0];
  let target = "<your-domain>";
  if (raw) {
    const normalized = normalizeDomain(raw);
    if (!isValidDomain(normalized)) {
      console.error(color("red", `error: '${raw}' is not a valid domain`));
      process.exit(1);
    }
    target = normalized;
  }
  const out = renderReleaseChecklist(target, { generator: "release-checklist" });
  console.log(out);
  process.exit(0);
}

// R41 fix #3 (locked 2026-05-16): shared release-checklist helper used by
// both `pqcheck release-checklist` (prints to stdout) and `pqcheck onboard`
// (writes to CIPHERWAKE_CHECKLIST.md). Single source of truth for the 9
// checklist items + verification commands + "where to look" links.
//
// generator: "release-checklist" or "onboard" — controls the intro paragraph
// so the file written by `onboard` says "Generated by `pqcheck onboard`"
// while the standalone `release-checklist` command emits the user-facing
// "Run these in CI or paste..." intro. All other content is identical.
function renderReleaseChecklist(domain, opts = {}) {
  const generator = opts.generator === "onboard" ? "onboard" : "release-checklist";
  const intro = generator === "onboard"
    ? `Generated by \`pqcheck onboard\` — re-run \`pqcheck release-checklist ${domain}\` anytime.`
    : `Run these in CI or paste into your release-notes template. Each item maps to a Cipherwake check; recommended commands are below. Free tier covers all of these on 1 monitored domain.`;
  return [
    `## Pre-release trust checklist for ${domain}`,
    ``,
    intro,
    ``,
    `- [ ] Trust Diff passes vs last successful deploy`,
    `- [ ] No new unapproved vendor scripts observed since last release`,
    `- [ ] HSTS still present and unchanged`,
    `- [ ] CSP still present and unchanged`,
    `- [ ] DMARC policy unchanged`,
    `- [ ] Certificate issuer expected (no surprise CA rotation)`,
    `- [ ] SPKI / key rotation matches your deploy pipeline`,
    `- [ ] HNDL Decryption Blast Radius score within target range`,
    `- [ ] Cipherwake monitoring still active (last scan within 24h)`,
    ``,
    `### How to verify`,
    ``,
    `\`\`\`bash`,
    `# Trust posture vs last successful deploy (Free: 30 calls/mo)`,
    `npx pqcheck trust-diff ${domain} --baseline last-week --fail-on high`,
    ``,
    `# Third-party origins on the page (vendor scripts)`,
    `npx pqcheck vendors check ${domain}`,
    ``,
    `# Live grade + score components`,
    `npx pqcheck ${domain}`,
    `\`\`\``,
    ``,
    `### Where to look`,
    ``,
    `- Full dashboard: https://cipherwake.io/r/${encodeURIComponent(domain)}`,
    `- Methodology + what each check means: https://cipherwake.io/methodology/`,
    `- 30-day Trust Timeline + Change Briefs: https://cipherwake.io/account`,
    ``,
  ].join("\n");
}

// =============================================================================
// `pqcheck init` — interactive workflow scaffold (habit-loop #4, locked 2026-05-16)
// =============================================================================
// Writes a ready-to-commit .github/workflows/cipherwake.yml that calls
// cipherwakelabs/pqcheck@v4 in trust-diff mode. Zero copy-paste docs friction.
//
// Flags:
//   --domain <d>       Skip the domain prompt
//   --fail-on <level>  Skip the severity prompt (any|low|medium|high|critical)
//   --baseline <ref>   Skip the baseline prompt (last-week|last-month|last-scan|<ISO>)
//   --yes / -y         Use defaults for everything not explicitly passed
//   --force            Overwrite an existing workflow file without prompting
//   --stdout           Print the workflow to stdout instead of writing files
//
// Free tier: no API call made by init itself. The generated workflow runs
// against the user's CIPHERWAKE_API_KEY secret (30 free Trust Diff calls/mo).
// =============================================================================

const VALID_FAIL_ON = ["any", "low", "medium", "high", "critical"];
const VALID_BASELINES = ["last-week", "last-month", "last-scan"];

async function runInitCommand(args) {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const useDefaults = args.includes("--yes") || args.includes("-y");
  const stdout = args.includes("--stdout");
  const force = args.includes("--force");

  const flagDomain = readFlagValue(args, "--domain");
  const flagFailOn = readFlagValue(args, "--fail-on");
  const flagBaseline = readFlagValue(args, "--baseline");

  console.log("");
  console.log(`  ${color("bold", "pqcheck init")} ${color("dim", "— scaffold a Cipherwake GitHub Action workflow")}`);
  console.log("");

  let domain = flagDomain ? normalizeDomain(flagDomain) : null;
  if (!domain) {
    if (useDefaults) {
      console.error(color("red", "error: --yes requires --domain (no interactive prompt to fill from)"));
      process.exit(1);
    }
    const answer = await prompt(`  Domain to monitor (e.g. cipherwake.io): `);
    domain = normalizeDomain((answer || "").trim());
  }
  if (!isValidDomain(domain)) {
    console.error(color("red", `  error: '${domain}' is not a valid hostname`));
    process.exit(1);
  }

  let failOn = flagFailOn || "high";
  if (!flagFailOn && !useDefaults) {
    const answer = await prompt(`  Fail CI on severity ${color("dim", "[any|low|medium|high(default)|critical]")}: `);
    if (answer && answer.trim()) failOn = answer.trim().toLowerCase();
  }
  if (!VALID_FAIL_ON.includes(failOn)) {
    console.error(color("red", `  error: --fail-on must be one of ${VALID_FAIL_ON.join("|")}`));
    process.exit(1);
  }

  let baseline = flagBaseline || "last-week";
  if (!flagBaseline && !useDefaults) {
    const answer = await prompt(`  Baseline ${color("dim", "[last-week(default)|last-month|last-scan|<ISO date>]")}: `);
    if (answer && answer.trim()) baseline = answer.trim();
  }
  if (!isValidBaseline(baseline)) {
    console.error(color("red", `  error: --baseline must be last-week|last-month|last-scan or an ISO date (YYYY-MM-DD)`));
    process.exit(1);
  }

  const workflow = renderTrustDiffWorkflow({ domain, failOn, baseline });

  if (stdout) {
    console.log(workflow);
    process.exit(0);
  }

  // Resolve target path: ./.github/workflows/cipherwake.yml in cwd
  const cwd = process.cwd();
  const workflowDir = path.join(cwd, ".github", "workflows");
  const workflowPath = path.join(workflowDir, "cipherwake.yml");

  try {
    await fs.mkdir(workflowDir, { recursive: true });
  } catch (err) {
    console.error(color("red", `  error creating ${workflowDir}: ${err.message}`));
    process.exit(1);
  }

  // Check existing file
  let exists = false;
  try {
    await fs.access(workflowPath);
    exists = true;
  } catch { /* doesn't exist */ }

  if (exists && !force) {
    if (useDefaults) {
      console.error(color("red", `  error: ${workflowPath} already exists (re-run with --force to overwrite)`));
      process.exit(1);
    }
    const answer = await prompt(`  ${color("yellow", workflowPath + " already exists — overwrite?")} ${color("dim", "[y/N]")}: `);
    if (!/^y(es)?$/i.test((answer || "").trim())) {
      console.error(color("dim", "  cancelled — workflow not written"));
      process.exit(1);
    }
  }

  try {
    await fs.writeFile(workflowPath, workflow, "utf8");
  } catch (err) {
    console.error(color("red", `  error writing ${workflowPath}: ${err.message}`));
    process.exit(1);
  }

  const relPath = path.relative(cwd, workflowPath);
  console.log("");
  console.log(color("green", `  ✓ Wrote ${relPath}`));
  console.log("");
  console.log(`  ${color("bold", "Next steps:")}`);
  console.log("");
  console.log(`  ${color("dim", "1.")} Generate a Cipherwake API key at ${color("violet", "https://cipherwake.io/account#api-keys")}`);
  console.log(`     ${color("dim", "Free tier: 100 Trust Diff calls/month per repo")}`);
  console.log("");
  console.log(`  ${color("dim", "2.")} Add it as a repo secret:`);
  console.log(`     ${color("dim", "Settings → Secrets and variables → Actions → New repository secret")}`);
  console.log(`     ${color("dim", "Name: CIPHERWAKE_API_KEY")}`);
  console.log("");
  console.log(`  ${color("dim", "3.")} Commit + push:`);
  console.log(`     ${color("dim", "$")} git add ${relPath}`);
  console.log(`     ${color("dim", "$")} git commit -m "ci: add Cipherwake Trust Diff gate"`);
  console.log(`     ${color("dim", "$")} git push`);
  console.log("");
  console.log(`  Open a PR to see the gate run.`);
  console.log("");
  process.exit(0);
}

function readFlagValue(args, name) {
  const idx = args.indexOf(name);
  if (idx === -1) return null;
  const v = args[idx + 1];
  return v && !v.startsWith("-") ? v : null;
}

function isValidBaseline(value) {
  if (VALID_BASELINES.includes(value)) return true;
  // ISO date YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ
  return /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?Z?)?$/.test(value);
}

function renderTrustDiffWorkflow({ domain, failOn, baseline }) {
  return `# Cipherwake — Trust Diff gate
# Generated by \`pqcheck init\` (v${VERSION}).
# Runs on every PR and pushes to main: fails the build if your public trust
# posture regresses vs the baseline (cert / SPKI / vendor scripts / HSTS / CSP /
# DMARC / HNDL).
#
# Free tier: 100 Trust Diff calls/month per repo (OIDC-metered).
# Methodology: https://cipherwake.io/methodology/
# Action source: https://github.com/cipherwakelabs/pqcheck

name: Cipherwake Trust Diff

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

permissions:
  contents: read
  id-token: write          # required for OIDC-based metering (Free=100 calls/repo/mo, no API key needed)
  security-events: write   # required for SARIF upload to Code Scanning
  pull-requests: write     # required for sticky PR comment (Action v3.1+)

jobs:
  trust-diff:
    runs-on: ubuntu-latest
    steps:
      - name: Run Cipherwake Trust Diff
        uses: cipherwakelabs/pqcheck@v4
        with:
          mode: trust-diff
          domain: ${domain}
          baseline: ${baseline}
          fail-on: ${failOn}
        # No env/secrets needed for Free tier — the action uses the
        # workflow's id-token: write permission to fetch a GitHub-signed
        # OIDC token and meters per repo (100 calls/mo, no setup).
        # If you want higher limits, link this repo to a paid Cipherwake
        # account at https://cipherwake.io/account → Linked repos.
`;
}

// Tiny readline wrapper. We avoid pulling a CLI prompt library — this is the
// only interactive path in pqcheck and Node's built-in readline is enough.
async function prompt(question) {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return answer;
  } finally {
    rl.close();
  }
}

// =============================================================================
// `pqcheck deploy-check <domain>` — pre-deploy trust gate (habit-loop #5)
// =============================================================================
// Thin alias for `pqcheck trust-diff` with deploy-friendly framing:
//   - Default baseline: last-scan (compares vs your most recent scan, which
//     usually correlates with the previous deploy)
//   - Default fail-on: high
//   - Cleaner output for shell-script use in deploy pipelines (Vercel
//     pre-build, Netlify build commands, custom CD scripts)
//
// Exit codes match trust-diff: 0 pass · 1 warn · 2 fail · 3 error.
// Consumes the same Free 100 Trust Diff calls/month per repo quota.
// =============================================================================

async function runDeployCheckCommand(args) {
  const positional = args.filter((a) => !a.startsWith("-"));
  if (positional.length === 0) {
    console.error(color("red", "error: pqcheck deploy-check requires a domain"));
    console.error(color("dim", "Usage: npx pqcheck deploy-check <domain> [--baseline last-scan|last-week|<ISO>] [--fail-on high|medium|low|any]"));
    process.exit(1);
  }

  // Forward to trust-diff with deploy-tuned defaults if the user didn't specify.
  const forwarded = [...args];
  if (!args.includes("--baseline")) forwarded.push("--baseline", "last-scan");
  if (!args.includes("--fail-on")) forwarded.push("--fail-on", "high");

  // Pre-print a deploy-context header (only in text mode — JSON/SARIF users
  // are scripting and don't want our preamble polluting their pipe; AI mode
  // emits its own banner so don't double-up).
  const format = parseFormat(forwarded);
  if (format === "text" && !parseAiMode(forwarded)) {
    console.log("");
    console.log(`  ${color("bold", "🚀 Deploy gate")} ${color("dim", "— checking public trust posture vs last scan")}`);
    console.log("");
  }

  return runTrustDiffCommand(forwarded);
}

// =============================================================================
// `pqcheck vendors <subcommand>` — vendor lockfile management (habit-loop #10)
// =============================================================================
// Free tier (Option A, locked 2026-05-16):
//   pqcheck vendors export <domain>   — write cipherwake.vendors.json from
//                                       the current observed vendor scripts
//                                       (read-only snapshot, no CI enforce)
//   pqcheck vendors check <domain>    — compare current scan to the lockfile,
//                                       exit 4 if new origins appeared
//                                       (free CI gate via the deps endpoint)
//
// Starter+ tier:
//   pqcheck vendors sync <domain>     — pull approved-vendor list from
//                                       /api/vendor-allowlist and merge into
//                                       the lockfile (bidirectional)
//
// The lockfile is a developer artifact: commit it to the repo to track
// vendor-surface drift in PR diffs. Like package-lock.json for third-party
// scripts.
//
// Per [[quantapact-pricing-discipline]]: Free generates the lockfile and uses
// it in CI; Starter+ adds the dashboard-sync layer + approved-vendor
// enforcement. The dashboard CRUD UI is the Starter wall, not the lockfile.
// =============================================================================

const VENDOR_LOCKFILE_NAME = "cipherwake.vendors.json";

async function runVendorsCommand(args) {
  const sub = args[0];
  if (!sub || sub === "--help" || sub === "-h") {
    console.log(`
${color("bold", "pqcheck vendors")} ${color("dim", `v${VERSION}`)}

Vendor lockfile management — track third-party scripts on your domain.

${color("bold", "Subcommands:")}
  pqcheck vendors export <domain>   Write ${VENDOR_LOCKFILE_NAME} from current observed vendors (Free)
  pqcheck vendors check <domain>    Compare current scan to the lockfile; exit 4 on new origins (Free CI gate)
  pqcheck vendors sync <domain>     Pull approved-vendor list from your account (Starter+, requires CIPHERWAKE_API_KEY)

${color("bold", "Flags:")}
  -o <path>                  Output / input path (default: ./${VENDOR_LOCKFILE_NAME})

${color("bold", "Examples:")}
  npx pqcheck vendors export cipherwake.io                       ${color("dim", "# capture initial state")}
  npx pqcheck vendors check cipherwake.io                        ${color("dim", "# CI gate — fails on new origins")}
  CIPHERWAKE_API_KEY=qpk_... npx pqcheck vendors sync cipherwake.io   ${color("dim", "# Starter+ dashboard sync")}

Methodology: ${color("violet", "https://cipherwake.io/methodology/vendor-lockfile")}
`);
    process.exit(0);
  }

  const rest = args.slice(1);
  const positional = rest.filter((a) => !a.startsWith("-"));
  const raw = positional[0];
  if (!raw) {
    console.error(color("red", `error: pqcheck vendors ${sub} requires a domain`));
    process.exit(1);
  }
  const domain = normalizeDomain(raw);
  if (!isValidDomain(domain)) {
    console.error(color("red", `error: '${raw}' is not a valid domain`));
    process.exit(1);
  }

  const outIdx = rest.indexOf("-o");
  const outPath = (outIdx >= 0 && rest[outIdx + 1] && !rest[outIdx + 1].startsWith("-"))
    ? rest[outIdx + 1]
    : VENDOR_LOCKFILE_NAME;

  if (sub === "export") {
    return runVendorsExport(domain, outPath);
  }
  if (sub === "check") {
    return runVendorsCheck(domain, outPath);
  }
  if (sub === "sync") {
    return runVendorsSync(domain, outPath);
  }
  console.error(color("red", `error: unknown subcommand 'vendors ${sub}'. Try: export | check | sync`));
  process.exit(1);
}

async function fetchVendorOrigins(domain) {
  // Calls /api/deps which returns the observed third-party origin list for
  // a domain. Same endpoint that powers `pqcheck deps <domain>`.
  //
  // R40 fix (Q2.6): add a 15-second timeout via AbortController. Previously
  // a hung /api/deps would block the CLI indefinitely — CI runs would
  // consume their full 6-hour budget waiting for a response that never
  // comes. 15s is generous enough for the slow tail but bounds the worst
  // case.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);
  let resp;
  try {
    resp = await fetch(`${API_BASE}/api/deps?domain=${encodeURIComponent(domain)}`, {
      method: "GET",
      headers: apiHeaders({ "user-agent": `pqcheck-cli/${VERSION}${CI_ACTION_SUFFIX} (vendors)` }),
      signal: ac.signal,
    });
  } catch (err) {
    if (err?.name === "AbortError") throw new Error("/api/deps timed out after 15s");
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    const body = await safeJSON(resp);
    throw new Error(`/api/deps returned ${resp.status} ${body?.error || resp.statusText}`);
  }
  const data = await resp.json();
  const thirds = Array.isArray(data.thirdParties) ? data.thirdParties : [];
  // R40 fix (Q2.7): preserve the observed protocol. Previously we
  // force-converted http://vendor.com into https://vendor.com which
  // mis-represented what we actually observed. Now: keep http:// when
  // the API gives an explicit http:// origin; default to https:// only
  // when the host comes without a protocol prefix.
  const origins = new Set();
  for (const t of thirds) {
    const host = typeof t === "string" ? t : (t.host ?? t.origin ?? "");
    if (!host) continue;
    const o = normalizeObservedOrigin(host);
    if (o) origins.add(o);
  }
  return Array.from(origins).sort();
}

// R40 fix (Q2.7): preserve observed protocol. URL parser handles host
// validation + canonicalization (lowercase, default-port stripping).
function normalizeObservedOrigin(value) {
  const s = String(value).trim().toLowerCase();
  if (!s) return null;
  try {
    const u = s.startsWith("http://") || s.startsWith("https://")
      ? new URL(s)
      : new URL("https://" + s);
    return u.origin;
  } catch {
    return null;
  }
}

function buildVendorLockfile(domain, origins) {
  return {
    schema_version: 1,
    generator: `pqcheck-cli/${VERSION}${CI_ACTION_SUFFIX}`,
    domain,
    generated_at: new Date().toISOString(),
    approved_script_origins: origins,
    // Soft tier marker — read by sync to know if the lockfile carries
    // dashboard-managed entries. Free-only lockfiles set this to null.
    synced_from_account: null,
  };
}

async function runVendorsExport(domain, outPath) {
  const fs = await import("node:fs/promises");
  console.log("");
  console.log(`  ${color("bold", "Exporting vendor lockfile")} ${color("dim", `— ${domain}`)}`);
  console.log("");
  let origins;
  try {
    origins = await fetchVendorOrigins(domain);
  } catch (err) {
    console.error(color("red", `  error fetching vendor origins: ${err.message}`));
    process.exit(1);
  }
  const lockfile = buildVendorLockfile(domain, origins);
  try {
    await fs.writeFile(outPath, JSON.stringify(lockfile, null, 2) + "\n", "utf8");
  } catch (err) {
    console.error(color("red", `  error writing ${outPath}: ${err.message}`));
    process.exit(1);
  }
  console.log(color("green", `  ✓ Wrote ${outPath} with ${origins.length} approved script origin${origins.length === 1 ? "" : "s"}.`));
  console.log("");
  console.log(`  ${color("dim", "Commit this file to your repo to track vendor-surface drift in PR diffs.")}`);
  // R40 fix (Q2.12): nested template literal — the outer backticks are the
  // template literal; the inner string passed to color() must ALSO be a
  // template literal so ${domain} interpolates. Previously this printed
  // the literal text "${domain}" because color()'s arg was a plain string.
  console.log(`  ${color("dim", `Run \`pqcheck vendors check ${domain}\` in CI to fail PRs that introduce new origins.`)}`);
  console.log("");
  process.exit(0);
}

async function runVendorsCheck(domain, lockPath) {
  const fs = await import("node:fs/promises");
  let lockfile;
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    lockfile = JSON.parse(raw);
  } catch (err) {
    console.error(color("red", `  error reading ${lockPath}: ${err.message}`));
    console.error(color("dim", `  Run: npx pqcheck vendors export ${domain}   to generate one.`));
    process.exit(1);
  }
  if (lockfile.schema_version !== 1) {
    console.error(color("red", `  error: ${lockPath} schema_version=${lockfile.schema_version}, expected 1`));
    process.exit(1);
  }
  if (lockfile.domain && lockfile.domain !== domain) {
    console.error(color("yellow", `  warning: lockfile is for ${lockfile.domain} but checking against ${domain}`));
  }
  const baseline = new Set(Array.isArray(lockfile.approved_script_origins) ? lockfile.approved_script_origins : []);
  let observed;
  try {
    observed = new Set(await fetchVendorOrigins(domain));
  } catch (err) {
    console.error(color("red", `  error fetching current vendors: ${err.message}`));
    process.exit(1);
  }
  const newOrigins = [...observed].filter((o) => !baseline.has(o));
  const removed = [...baseline].filter((o) => !observed.has(o));

  console.log("");
  console.log(`  ${color("bold", "Vendor lockfile check")} ${color("dim", `— ${domain}`)}`);
  console.log("");
  if (newOrigins.length === 0 && removed.length === 0) {
    console.log(color("green", `  ✓ Vendor surface matches lockfile (${baseline.size} origins).`));
    console.log("");
    process.exit(0);
  }
  if (newOrigins.length > 0) {
    console.log(color("red", `  ⚠ ${newOrigins.length} new origin${newOrigins.length === 1 ? "" : "s"} observed (not in lockfile):`));
    for (const o of newOrigins) console.log(`    + ${o}`);
    console.log("");
  }
  if (removed.length > 0) {
    console.log(color("dim", `  - ${removed.length} origin${removed.length === 1 ? "" : "s"} no longer observed:`));
    for (const o of removed) console.log(`    - ${o}`);
    console.log("");
  }
  if (newOrigins.length > 0) {
    console.log(color("dim", `  To accept the additions, re-run: npx pqcheck vendors export ${domain}`));
    console.log(color("dim", `  Then commit the updated ${lockPath} to your repo.`));
    console.log("");
    process.exit(4); // New origin(s) detected — same exit code as `deps --fail-on-new`
  }
  // Only removals (cleanup), no failure
  process.exit(0);
}

async function runVendorsSync(domain, outPath) {
  const fs = await import("node:fs/promises");
  if (!QP_API_KEY) {
    console.error(color("red", "  error: `vendors sync` requires CIPHERWAKE_API_KEY (Starter+ feature)"));
    console.error("");
    console.error(color("dim", "  Free tier: use `vendors export` to generate a read-only lockfile."));
    console.error(color("dim", "  Sign up + manage approved vendors at: " + API_BASE + "/account"));
    console.error(color("dim", "  Pricing: " + API_BASE + "/pricing"));
    process.exit(1);
  }
  console.log("");
  console.log(`  ${color("bold", "Syncing vendor lockfile with your account")} ${color("dim", `— ${domain}`)}`);
  console.log("");
  let resp;
  try {
    resp = await fetch(`${API_BASE}/api/vendor-allowlist?domain=${encodeURIComponent(domain)}`, {
      method: "GET",
      headers: {
        "user-agent": `pqcheck-cli/${VERSION}${CI_ACTION_SUFFIX} (vendors-sync)`,
        "authorization": "Bearer " + QP_API_KEY,
      },
    });
  } catch (err) {
    console.error(color("red", `  network error: ${err.message ?? err}`));
    process.exit(1);
  }
  if (resp.status === 401 || resp.status === 403) {
    const body = await safeJSON(resp);
    console.error(color("red", `  authentication failed (HTTP ${resp.status})`));
    if (body?.error === "starter_required") {
      console.error(color("dim", `  Approved-vendor allowlist starts at Starter ($29/mo). ${body.message ?? ""}`));
      console.error(color("dim", `  ${API_BASE}/pricing?utm_source=cli_vendors_sync`));
    }
    process.exit(1);
  }
  if (!resp.ok) {
    console.error(color("red", `  /api/vendor-allowlist returned ${resp.status}`));
    process.exit(1);
  }
  const data = await resp.json();
  const allowlist = Array.isArray(data.allowlist) ? data.allowlist : [];
  // Filter to entries for this domain + extract vendor_origin
  const dashboardOrigins = new Set();
  for (const item of allowlist) {
    if (item && item.domain === domain && typeof item.vendor_origin === "string") {
      dashboardOrigins.add(item.vendor_origin);
    }
  }

  // Merge with currently observed (so the lockfile covers everything we see + everything the user approved)
  let observed = new Set();
  try {
    observed = new Set(await fetchVendorOrigins(domain));
  } catch (err) {
    console.error(color("yellow", `  warning: could not fetch currently observed origins (${err.message}); using dashboard-only list`));
  }

  const merged = new Set([...observed, ...dashboardOrigins]);
  const origins = Array.from(merged).sort();
  const lockfile = buildVendorLockfile(domain, origins);
  lockfile.synced_from_account = new Date().toISOString();

  try {
    await fs.writeFile(outPath, JSON.stringify(lockfile, null, 2) + "\n", "utf8");
  } catch (err) {
    console.error(color("red", `  error writing ${outPath}: ${err.message}`));
    process.exit(1);
  }
  console.log(color("green", `  ✓ Synced ${outPath} — ${dashboardOrigins.size} dashboard-approved, ${observed.size} currently observed, ${origins.length} total.`));
  console.log("");
  console.log(`  ${color("dim", "Commit the updated lockfile to your repo. `pqcheck vendors check` in CI will fail PRs that")}`);
  console.log(`  ${color("dim", "introduce origins outside the merged set.")}`);
  console.log("");
  process.exit(0);
}

// =============================================================================
// `pqcheck onboard <domain>` — one-command setup wizard (locked 2026-05-16)
// =============================================================================
// Composes existing CLI subcommands into one happy-path flow:
//   1. Quick public scan → show current grade so the user sees value first
//   2. Scaffold the GitHub Action workflow (via runInitCommand)
//   3. Generate a vendor lockfile snapshot (via runVendorsExport)
//   4. Generate a release-checklist markdown
//   5. Open the user's browser to /account#api-keys for API-key generation
//   6. Print next-steps (secret name + commit commands + PR open)
//
// Design notes:
//   - Pure composition of already-reviewed subcommands; no new server endpoints.
//   - Browser-open uses platform default (`open`/`xdg-open`/`start`). When
//     headless or sandboxed, the URL is still printed so the user can copy.
//   - Each step is best-effort: a failed step prints a warning and continues
//     so a partial setup is still useful. Hard errors only stop early steps
//     where the rest can't proceed (invalid domain).
//   - --skip-scan / --skip-vendors / --skip-checklist let power users opt out.
//   - --no-open suppresses the browser launch (CI / SSH / headless friendly).
// =============================================================================

async function runOnboardCommand(args) {
  const positional = args.filter((a) => !a.startsWith("-"));
  const raw = positional[0];
  if (!raw) {
    console.error(color("red", "error: pqcheck onboard requires a domain"));
    console.error(color("dim", "Usage: npx pqcheck onboard <domain> [--skip-scan] [--skip-vendors] [--skip-checklist] [--no-open] [--force] [--strict]"));
    process.exit(1);
  }
  const domain = normalizeDomain(raw);
  if (!isValidDomain(domain)) {
    console.error(color("red", `error: '${raw}' is not a valid domain`));
    process.exit(1);
  }
  const skipScan = args.includes("--skip-scan");
  const skipVendors = args.includes("--skip-vendors");
  const skipChecklist = args.includes("--skip-checklist");
  const noOpen = args.includes("--no-open");
  // R41 fix #1: --force lets users intentionally overwrite an existing
  // setup (idempotent re-runs). Without it, we abort if any of the
  // 3 output files already exists, so a user re-running onboard by
  // mistake doesn't lose hand-edited CIPHERWAKE_CHECKLIST.md / vendors
  // lockfile / workflow YAML.
  const force = args.includes("--force");
  // R41 fix #4: --strict makes onboard exit non-zero if any step fails.
  // For human-driven first-time setup, exit 0 (best-effort) is the right
  // default — printed warnings tell the user what to retry. For CI
  // automation around the wizard itself, --strict lets a build fail on
  // step errors. (Recommended usage in CI is still the individual
  // subcommands, not onboard.)
  const strict = args.includes("--strict");

  // R41 fix #1: pre-flight overwrite check. We probe the 3 output paths
  // BEFORE running any step so an aborted run doesn't half-modify the
  // user's project. We use sync stat checks because we're not in a hot
  // path and the readability win is worth the tiny perf cost.
  if (!force) {
    const fsSync = await import("node:fs");
    const existing = [];
    try { fsSync.statSync(".github/workflows/cipherwake.yml"); existing.push(".github/workflows/cipherwake.yml"); } catch {}
    if (!skipVendors) {
      try { fsSync.statSync("cipherwake.vendors.json"); existing.push("cipherwake.vendors.json"); } catch {}
    }
    if (!skipChecklist) {
      try { fsSync.statSync("CIPHERWAKE_CHECKLIST.md"); existing.push("CIPHERWAKE_CHECKLIST.md"); } catch {}
    }
    if (existing.length > 0) {
      console.error("");
      console.error(color("red", `  error: refusing to overwrite existing files:`));
      for (const f of existing) console.error(color("dim", `    ${f}`));
      console.error("");
      console.error(color("dim", `  Re-run with --force to overwrite, or delete the files manually.`));
      console.error(color("dim", `  (--skip-vendors / --skip-checklist also bypass individual file checks.)`));
      process.exit(1);
    }
  }

  // R41 fix #4: track step failures for --strict mode
  let anyStepFailed = false;

  console.log("");
  console.log(`  ${color("bold", "🚀 Cipherwake onboarding")} ${color("dim", `— ${domain}`)}`);
  console.log("");
  console.log(`  ${color("dim", "This will write ~3 files to your project and open your browser to grab an API key.")}`);
  console.log(`  ${color("dim", "All steps are best-effort; you can re-run any individual subcommand later.")}`);
  console.log("");

  // -------------------------------------------------------------------------
  // STEP 1 — quick scan (value-first; user sees their grade before any setup)
  // -------------------------------------------------------------------------
  if (!skipScan) {
    console.log(color("violet", `  ▸ Step 1 / 4 — scanning ${domain}…`));
    try {
      const resp = await fetch(`${API_BASE}/api/scan?domain=${encodeURIComponent(domain)}&source=onboard`, {
        method: "GET",
        headers: apiHeaders({ "user-agent": `pqcheck-cli/${VERSION}${CI_ACTION_SUFFIX} (onboard)` }),
      });
      if (resp.ok) {
        const report = await resp.json();
        const score = typeof report.score === "number" ? report.score.toFixed(1) : "?";
        const grade = report.grade || "?";
        const label = report.scoreLabel || "—";
        console.log(`    ${color("bold", "Current grade:")} ${color("violet", grade)} (${score}/10 · ${label})`);
        console.log(`    ${color("dim", `Full report: ${API_BASE}/r/${encodeURIComponent(domain)}`)}`);
      } else {
        console.log(color("yellow", `    skipped (scan returned HTTP ${resp.status})`));
        anyStepFailed = true;
      }
    } catch (err) {
      console.log(color("yellow", `    skipped (${err?.message ?? "scan failed"})`));
      anyStepFailed = true;
    }
    console.log("");
  }

  // -------------------------------------------------------------------------
  // STEP 2 — workflow scaffold
  // -------------------------------------------------------------------------
  console.log(color("violet", `  ▸ Step 2 / 4 — scaffolding GitHub Action workflow…`));
  try {
    // Call runInitCommand non-interactively. The function process.exit()'s on
    // its own; to compose it here we'd have to refactor. Pragmatic approach:
    // spawn a child node invoking ourselves with `init --yes --domain ...`.
    // That keeps each step idempotent and isolated.
    const { spawn } = await import("node:child_process");
    const result = await new Promise((resolve) => {
      const p = spawn(process.execPath, [
        process.argv[1],
        "init",
        "--yes",
        "--domain", domain,
        "--force",
      ], { stdio: "inherit" });
      p.on("exit", (code) => resolve(code ?? 0));
      p.on("error", () => resolve(1));
    });
    if (result !== 0) {
      console.log(color("yellow", `    init exited ${result} — you can re-run \`pqcheck init\` later`));
      anyStepFailed = true;
    }
  } catch (err) {
    console.log(color("yellow", `    skipped init (${err?.message ?? "subprocess failed"})`));
    anyStepFailed = true;
  }
  console.log("");

  // -------------------------------------------------------------------------
  // STEP 3 — vendor lockfile (skipped if --skip-vendors)
  // -------------------------------------------------------------------------
  if (!skipVendors) {
    console.log(color("violet", `  ▸ Step 3 / 4 — capturing vendor lockfile…`));
    try {
      const { spawn } = await import("node:child_process");
      const result = await new Promise((resolve) => {
        const p = spawn(process.execPath, [
          process.argv[1],
          "vendors",
          "export",
          domain,
        ], { stdio: "inherit" });
        p.on("exit", (code) => resolve(code ?? 0));
        p.on("error", () => resolve(1));
      });
      if (result !== 0) {
        console.log(color("yellow", `    vendors export exited ${result} — you can re-run \`pqcheck vendors export ${domain}\` later`));
        anyStepFailed = true;
      }
    } catch (err) {
      console.log(color("yellow", `    skipped vendors export (${err?.message ?? "subprocess failed"})`));
      anyStepFailed = true;
    }
    console.log("");
  }

  // -------------------------------------------------------------------------
  // STEP 4 — release checklist (skipped if --skip-checklist)
  // -------------------------------------------------------------------------
  if (!skipChecklist) {
    console.log(color("violet", `  ▸ Step 4 / 4 — writing release checklist…`));
    try {
      const fs = await import("node:fs/promises");
      const checklist = buildReleaseChecklistMarkdown(domain);
      await fs.writeFile("CIPHERWAKE_CHECKLIST.md", checklist, "utf8");
      console.log(`    ${color("green", "✓ Wrote CIPHERWAKE_CHECKLIST.md")}`);
    } catch (err) {
      console.log(color("yellow", `    skipped checklist (${err?.message ?? "write failed"})`));
      anyStepFailed = true;
    }
    console.log("");
  }

  // -------------------------------------------------------------------------
  // Final next-steps (v0.13 OIDC path — no API key needed for Free tier)
  // -------------------------------------------------------------------------
  // Pre-v0.13 this step opened a browser to the API-key page + asked the user
  // to paste the key as a GitHub repo secret. With Action v3.2 + OIDC repo
  // metering, the scaffolded workflow has `permissions: { id-token: write }`
  // and the action fetches a GitHub-signed token automatically — no key, no
  // secret, no browser hop. Free tier is 100 calls/repo/mo, enforced server-
  // side via the `meter_gh_action_call` RPC against `gh_action_repo_quota`.
  // For higher limits, the user links this repo to a paid account at /account
  // (one-time OAuth) — still no API key in CI.
  console.log(color("bold", "  ✓ Setup files written. Two steps remain:"));
  console.log("");
  console.log(`  ${color("dim", "1.")} ${color("bold", "Commit + push")} (no API key, no secrets needed for the Free tier)`);
  const filesToAdd = [".github/workflows/cipherwake.yml"];
  if (!skipVendors) filesToAdd.push("cipherwake.vendors.json");
  if (!skipChecklist) filesToAdd.push("CIPHERWAKE_CHECKLIST.md");
  console.log(`     ${color("dim", "$")} git add ${filesToAdd.join(" ")}`);
  console.log(`     ${color("dim", "$")} git commit -m "ci: add Cipherwake Trust Diff gate"`);
  console.log(`     ${color("dim", "$")} git push`);
  console.log("");
  console.log(`  ${color("dim", "2.")} ${color("bold", "Open a PR")}`);
  console.log(`     ${color("dim", "Cipherwake will comment inline within ~60s of the workflow firing. The action uses GitHub OIDC to meter usage per repo (Free = 30 calls/mo).")}`);
  console.log("");
  // R48 (post-R47 review MAJOR #6): the /account → "Linked repos" UI is
  // not yet shipped (out of R47 scope). Pointing users to a nonexistent
  // page-hash would create a broken growth path at the moment of intent.
  // Route through the feedback form until the linking UI lands.
  console.log(`  ${color("dim", "Want higher limits (1K/10K/50K Trust Diff calls/mo)?")}`);
  console.log(`     ${color("violet", `${API_BASE}/feedback?topic=linked-repos`)}`);
  console.log(`     ${color("dim", "Repo-linking UI is rolling out — request early access via the form.")}`);
  console.log("");
  // R41 fix #4 carried forward: --strict gates exit code on step failures.
  // noOpen flag is now a no-op since we don't open a browser, but we keep it
  // accepted for backward compat with users who already pass --no-open.
  void noOpen;
  // R41 fix #4: --strict makes onboard exit non-zero if any step failed.
  // Default (best-effort) exit 0 keeps the wizard friendly for first-time
  // human setup — the visible yellow warnings tell them what to retry.
  if (strict && anyStepFailed) {
    console.log(color("dim", "  (--strict: one or more steps failed; exiting non-zero)"));
    process.exit(1);
  }
  process.exit(0);
}

// R41 fix #3: buildReleaseChecklistMarkdown is now a thin alias to the shared
// renderReleaseChecklist() helper defined alongside runReleaseChecklistCommand.
// Single source of truth — when either subcommand's content changes, both
// callers update automatically.
function buildReleaseChecklistMarkdown(domain) {
  return renderReleaseChecklist(domain, { generator: "onboard" });
}

// Cross-platform browser launcher. Returns true if a launcher binary
// dispatched successfully; false if no launcher is available (e.g. headless
// server, sandboxed CI, broken xdg-open config).
//
// R41 fix #2 (locked 2026-05-16): use exit-event detection + longer timeout
// so we don't falsely claim "(opened in your browser)" when xdg-open is
// installed but the launcher exits non-zero (no graphical session, no
// MIME handler). Previously a flat 200ms timeout resolved true even when
// the launcher exited 3 because no display was available.
async function tryOpenBrowser(url) {
  if (process.env.CI || process.env.CIPHERWAKE_NO_BROWSER) return false;
  const { spawn } = await import("node:child_process");
  const platform = process.platform;
  let cmd, cmdArgs;
  if (platform === "darwin") {
    cmd = "open"; cmdArgs = [url];
  } else if (platform === "win32") {
    cmd = "cmd"; cmdArgs = ["/c", "start", "", url];
  } else {
    cmd = "xdg-open"; cmdArgs = [url];
  }
  return await new Promise((resolve) => {
    let settled = false;
    let p;
    try {
      p = spawn(cmd, cmdArgs, { stdio: "ignore", detached: true });
    } catch {
      resolve(false);
      return;
    }
    p.on("error", () => { if (!settled) { settled = true; resolve(false); } });
    p.on("exit", (code) => { if (!settled) { settled = true; resolve(code === 0); } });
    p.unref();
    // Belt-and-suspenders: if the launcher takes >1s to exit AND no error
    // event has fired, assume it dispatched and went detached (open on
    // macOS does this — returns after AppleScript-asking Finder/Safari).
    setTimeout(() => {
      if (!settled) { settled = true; resolve(true); }
    }, 1000);
  });
}

// =============================================================================
// `pqcheck guard --domain X -- <deploy command>` — wrapper command
// =============================================================================
// The strongest single artifact for terminal-first AI-coder workflows.
// Runs deploy-check first, conditionally executes the wrapped deploy command
// based on ship_decision. AI coders type ONE command; Cipherwake controls
// whether the deploy actually runs.
//
// Usage:
//   npx pqcheck guard --domain example.com -- vercel deploy --prod
//   npx pqcheck guard --domain example.com --gate-mode strict -- bash deploy.sh
//   npx pqcheck guard --domain example.com --bypass "shipping despite review" -- ...
//
// Exit codes:
//   0 = deploy ran and succeeded (pre-check passed or user confirmed review)
//   1 = pre-check returned review and user chose not to proceed
//   2 = pre-check returned block and deploy was refused (use --bypass to override)
//   3 = wrapper / deploy command itself errored
// =============================================================================
async function runGuardCommand(args) {
  // Parse flags and the `--` separator.
  const sepIdx = args.indexOf("--");
  const ourArgs = sepIdx >= 0 ? args.slice(0, sepIdx) : args;
  const deployCmd = sepIdx >= 0 ? args.slice(sepIdx + 1) : [];

  const domain = parseFlag(ourArgs, "--domain");
  const gateMode = parseFlag(ourArgs, "--gate-mode") || "balanced";
  const bypassReason = parseFlag(ourArgs, "--bypass");
  const noPostCheck = ourArgs.includes("--no-post-check");

  if (!domain) {
    console.error(color("red", "error: pqcheck guard requires --domain"));
    console.error(color("dim", "Usage: npx pqcheck guard --domain example.com -- <deploy command>"));
    console.error(color("dim", "Example: npx pqcheck guard --domain example.com -- vercel deploy --prod"));
    process.exit(3);
  }
  if (deployCmd.length === 0) {
    console.error(color("red", "error: pqcheck guard requires a deploy command after `--`"));
    console.error(color("dim", "Usage: npx pqcheck guard --domain example.com -- vercel deploy --prod"));
    process.exit(3);
  }
  if (!["balanced", "advisory", "strict"].includes(gateMode)) {
    console.error(color("red", `error: --gate-mode must be one of: balanced, advisory, strict (got "${gateMode}")`));
    process.exit(3);
  }

  const labelByMode = {
    balanced: "Balanced (default — review on HIGH, block on CRITICAL)",
    advisory: "Advisory (warnings only, deploy never blocked)",
    strict: "Strict (block on any finding ≥ medium)",
  };

  console.log("");
  console.log(`  ${color("bold", "◆ Cipherwake Deploy Guard")} ${color("dim", `· ${labelByMode[gateMode]}`)}`);
  console.log(`  ${color("dim", `domain: ${domain}`)}`);
  console.log(`  ${color("dim", `deploy: ${deployCmd.join(" ")}`)}`);
  console.log("");

  if (bypassReason) {
    console.log(color("yellow", `  ⚠ --bypass set with reason: "${bypassReason}"`));
    console.log(color("dim", "  The pre-deploy check will still run, but a review or block won't stop the deploy."));
    console.log("");
  }

  // Run the pre-deploy check. We invoke ourselves (the CLI) as a subprocess
  // rather than calling internal functions because the deploy-check exit
  // code + ship_decision semantics are the contract; recreating that logic
  // inline would risk drift.
  const { spawn } = await import("node:child_process");

  // Detect the right binary to invoke: if we're running via `npx pqcheck`
  // we want to re-invoke pqcheck (process.argv[1]); if we're installed
  // globally, same path.
  const selfPath = process.argv[1];

  console.log(color("dim", "  Running pre-deploy check ..."));
  const checkArgs = ["deploy-check", domain, "--ai"];
  // In advisory mode the deploy NEVER blocks — pass --fail-on none so the
  // server returns findings but the verdict downgrades to report.
  if (gateMode === "advisory") checkArgs.push("--fail-on", "none");
  // In strict mode block on any finding ≥ medium.
  if (gateMode === "strict") checkArgs.push("--fail-on", "medium");

  let checkOutput = "";
  const checkExitCode = await new Promise((resolve) => {
    const child = spawn(process.execPath, [selfPath, ...checkArgs], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    child.stdout.on("data", (chunk) => {
      const s = chunk.toString();
      checkOutput += s;
      process.stdout.write(s);
    });
    child.on("close", (code) => resolve(code ?? 3));
    child.on("error", () => resolve(3));
  });

  // Parse the structured CIPHERWAKE_AI_GUARD_RESULT block to extract
  // ship_decision (the contract field). If we can't find it, fail safe.
  let shipDecision = "review";
  const blockMatch = checkOutput.match(/CIPHERWAKE_AI_GUARD_RESULT\n([\s\S]*?)\nEND_CIPHERWAKE_AI_GUARD_RESULT/);
  if (blockMatch) {
    const sdLine = blockMatch[1].split("\n").find((l) => l.startsWith("ship_decision="));
    if (sdLine) shipDecision = sdLine.split("=")[1].trim();
  }

  console.log("");
  console.log(color("bold", `  Pre-deploy check returned: ship_decision=${shipDecision}`));

  // Decide what to do.
  if (shipDecision === "pass") {
    console.log(color("green", "  ✓ Posture stable — running deploy command."));
    console.log("");
  } else if (shipDecision === "review") {
    if (bypassReason) {
      console.log(color("yellow", "  ⚠ Review-level finding(s) detected, but --bypass is set — proceeding."));
    } else if (process.stdin.isTTY) {
      const readline = await import("node:readline");
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise((resolve) => {
        rl.question(color("yellow", "\n  ⚠ Cipherwake flagged a review-level finding. Continue with deploy? [y/N]: "), (a) => {
          rl.close();
          resolve((a || "").trim().toLowerCase());
        });
      });
      if (answer !== "y" && answer !== "yes") {
        console.log(color("dim", "  Deploy cancelled by user."));
        process.exit(1);
      }
    } else {
      console.error(color("red", "  ✗ Review-level finding(s) and no interactive terminal — failing closed."));
      console.error(color("dim", "  Re-run interactively, or pass --bypass \"<reason>\" to acknowledge."));
      process.exit(1);
    }
  } else if (shipDecision === "block") {
    if (bypassReason) {
      console.log(color("red", "  ⚠ BLOCK-level finding, but --bypass is set with explicit reason — proceeding."));
      console.log(color("dim", `  Logged bypass reason: "${bypassReason}"`));
    } else {
      console.error(color("red", "  ✗ Cipherwake returned BLOCK — refusing to run deploy command."));
      console.error(color("dim", "  Investigate the finding above. To override, re-run with --bypass \"<your reason>\"."));
      process.exit(2);
    }
  }

  // Execute the wrapped deploy command.
  console.log(color("dim", `  Executing: ${deployCmd.join(" ")}`));
  console.log("");
  const deployExitCode = await new Promise((resolve) => {
    const child = spawn(deployCmd[0], deployCmd.slice(1), { stdio: "inherit" });
    child.on("close", (code) => resolve(code ?? 3));
    child.on("error", (err) => {
      console.error(color("red", `  ✗ Deploy command failed to spawn: ${err.message}`));
      resolve(3);
    });
  });

  if (deployExitCode !== 0) {
    console.error(color("red", `\n  ✗ Deploy command exited with code ${deployExitCode}.`));
    process.exit(deployExitCode);
  }

  // Post-deploy check — useful for verifying the live URL after deploy.
  if (!noPostCheck) {
    console.log("");
    console.log(color("dim", "  Running post-deploy check ..."));
    const postExitCode = await new Promise((resolve) => {
      const child = spawn(process.execPath, [selfPath, domain, "--ai", "--fresh"], { stdio: "inherit" });
      child.on("close", (code) => resolve(code ?? 0));
      child.on("error", () => resolve(0));
    });
    if (postExitCode !== 0) {
      console.error(color("yellow", `\n  ⚠ Post-deploy check returned non-zero (${postExitCode}) — investigate before announcing.`));
    }
  }

  console.log("");
  console.log(color("green", "  ◆ Deploy guard complete."));
  process.exit(0);
}

// =============================================================================
// `pqcheck protocol install` — Rule 17 consent-flow installer for the AI Coder
// Protocol.
// =============================================================================
// Detects ~/.claude/CLAUDE.md and ./.cursorrules, then asks ONE upfront question
// (auto / manual / no) per Rule 17. Never silently writes user config.
// =============================================================================
const AI_CODER_PROTOCOL_TEXT = `
## Pre-deploy verification with Cipherwake

Before announcing any deploy of a public-facing site, you MUST run a
Cipherwake deploy check and route on the result.

1. Run:

   npx pqcheck deploy-check <your-domain> --ai

   (Or wrap your deploy command with: npx pqcheck guard --domain <your-domain> -- <deploy-cmd>)

2. Parse the CIPHERWAKE_AI_GUARD_RESULT block at the end of stdout.
   Extract the \`ship_decision\` field.

3. Route on ship_decision:

   • pass    — Public trust surface is stable. Safe to announce.

   • review  — STOP. Surface the change to the user:

               "Cipherwake flagged a change: <top_issue>. The public
                trust surface drifted between baseline and now. Want me to:
                  1) Ship anyway (you accept the change as intentional)
                  2) Revert the deploy
                  3) Investigate before deciding"

               Wait for explicit user choice. Do NOT announce the deploy
               until they confirm.

   • block   — STOP. Surface to the user:

               "Cipherwake flagged a CRITICAL change: <top_issue>.
                I recommend not announcing this deploy until we investigate.
                Want to revert and look, or override?"

               Wait for explicit user override before announcing.

4. Never claim a deploy is "done" or "shipped" until either:
   • ship_decision was pass, OR
   • the user explicitly confirmed they want to ship despite review/block.

Reference: https://cipherwake.io/methodology/ai-coder-protocol
`;

async function runProtocolCommand(args) {
  const sub = args[0];
  if (sub !== "install") {
    console.error(color("red", `error: unknown protocol subcommand "${sub || ""}"`));
    console.error(color("dim", "Usage:"));
    console.error(color("dim", "  Interactive:       npx pqcheck protocol install"));
    console.error(color("dim", "  Auto (incl AI):    npx pqcheck protocol install --auto"));
    console.error(color("dim", "  Print only:        npx pqcheck protocol install --manual"));
    console.error(color("dim", "  Add audit metadata: --invoked-by=\"<name>\" --consent-phrase=\"<user words>\""));
    process.exit(3);
  }

  const os = await import("node:os");
  const path = await import("node:path");
  const fs = await import("node:fs/promises");
  const readline = await import("node:readline");

  // -------------------------------------------------------------------------
  // Flag-driven setup mode (per CLAUDE.md Rule 17 — agent-invocation path).
  //   --auto   → install to all detected files, no prompts. AI-agent-friendly.
  //   --manual → print only, no install. Same as choosing [m] interactively.
  //   (no flag, with TTY)  → interactive [a/m/n] prompt
  //   (no flag, no TTY)    → bail with helpful error pointing at --auto/--manual
  //
  // Optional audit metadata (richer trail in install-prefs.json):
  //   --invoked-by="<name>"      — who initiated the install (AI name+version, "human", etc.)
  //   --consent-phrase="<words>" — the literal words that authorized this (free-form)
  //
  // The flag's presence IS the consent signal — Cipherwake doesn't second-guess
  // a flag that's explicitly typed. The audit trail file captures who, when,
  // and what for customer recourse if needed.
  //
  // Rule 17's spirit is "no surprises." A flag that was explicitly passed
  // (by a human or by an AI on the human's behalf) is the opposite of a
  // surprise — it's a recorded, intentional action.
  // -------------------------------------------------------------------------
  const autoFlag = args.includes("--auto");
  const manualFlag = args.includes("--manual");
  const invokedBy = parseFlag(args, "--invoked-by") || (autoFlag ? "unknown-agent-or-script" : null);
  const consentPhrase = parseFlag(args, "--consent-phrase") || null;

  if (autoFlag && manualFlag) {
    console.error(color("red", "error: --auto and --manual are mutually exclusive"));
    process.exit(3);
  }

  // Detect candidate files across major AI coders that:
  //   (a) read an instructions file at session start, AND
  //   (b) can run shell commands (so they can actually invoke pqcheck).
  //
  // Surfaces that ONLY do autocomplete (Copilot ghost text, basic Codeium,
  // tab-only IDEs) are intentionally not here — the protocol can't apply to
  // them; they need the GitHub Action PR-comment surface instead.
  const candidates = [
    { label: "Claude Code (global)", path: path.join(os.homedir(), ".claude", "CLAUDE.md") },
    { label: "Claude Code (project)", path: path.join(process.cwd(), "CLAUDE.md") },
    { label: "Cursor (project)", path: path.join(process.cwd(), ".cursorrules") },
    { label: "Aider conf (project)", path: path.join(process.cwd(), ".aider.conf.yml") },
    { label: "Aider conventions (project)", path: path.join(process.cwd(), "CONVENTIONS.md") },
    { label: "GitHub Copilot Chat / Workspace (project)", path: path.join(process.cwd(), ".github", "copilot-instructions.md") },
    { label: "Windsurf / Codeium (project)", path: path.join(process.cwd(), ".windsurfrules") },
    { label: "Continue.dev (project)", path: path.join(process.cwd(), ".continuerules") },
    { label: "Cline / Roo Cline (project)", path: path.join(process.cwd(), ".clinerules") },
    { label: "AGENTS.md (cross-tool standard)", path: path.join(process.cwd(), "AGENTS.md") },
  ];

  const detected = [];
  for (const c of candidates) {
    try {
      await fs.access(c.path);
      detected.push(c);
    } catch { /* file doesn't exist; that's OK */ }
  }

  console.log("");
  console.log(color("bold", "◆ Cipherwake AI Coder Protocol — install"));
  console.log("");
  if (autoFlag || manualFlag) {
    console.log(color("dim", `Mode: ${autoFlag ? "auto (--auto flag set)" : "print-only (--manual flag set)"}`));
    if (invokedBy) console.log(color("dim", `Invoked by: ${invokedBy}`));
    if (consentPhrase) console.log(color("dim", `Consent phrase: "${consentPhrase}"`));
    console.log("");
  }
  console.log("Here's what would be added:");
  console.log("");
  if (detected.length === 0) {
    // Default to creating project-local ./CLAUDE.md rather than global
    // ~/.claude/CLAUDE.md. Mirrors the cli/setup --scope=project default
    // (commit 4450e77): don't pollute global config when no signal exists
    // that the user wants machine-wide installation. Pass --scope=global
    // to override and create ~/.claude/CLAUDE.md instead.
    const scopeRaw = (parseFlag(args, "--scope") || "project").toLowerCase();
    const useGlobal = scopeRaw === "global";
    const fallbackPath = useGlobal
      ? path.join(os.homedir(), ".claude", "CLAUDE.md")
      : path.join(process.cwd(), "CLAUDE.md");
    const fallbackDisplay = fallbackPath.replace(os.homedir(), "~");
    console.log(color("dim", "  No existing CLAUDE.md / .cursorrules / .aider.conf.yml found."));
    console.log(color("dim", `  Creating ${fallbackDisplay} with the protocol.`));
    if (!useGlobal) {
      console.log(color("dim", "  (pass --scope global to create ~/.claude/CLAUDE.md instead)"));
    }
    detected.push({ label: useGlobal ? "Claude Code (will create global)" : "Claude Code (will create project)", path: fallbackPath });
  }
  for (const d of detected) {
    console.log(`  • Append a ~30-line "## Pre-deploy verification with Cipherwake" section to ${color("bold", d.path)}`);
    console.log(`    ${color("dim", `(${d.label} — existing content preserved)`)}`);
  }
  console.log("");

  // --manual → print only, no install
  if (manualFlag) {
    console.log(color("bold", "── Cipherwake AI Coder Protocol — paste this into your AI coder's instructions ──"));
    console.log(AI_CODER_PROTOCOL_TEXT);
    console.log(color("bold", "── End of protocol ──"));
    console.log("");
    console.log(color("dim", `For target files, see: ${detected.map(d => d.path).join(", ")}`));
    process.exit(0);
  }

  // --auto → install to all detected files
  if (autoFlag) {
    console.log(color("dim", "Auto-install (--auto flag set). Writing audit trail to ~/.config/cipherwake/install-prefs.json."));
    console.log("");
    return await performAutoInstall(detected, {
      mode: "auto-flag",
      consent_phrase: consentPhrase,
      invoked_by: invokedBy,
      fs, path, os,
    });
  }

  // Interactive (human-at-terminal) path.
  console.log("Per CLAUDE.md Rule 17, Cipherwake never modifies your config without asking.");
  console.log("");
  console.log("  [a]uto    — I add the protocol to all detected files + show you a diff afterward");
  console.log("  [m]anual  — Print the protocol so you can paste it yourself");
  console.log("  [n]o      — Skip; you can re-run anytime with `npx pqcheck protocol install`");
  console.log("");

  if (!process.stdin.isTTY) {
    console.error(color("red", "error: pqcheck protocol install requires an interactive terminal — OR an explicit --auto / --manual flag."));
    console.error(color("dim", "Re-run in an interactive shell, OR pass one of:"));
    console.error(color("dim", "  --auto    (install to all detected files; AI-friendly)"));
    console.error(color("dim", "  --manual  (print protocol so you can paste it yourself; no install)"));
    console.error(color("dim", "Optional audit metadata: --invoked-by=\"<name>\" --consent-phrase=\"<words>\""));
    process.exit(3);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const choice = await new Promise((resolve) => {
    rl.question("Choose [a/m/n]: ", (a) => {
      rl.close();
      resolve((a || "").trim().toLowerCase());
    });
  });

  if (choice === "n" || choice === "no") {
    console.log("");
    console.log(color("dim", "Skipped. Re-run anytime: npx pqcheck protocol install"));
    process.exit(0);
  }

  if (choice === "m" || choice === "manual") {
    console.log("");
    console.log(color("bold", "── Cipherwake AI Coder Protocol — paste this into your AI coder's instructions ──"));
    console.log(AI_CODER_PROTOCOL_TEXT);
    console.log(color("bold", "── End of protocol ──"));
    console.log("");
    console.log(color("dim", `For target files, see: ${detected.map(d => d.path).join(", ")}`));
    process.exit(0);
  }

  if (choice === "a" || choice === "auto") {
    return await performAutoInstall(detected, {
      mode: "interactive",
      consent_phrase: "user typed [a] at the install prompt",
      invoked_by: "human-at-terminal",
      fs, path, os,
    });
  }

  console.error(color("red", `Unknown choice "${choice}". Expected a / m / n.`));
  process.exit(3);
}

// Shared install routine — used by both interactive and agent-invoked paths.
// Writes the protocol to each detected file and records the audit trail.
async function performAutoInstall(detected, opts) {
  const { fs, path, os } = opts;
  const results = [];
  for (const d of detected) {
    try {
      await fs.mkdir(path.dirname(d.path), { recursive: true });
      let existing = "";
      try { existing = await fs.readFile(d.path, "utf8"); } catch { /* file may not exist yet */ }
      if (existing.includes("## Pre-deploy verification with Cipherwake")) {
        console.log(color("dim", `  ⊝ ${d.path} — already contains the protocol, skipping.`));
        results.push({ path: d.path, label: d.label, status: "skipped-already-present" });
        continue;
      }
      const newContent = existing + "\n" + AI_CODER_PROTOCOL_TEXT + "\n";
      await fs.writeFile(d.path, newContent, "utf8");
      console.log(color("green", `  ✓ ${d.path} — protocol appended (${AI_CODER_PROTOCOL_TEXT.split("\n").length} lines)`));
      results.push({ path: d.path, label: d.label, status: "installed" });
    } catch (err) {
      console.log(color("red", `  ✗ ${d.path} — failed: ${err.message}`));
      results.push({ path: d.path, label: d.label, status: "failed", error: String(err?.message || err) });
    }
  }

  // Persist the audit trail to ~/.config/cipherwake/install-prefs.json.
  // This is the customer's recourse if they ever dispute the install — the
  // file shows who invoked it, when, and the exact consent phrase used.
  try {
    const prefsDir = path.join(os.homedir(), ".config", "cipherwake");
    await fs.mkdir(prefsDir, { recursive: true });
    const prefsPath = path.join(prefsDir, "install-prefs.json");
    let prefs = { history: [] };
    try {
      const existing = await fs.readFile(prefsPath, "utf8");
      prefs = JSON.parse(existing);
      if (!Array.isArray(prefs.history)) prefs.history = [];
    } catch { /* first run, file doesn't exist or is malformed */ }
    prefs.history.push({
      timestamp: new Date().toISOString(),
      command: "protocol-install",
      mode: opts.mode,
      consent_phrase: opts.consent_phrase,
      invoked_by: opts.invoked_by,
      cwd: process.cwd(),
      hostname: os.hostname(),
      pqcheck_version: VERSION,
      results,
    });
    await fs.writeFile(prefsPath, JSON.stringify(prefs, null, 2), "utf8");
    console.log(color("dim", `  Audit trail: ${prefsPath}`));
  } catch (err) {
    console.log(color("dim", `  (audit trail write failed: ${err.message} — non-fatal)`));
  }

  console.log("");
  console.log(color("green", "Done. Your AI coder will follow the protocol on its next deploy."));
  console.log(color("dim", "Reference: https://cipherwake.io/methodology/ai-coder-protocol"));
  process.exit(0);
}

// =============================================================================
// `pqcheck setup --auto --domain <D>` — consolidated installer
// =============================================================================
// One command installs everything an AI-coder workflow needs:
//   1. GitHub Action workflow file (CI hard gate)
//   2. AI Coder Protocol across all detected rules files (CLAUDE.md /
//      .cursorrules / .github/copilot-instructions.md / .aider.conf.yml /
//      AGENTS.md / etc.) — multi-platform, defense-in-depth
//   3. Git pre-push hook (catches manual git push origin main bypasses)
//   4. Claude Code statusLine config in ~/.claude/settings.json (per-flag
//      consent counts as Rule 17 consent; recorded in audit trail)
//   5. VS Code extension via `code --install-extension` if `code` CLI on PATH
//      (skipped silently if not available)
//
// The pinnedai-equivalent for Cipherwake. Launch story: "One command, every
// AI coder ready."
//
// Usage:
//   npx pqcheck setup --auto --domain cipherwake.io
//   npx pqcheck setup --auto --domain cipherwake.io \\
//     --invoked-by "Claude Code" --consent-phrase "the user said yes do B"
// =============================================================================

const GIT_PREPUSH_HOOK_SCRIPT = `#!/usr/bin/env bash
# Cipherwake pre-push hook — installed by \`pqcheck setup --auto\`
#
# Runs deploy-check before pushes to deploy-triggering branches. Catches the
# case where a human (or an AI that forgot the protocol) pushes directly to
# main without running deploy-check first. Defense-in-depth alongside the
# GitHub Action + the AI Coder Protocol.
#
# To bypass for a single push: CIPHERWAKE_HOOK_SKIP=1 git push
# To uninstall: rm .git/hooks/pre-push (or pqcheck setup --uninstall — TBD)

CIPHERWAKE_DOMAIN="\${CIPHERWAKE_DOMAIN:-DOMAIN_PLACEHOLDER}"
DEPLOY_BRANCHES_REGEX="\${CIPHERWAKE_DEPLOY_BRANCHES:-^refs/heads/(main|master|production|deploy)$}"

if [ "\$CIPHERWAKE_HOOK_SKIP" = "1" ]; then
  echo "▶ Cipherwake hook: CIPHERWAKE_HOOK_SKIP=1 — bypassing"
  exit 0
fi

# Read which refs are being pushed. We only act on pushes to deploy branches.
SHOULD_RUN=0
while read local_ref local_sha remote_ref remote_sha; do
  if [[ "\$remote_ref" =~ \$DEPLOY_BRANCHES_REGEX ]]; then
    SHOULD_RUN=1
    break
  fi
done

if [ "\$SHOULD_RUN" = "0" ]; then
  exit 0
fi

echo "▶ Cipherwake pre-push: running deploy-check on \$CIPHERWAKE_DOMAIN..."

# npx pqcheck deploy-check exits: 0=pass, 1=warn/review, 2=fail/block, 3=error
npx --yes pqcheck deploy-check "\$CIPHERWAKE_DOMAIN" --ai
RC=\$?

case "\$RC" in
  0)
    echo "▶ Cipherwake: ship_decision=pass — proceeding with push"
    exit 0
    ;;
  1)
    echo ""
    echo "▶ Cipherwake flagged a REVIEW-level finding (see output above)."
    echo "▶ Push allowed — but please review the change before announcing the deploy."
    echo "▶ To suppress this notice for one push: CIPHERWAKE_HOOK_SKIP=1 git push"
    exit 0
    ;;
  2)
    echo ""
    echo "✗ Cipherwake returned BLOCK — refusing push."
    echo "✗ Investigate the finding above before deploying."
    echo "✗ To override (with explicit acknowledgement): CIPHERWAKE_HOOK_SKIP=1 git push"
    exit 1
    ;;
  *)
    echo "▶ Cipherwake pre-check errored (exit \$RC) — allowing push (fail-open)."
    echo "▶ Set CIPHERWAKE_API_KEY if deploy-check is failing on auth."
    exit 0
    ;;
esac
`;

const CLAUDE_STATUSLINE_CONFIG_SNIPPET = `
  "statusLine": {
    "type": "command",
    "command": "npx --package=pqcheck@latest cipherwake-statusline"
  }`;

// R74-confirm SHIP #14-15 (GPT 2026-05-22): network connectivity diagnostic.
// Customer runs this when "scan hung" or "command not found" to surface the
// actual broken hop instead of guessing. Tests: DNS resolution → TCP → TLS
// → HTTP for each upstream.
async function runDebugNetworkCommand() {
  console.log("");
  console.log(color("bold", "◆ Cipherwake — network diagnostic"));
  console.log(color("dim", "Probes every upstream the CLI depends on. Run this when scans hang or fail."));
  console.log("");

  const probes = [
    { name: "cipherwake.io (API)", url: "https://cipherwake.io/api/scan?domain=cipherwake.io" },
    { name: "cipherwake.io (homepage)", url: "https://cipherwake.io/" },
    { name: "crt.sh (CT log upstream)", url: "https://crt.sh/?q=%25.cipherwake.io&output=json" },
    { name: "Vercel direct (bypass Cloudflare)", url: "https://quantapact.vercel.app/" },
  ];

  let anyFailed = false;
  for (const p of probes) {
    const t0 = Date.now();
    try {
      const ctrl = new AbortController();
      const tmr = setTimeout(() => ctrl.abort(), 10000);
      const resp = await fetch(p.url, { method: "HEAD", signal: ctrl.signal });
      clearTimeout(tmr);
      const elapsed = Date.now() - t0;
      const statusOk = resp.status >= 200 && resp.status < 500;
      const marker = statusOk ? color("green", "✓") : color("yellow", "⚠");
      console.log(`  ${marker} ${p.name.padEnd(38)} HTTP ${resp.status}  ${elapsed}ms`);
      if (!statusOk) anyFailed = true;
    } catch (err) {
      anyFailed = true;
      const elapsed = Date.now() - t0;
      const msg = (err && err.message) || String(err);
      const kind = err?.name === "AbortError" ? "timeout" : "error";
      console.log(`  ${color("red", "✗")} ${p.name.padEnd(38)} ${kind.toUpperCase()}  ${elapsed}ms  ${msg.slice(0, 60)}`);
    }
  }

  console.log("");
  if (anyFailed) {
    console.log(color("bold", "Possible causes (in order of likelihood):"));
    console.log("  1. Corporate proxy / VPN blocking outbound HTTPS to public scanners.");
    console.log("     → Try setting HTTPS_PROXY env var, or run from a non-corporate network.");
    console.log("  2. Cloudflare WAF rate-limited your IP. Wait 5-15min and retry.");
    console.log("     → Or switch networks (mobile hotspot bypasses your home IP).");
    console.log("  3. DNS resolver doesn't resolve cipherwake.io.");
    console.log("     → Test with: `dig cipherwake.io`. If it fails, your resolver is offline.");
    console.log("  4. crt.sh is intermittently slow — that's the upstream we use for CT logs.");
    console.log("     → Cipherwake degrades to a 14-day stale-cache fallback when crt.sh fails, so this");
    console.log("       only matters on first scan of brand-new domains.");
    console.log("");
    console.log(color("dim", "If you're still blocked, file a bug at https://cipherwake.io/feedback"));
    process.exit(1);
  } else {
    console.log(color("green", "  ✓ All upstreams reachable — Cipherwake should work for you."));
    console.log("");
  }
}

async function runSetupCommand(args) {
  const autoFlag = args.includes("--auto");
  const planFlag = args.includes("--plan");                              // R74-confirm BLOCKING #19 (GPT 2026-05-22)
  const domain = parseFlag(args, "--domain");
  const failOn = parseFlag(args, "--fail-on") || "high";
  const baseline = parseFlag(args, "--baseline") || "last-scan";
  const invokedBy = parseFlag(args, "--invoked-by") || (autoFlag ? "unknown-agent-or-script" : null);
  const consentPhrase = parseFlag(args, "--consent-phrase") || null;
  const skipWorkflow = args.includes("--skip-workflow");
  const skipProtocol = args.includes("--skip-protocol");
  const skipHook = args.includes("--skip-hook");
  const skipStatusline = args.includes("--skip-statusline");
  const skipVscode = args.includes("--skip-vscode");
  // Where to install Claude Code statusLine + hooks. Default 'project' keeps
  // Cipherwake scoped to the current repo (avoids the "Cipherwake badge
  // follows me into unrelated projects" UX bug). 'global' is opt-in for
  // power users who want one canonical domain badge across every project.
  const settingsScope = (parseFlag(args, "--scope") || "project").toLowerCase();
  if (!["project", "global"].includes(settingsScope)) {
    console.error(color("red", `error: --scope must be 'project' or 'global' (got '${settingsScope}')`));
    process.exit(3);
  }

  if (!domain) {
    console.error(color("red", "error: pqcheck setup requires --domain"));
    console.error(color("dim", "Usage: npx pqcheck setup --auto --domain example.com"));
    console.error(color("dim", "  --plan                     Print the install plan without writing any files"));
    console.error(color("dim", "  --scope project|global     Where to install Claude Code hooks (default: project — this repo only)"));
    console.error(color("dim", "  --invoked-by=\"<name>\" --consent-phrase=\"<words>\"   (audit trail)"));
    console.error(color("dim", "Skip flags: --skip-workflow --skip-protocol --skip-hook --skip-statusline --skip-vscode"));
    process.exit(3);
  }
  if (!autoFlag && !planFlag && !process.stdin.isTTY) {
    console.error(color("red", "error: pqcheck setup requires --auto or --plan when stdin is not a TTY"));
    console.error(color("dim", "Pass --auto explicitly (the flag IS the consent signal per CLAUDE.md Rule 17),"));
    console.error(color("dim", "or --plan to see what would be installed without writing anything."));
    process.exit(3);
  }

  // R74-confirm BLOCKING #19 (GPT 2026-05-22): --plan mode prints the
  // intended changes without writing. Addresses GPT's "init modifies too
  // much without a clear dry run" concern. Customer can run --plan first
  // to inspect, then run --auto when they're comfortable. AI agents are
  // encouraged (per the protocol page) to run --plan first when no recent
  // user consent for --auto exists in the conversation.
  if (planFlag) {
    const os = await import("node:os");
    const path = await import("node:path");
    const fs = await import("node:fs/promises");
    console.log("");
    console.log(color("bold", `◆ Cipherwake Setup — PLAN (dry run, no files will be written)`));
    console.log(color("dim", `Domain target: ${domain}`));
    console.log("");
    console.log(color("bold", "Files this install would touch:"));
    const planEntries = [];
    if (!skipWorkflow) planEntries.push({ what: "GitHub Action workflow", to: path.join(process.cwd(), ".github", "workflows", "cipherwake.yml"), op: "create" });
    if (!skipProtocol) {
      const candidates = [
        { label: "Claude Code (global)", path: path.join(os.homedir(), ".claude", "CLAUDE.md") },
        { label: "Claude Code (project)", path: path.join(process.cwd(), "CLAUDE.md") },
        { label: "Cursor", path: path.join(process.cwd(), ".cursorrules") },
        { label: "GitHub Copilot", path: path.join(process.cwd(), ".github", "copilot-instructions.md") },
        { label: "Aider", path: path.join(process.cwd(), ".aider.conf.yml") },
        { label: "AGENTS.md", path: path.join(process.cwd(), "AGENTS.md") },
      ];
      for (const c of candidates) {
        let exists = false;
        try { await fs.access(c.path); exists = true; } catch { /* */ }
        planEntries.push({ what: `AI Coder Protocol — ${c.label}`, to: c.path, op: exists ? "append-markered" : "skip (file not present)" });
      }
    }
    if (!skipHook) planEntries.push({ what: "git pre-push hook", to: path.join(process.cwd(), ".git", "hooks", "pre-push"), op: "create (if git repo)" });
    if (!skipStatusline) {
      const settingsPath = settingsScope === "global"
        ? path.join(os.homedir(), ".claude", "settings.json")
        : path.join(process.cwd(), ".claude", "settings.json");
      let exists = false;
      try { await fs.access(settingsPath); exists = true; } catch { /* */ }
      const scopeNote = settingsScope === "global"
        ? " [GLOBAL — fires in every project on this machine]"
        : " [PROJECT-LOCAL — fires only when Claude Code runs in this directory]";
      planEntries.push({ what: `Claude Code statusLine${scopeNote}`, to: settingsPath, op: exists ? "deep-merge (backup first)" : "create" });
      planEntries.push({ what: "Claude Code chat-hook (PostToolUse Bash)", to: settingsPath, op: exists ? "deep-merge into hooks.PostToolUse" : "create" });
      planEntries.push({ what: "Claude Code prompt-hook (UserPromptSubmit)", to: settingsPath, op: exists ? "deep-merge into hooks.UserPromptSubmit" : "create" });
    }
    if (!skipVscode) planEntries.push({ what: "VS Code / Cursor extension", to: "via `code --install-extension cipherwakelabs.cipherwake-statusbar`", op: "attempt (soft-fail if Marketplace listing missing)" });
    for (const e of planEntries) {
      console.log(`  ${color("dim", e.op.padEnd(28))} ${color("bold", e.what)}`);
      console.log(`    ${color("dim", "→")} ${e.to}`);
    }
    console.log("");
    console.log(color("bold", "To proceed:"));
    console.log(`  npx pqcheck setup --auto --domain ${domain}${invokedBy ? ` --invoked-by "${invokedBy}"` : ""}${consentPhrase ? ` --consent-phrase "${consentPhrase}"` : ""}`);
    console.log("");
    console.log(color("dim", "Per Cipherwake Rule 17, --auto is the consent signal. Backups are taken before each settings.json write."));
    console.log("");
    return;
  }

  const os = await import("node:os");
  const path = await import("node:path");
  const fs = await import("node:fs/promises");
  const { spawn } = await import("node:child_process");

  console.log("");
  console.log(color("bold", `◆ Cipherwake Setup — ${domain}`));
  console.log("");
  if (autoFlag) {
    console.log(color("dim", "Auto mode (--auto flag set). Per CLAUDE.md Rule 17, the flag is the consent signal."));
    if (invokedBy) console.log(color("dim", `Invoked by: ${invokedBy}`));
    if (consentPhrase) console.log(color("dim", `Consent phrase: "${consentPhrase}"`));
    console.log("");
  }

  // Resolve where to write Claude Code statusLine + hook entries.
  // Default 'project' = ./.claude/settings.json (this repo only). 'global' = ~/.claude/settings.json
  // (fires in every Claude Code session on this machine). Project-local is the right default for
  // anyone with multiple projects; global is the legacy behavior and now an opt-in for the
  // "one canonical domain across everything" use case.
  const claudeSettingsPath = settingsScope === "global"
    ? path.join(os.homedir(), ".claude", "settings.json")
    : path.join(process.cwd(), ".claude", "settings.json");

  if (!skipStatusline) {
    const displayPath = claudeSettingsPath.replace(os.homedir(), "~");
    const scopeLabel = settingsScope === "global"
      ? `global (${displayPath} — fires in EVERY project on this machine)`
      : `project (${displayPath} — fires only when Claude Code runs in this directory)`;
    console.log(color("dim", `Settings scope: ${scopeLabel}`));
    console.log(color("dim", settingsScope === "global"
      ? `  (omit --scope or pass --scope project to install for this repo only)`
      : `  (pass --scope global to install for every project on this machine)`));
    console.log("");

    // Detect existing GLOBAL Cipherwake install while doing a project install.
    // Warn so the user doesn't end up with two layers firing on top of each other.
    if (settingsScope === "project") {
      try {
        const globalPath = path.join(os.homedir(), ".claude", "settings.json");
        const raw = await fs.readFile(globalPath, "utf8");
        const parsed = JSON.parse(raw);
        const hasGlobalCipherwake =
          (parsed.statusLine?.command && String(parsed.statusLine.command).includes("cipherwake")) ||
          JSON.stringify(parsed.hooks || {}).includes("cipherwake");
        if (hasGlobalCipherwake) {
          console.log(color("yellow", `  ⚠ A GLOBAL Cipherwake install already exists at ~/.claude/settings.json`));
          console.log(color("dim", `    It will continue firing across every project. To remove the global install,`));
          console.log(color("dim", `    edit ~/.claude/settings.json and delete the statusLine entry and the`));
          console.log(color("dim", `    cipherwake-chat-hook / cipherwake-prompt-hook commands. Backups are taken`));
          console.log(color("dim", `    automatically before any write, so changes are reversible.`));
          console.log("");
        }
      } catch { /* no global install — fine */ }
    }
  }

  const installSummary = [];

  // -------------------------------------------------------------------------
  // Component 1: GitHub Action workflow (.github/workflows/cipherwake.yml)
  // -------------------------------------------------------------------------
  if (!skipWorkflow) {
    const workflowPath = path.join(process.cwd(), ".github", "workflows", "cipherwake.yml");
    try {
      try {
        await fs.access(workflowPath);
        console.log(color("dim", `  ⊝ workflow at .github/workflows/cipherwake.yml already exists — skipping`));
        installSummary.push({ component: "GitHub Action workflow", path: workflowPath, status: "skipped-already-present" });
      } catch {
        const workflowYaml = renderTrustDiffWorkflow({ domain, failOn, baseline });
        await fs.mkdir(path.dirname(workflowPath), { recursive: true });
        await fs.writeFile(workflowPath, workflowYaml, "utf8");
        console.log(color("green", `  ✓ wrote .github/workflows/cipherwake.yml (CI hard-gate layer)`));
        installSummary.push({ component: "GitHub Action workflow", path: workflowPath, status: "installed" });
      }
    } catch (err) {
      console.log(color("red", `  ✗ workflow install failed: ${err.message}`));
      installSummary.push({ component: "GitHub Action workflow", status: "failed", error: String(err?.message || err) });
    }
  }

  // -------------------------------------------------------------------------
  // Component 2: AI Coder Protocol across detected rules files
  // -------------------------------------------------------------------------
  if (!skipProtocol) {
    const candidates = [
      { label: "Claude Code (global)", path: path.join(os.homedir(), ".claude", "CLAUDE.md") },
      { label: "Claude Code (project)", path: path.join(process.cwd(), "CLAUDE.md") },
      { label: "Cursor (project)", path: path.join(process.cwd(), ".cursorrules") },
      { label: "Aider conf (project)", path: path.join(process.cwd(), ".aider.conf.yml") },
      { label: "Aider conventions (project)", path: path.join(process.cwd(), "CONVENTIONS.md") },
      { label: "GitHub Copilot Chat / Workspace (project)", path: path.join(process.cwd(), ".github", "copilot-instructions.md") },
      { label: "Windsurf / Codeium (project)", path: path.join(process.cwd(), ".windsurfrules") },
      { label: "Continue.dev (project)", path: path.join(process.cwd(), ".continuerules") },
      { label: "Cline / Roo Cline (project)", path: path.join(process.cwd(), ".clinerules") },
      { label: "AGENTS.md (cross-tool standard)", path: path.join(process.cwd(), "AGENTS.md") },
    ];
    // Detect any existing files; auto-create the global Claude Code file so
    // every install yields at least one rules-file landing site.
    const protocolTargets = [];
    for (const c of candidates) {
      try {
        await fs.access(c.path);
        protocolTargets.push(c);
      } catch { /* skip */ }
    }
    if (protocolTargets.length === 0) {
      protocolTargets.push({ label: "Claude Code (created)", path: path.join(os.homedir(), ".claude", "CLAUDE.md") });
    }
    // R74-confirm BLOCKING #6 (GPT 2026-05-22): wrap the protocol section in
    // fenced markers so future installs / updates / removals can locate and
    // replace exactly this block without scanning for the heading. Idempotent:
    // if markers exist, the block between them is replaced; if neither markers
    // nor heading exist, the block is appended. Always preserves whatever the
    // user has written outside the markers.
    const START_MARKER = "<!-- CIPHERWAKE_AI_CODER_PROTOCOL_START — managed by pqcheck setup; safe to delete this section between markers but do not edit by hand -->";
    const END_MARKER = "<!-- CIPHERWAKE_AI_CODER_PROTOCOL_END -->";
    for (const t of protocolTargets) {
      try {
        await fs.mkdir(path.dirname(t.path), { recursive: true });
        let existing = "";
        try { existing = await fs.readFile(t.path, "utf8"); } catch { /* file may not exist */ }

        const hasMarkers = existing.includes(START_MARKER) && existing.includes(END_MARKER);
        const hasLegacyHeading = existing.includes("## Pre-deploy verification with Cipherwake");

        if (hasMarkers) {
          // Replace just the bounded section — leaves all other user content untouched.
          const startIdx = existing.indexOf(START_MARKER);
          const endIdx = existing.indexOf(END_MARKER) + END_MARKER.length;
          const before = existing.slice(0, startIdx);
          const after = existing.slice(endIdx);
          const next = `${before.replace(/\n+$/, "")}\n\n${START_MARKER}\n${AI_CODER_PROTOCOL_TEXT}\n${END_MARKER}\n${after.replace(/^\n+/, "")}`;
          if (next === existing) {
            console.log(color("dim", `  ⊝ ${path.basename(t.path)} (${t.label}) — protocol already current`));
            installSummary.push({ component: "AI Coder Protocol", path: t.path, label: t.label, status: "skipped-already-present" });
            continue;
          }
          await fs.writeFile(t.path, next, "utf8");
          console.log(color("green", `  ✓ refreshed protocol section → ${path.basename(t.path)} (${t.label})`));
          installSummary.push({ component: "AI Coder Protocol", path: t.path, label: t.label, status: "installed-updated" });
        } else if (hasLegacyHeading) {
          // Old install lacks markers. Don't double-append; treat as already present.
          // Note: customers can re-run `pqcheck protocol install --auto` to upgrade to the markered form.
          console.log(color("dim", `  ⊝ ${path.basename(t.path)} (${t.label}) — legacy unmarkered protocol present (run \`pqcheck protocol install --auto\` to upgrade to markered form)`));
          installSummary.push({ component: "AI Coder Protocol", path: t.path, label: t.label, status: "skipped-legacy-present" });
        } else {
          // Fresh install — append with fenced markers.
          const sep = existing.length > 0 ? "\n\n" : "";
          await fs.writeFile(t.path, `${existing}${sep}${START_MARKER}\n${AI_CODER_PROTOCOL_TEXT}\n${END_MARKER}\n`, "utf8");
          console.log(color("green", `  ✓ appended protocol (markered) → ${path.basename(t.path)} (${t.label})`));
          installSummary.push({ component: "AI Coder Protocol", path: t.path, label: t.label, status: "installed" });
        }
      } catch (err) {
        console.log(color("red", `  ✗ ${t.path} — failed: ${err.message}`));
        installSummary.push({ component: "AI Coder Protocol", path: t.path, status: "failed", error: String(err?.message || err) });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Component 3: Git pre-push hook
  // -------------------------------------------------------------------------
  if (!skipHook) {
    const gitDir = path.join(process.cwd(), ".git");
    let isGitRepo = true;
    try { await fs.access(gitDir); } catch { isGitRepo = false; }
    if (!isGitRepo) {
      console.log(color("dim", `  ⊝ git pre-push hook — skipped (not a git repo: no .git dir in ${process.cwd()})`));
      installSummary.push({ component: "git pre-push hook", status: "skipped-not-git-repo" });
    } else {
      const hookPath = path.join(gitDir, "hooks", "pre-push");
      try {
        let existing = "";
        try { existing = await fs.readFile(hookPath, "utf8"); } catch { /* file may not exist */ }
        if (existing.includes("Cipherwake pre-push hook")) {
          console.log(color("dim", `  ⊝ .git/hooks/pre-push already contains the Cipherwake hook — skipping`));
          installSummary.push({ component: "git pre-push hook", path: hookPath, status: "skipped-already-present" });
        } else if (existing.trim() && !existing.startsWith("#!/")) {
          console.log(color("yellow", `  ⊝ .git/hooks/pre-push exists but doesn't look like our hook — skipped to avoid overwriting your script`));
          installSummary.push({ component: "git pre-push hook", path: hookPath, status: "skipped-conflicts" });
        } else {
          const hookScript = GIT_PREPUSH_HOOK_SCRIPT.replace("DOMAIN_PLACEHOLDER", domain);
          await fs.mkdir(path.dirname(hookPath), { recursive: true });
          await fs.writeFile(hookPath, hookScript, { mode: 0o755 });
          // Ensure executable bit set (writeFile mode is platform-dependent)
          try { await fs.chmod(hookPath, 0o755); } catch { /* best effort */ }
          console.log(color("green", `  ✓ installed .git/hooks/pre-push (catches manual \`git push origin main\` bypasses)`));
          installSummary.push({ component: "git pre-push hook", path: hookPath, status: "installed" });
        }
      } catch (err) {
        console.log(color("red", `  ✗ pre-push hook install failed: ${err.message}`));
        installSummary.push({ component: "git pre-push hook", path: hookPath, status: "failed", error: String(err?.message || err) });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Component 4: Claude Code statusLine config
  // -------------------------------------------------------------------------
  // R74-confirm BLOCKING #10 (GPT 2026-05-22): backup before any settings.json
  // write. The user's ~/.claude/settings.json is theirs; we deep-merge our
  // entries but if the merge is ever wrong (existing key shape we didn't
  // anticipate), the backup gives them a one-second rollback path. The backup
  // is also surfaced in the install summary so the audit trail captures it.
  async function backupSettingsJson(settingsPath) {
    try {
      let raw;
      try { raw = await fs.readFile(settingsPath, "utf8"); } catch { return null; }
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const backupPath = `${settingsPath}.bak.${ts}`;
      await fs.writeFile(backupPath, raw, "utf8");
      return backupPath;
    } catch (e) {
      console.log(color("yellow", `  ⚠ settings.json backup failed (${(e && e.message || e)}); proceeding anyway`));
      return null;
    }
  }

  if (!skipStatusline) {
    const settingsPath = claudeSettingsPath;
    const displayPath = settingsPath.replace(os.homedir(), "~");
    try {
      let settings = {};
      let existed = false;
      try {
        const raw = await fs.readFile(settingsPath, "utf8");
        settings = JSON.parse(raw);
        existed = true;
      } catch { /* will create */ }
      if (existed && settings.statusLine && typeof settings.statusLine === "object") {
        // Already has a statusLine config — don't overwrite.
        console.log(color("dim", `  ⊝ ${displayPath} already has a statusLine entry — leaving alone`));
        console.log(color("dim", `    To use the Cipherwake statusline instead, set: "command": "npx --package=pqcheck@latest cipherwake-statusline"`));
        installSummary.push({ component: "Claude Code statusLine", path: settingsPath, status: "skipped-existing-config" });
      } else {
        const backupPath = existed ? await backupSettingsJson(settingsPath) : null;
        if (backupPath) console.log(color("dim", `    backup: ${backupPath}`));
        settings.statusLine = { type: "command", command: "npx --package=pqcheck@latest cipherwake-statusline" };
        await fs.mkdir(path.dirname(settingsPath), { recursive: true });
        await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
        console.log(color("green", `  ✓ added statusLine config → ${displayPath}`));
        installSummary.push({ component: "Claude Code statusLine", path: settingsPath, status: existed ? "installed-updated" : "installed-created", backup: backupPath });
      }
    } catch (err) {
      console.log(color("red", `  ✗ statusLine config install failed: ${err.message}`));
      installSummary.push({ component: "Claude Code statusLine", path: settingsPath, status: "failed", error: String(err?.message || err) });
    }
  }

  // -------------------------------------------------------------------------
  // Component 4b: Claude Code chat-hook (PostToolUse on Bash → cipherwake-chat-hook)
  // Pushes a live "◆ Cipherwake just caught X" message into the chat scrollback
  // every time a pqcheck command runs. Merges with existing hook configs;
  // doesn't clobber other hooks per CLAUDE.md Rule 17.
  // -------------------------------------------------------------------------
  if (!skipStatusline) {
    const settingsPath = claudeSettingsPath;
    const displayPath = settingsPath.replace(os.homedir(), "~");
    try {
      let settings = {};
      let existed = false;
      try {
        const raw = await fs.readFile(settingsPath, "utf8");
        settings = JSON.parse(raw);
        existed = true;
      } catch { /* will create */ }
      settings.hooks = settings.hooks || {};
      settings.hooks.PostToolUse = settings.hooks.PostToolUse || [];

      // Look for an existing matcher entry for Bash
      let bashEntry = settings.hooks.PostToolUse.find((e) => e?.matcher === "Bash");
      if (!bashEntry) {
        bashEntry = { matcher: "Bash", hooks: [] };
        settings.hooks.PostToolUse.push(bashEntry);
      }
      bashEntry.hooks = bashEntry.hooks || [];

      const cipherwakeHookCmd = "npx --package=pqcheck@latest cipherwake-chat-hook";
      const alreadyInstalled = bashEntry.hooks.some(
        (h) => h?.type === "command" && typeof h?.command === "string" && h.command.includes("cipherwake-chat-hook"),
      );

      if (alreadyInstalled) {
        console.log(color("dim", `  ⊝ chat-hook already configured in ${displayPath} PostToolUse — skipping`));
        installSummary.push({ component: "Claude Code chat-hook", path: settingsPath, status: "skipped-already-present" });
      } else {
        const backupPath = existed ? await backupSettingsJson(settingsPath) : null;
        if (backupPath) console.log(color("dim", `    backup: ${backupPath}`));
        bashEntry.hooks.push({ type: "command", command: cipherwakeHookCmd });
        await fs.mkdir(path.dirname(settingsPath), { recursive: true });
        await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
        console.log(color("green", `  ✓ added chat-hook (PostToolUse Bash) → ${displayPath}`));
        console.log(color("dim", `    Every \`pqcheck\` run will now push a live status message into Claude Code chat`));
        installSummary.push({ component: "Claude Code chat-hook", path: settingsPath, status: existed ? "installed-updated" : "installed-created", backup: backupPath });
      }
    } catch (err) {
      console.log(color("red", `  ✗ chat-hook install failed: ${err.message}`));
      installSummary.push({ component: "Claude Code chat-hook", status: "failed", error: String(err?.message || err) });
    }
  }

  // -------------------------------------------------------------------------
  // Component 4c: Claude Code prompt-hook (UserPromptSubmit → cipherwake-prompt-hook)
  // v0.15.1 — pinnedai-parity item. Injects ship_decision into Claude's
  // context BEFORE Claude responds to every user prompt. Different timing
  // from 4b: chat-hook fires AFTER a tool ran (reactive), prompt-hook fires
  // BEFORE Claude responds (proactive). Silent when state is missing / stale
  // / ship_decision=pass (no spam).
  // -------------------------------------------------------------------------
  if (!skipStatusline) {
    const settingsPath = claudeSettingsPath;
    const displayPath = settingsPath.replace(os.homedir(), "~");
    try {
      let settings = {};
      let existed = false;
      try {
        const raw = await fs.readFile(settingsPath, "utf8");
        settings = JSON.parse(raw);
        existed = true;
      } catch { /* will create */ }
      settings.hooks = settings.hooks || {};
      settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit || [];

      const cipherwakeHookCmd = "npx --package=pqcheck@latest cipherwake-prompt-hook";
      const alreadyInstalled = settings.hooks.UserPromptSubmit.some(
        (entry) => Array.isArray(entry?.hooks) && entry.hooks.some(
          (h) => h?.type === "command" && typeof h?.command === "string" && h.command.includes("cipherwake-prompt-hook"),
        ),
      );

      if (alreadyInstalled) {
        console.log(color("dim", `  ⊝ prompt-hook already configured in ${displayPath} UserPromptSubmit — skipping`));
        installSummary.push({ component: "Claude Code prompt-hook", path: settingsPath, status: "skipped-already-present" });
      } else {
        const backupPath = existed ? await backupSettingsJson(settingsPath) : null;
        if (backupPath) console.log(color("dim", `    backup: ${backupPath}`));
        settings.hooks.UserPromptSubmit.push({ hooks: [{ type: "command", command: cipherwakeHookCmd }] });
        await fs.mkdir(path.dirname(settingsPath), { recursive: true });
        await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
        console.log(color("green", `  ✓ added prompt-hook (UserPromptSubmit) → ${displayPath}`));
        console.log(color("dim", `    Claude will see latest ship_decision in context on every prompt (when REVIEW/BLOCK)`));
        installSummary.push({ component: "Claude Code prompt-hook", path: settingsPath, status: existed ? "installed-updated" : "installed-created", backup: backupPath });
      }
    } catch (err) {
      console.log(color("red", `  ✗ prompt-hook install failed: ${err.message}`));
      installSummary.push({ component: "Claude Code prompt-hook", status: "failed", error: String(err?.message || err) });
    }
  }

  // -------------------------------------------------------------------------
  // Component 4d: Per-repo state directory (.cipherwake/) for Cursor / Copilot
  // v0.15.1 — pinnedai-parity item. Cursor/Copilot/Continue/Cline read repo
  // state for context. Creating .cipherwake/ in the repo gives them a
  // read-on-demand surface that subsequent `pqcheck` runs (via the
  // writeLastScanFile path) populate with the latest scan state. Also adds
  // .cipherwake/ to .gitignore if not already there — per-developer state,
  // not committable.
  // -------------------------------------------------------------------------
  if (!skipStatusline) {
    try {
      const repoStateDir = path.join(process.cwd(), ".cipherwake");
      await fs.mkdir(repoStateDir, { recursive: true });
      // Write an initial placeholder so the file exists immediately. Subsequent
      // scans via writeLastScanFile will overwrite with real data.
      const placeholderPath = path.join(repoStateDir, "last-status.json");
      try {
        await fs.access(placeholderPath);
        // Already exists — preserve it.
      } catch {
        await fs.writeFile(placeholderPath, JSON.stringify({
          domain,
          ship_decision: "unknown",
          note: "Initial placeholder — run `npx pqcheck deploy-check " + domain + " --ai` to populate",
          written_at: new Date().toISOString(),
        }, null, 2));
      }
      // Add .cipherwake/ to .gitignore if missing (don't commit per-developer state).
      const gitignorePath = path.join(process.cwd(), ".gitignore");
      let gitignore = "";
      try { gitignore = await fs.readFile(gitignorePath, "utf8"); } catch { /* may not exist */ }
      if (!/^\.cipherwake\/?\s*$/m.test(gitignore)) {
        const appended = gitignore + (gitignore.endsWith("\n") || gitignore.length === 0 ? "" : "\n") + "\n# Cipherwake per-developer scan state (read-on-demand by AI coders)\n.cipherwake/\n";
        await fs.writeFile(gitignorePath, appended);
      }
      console.log(color("green", `  ✓ created .cipherwake/last-status.json (Cursor/Copilot/Continue read this for context)`));
      installSummary.push({ component: "Per-repo state file", path: placeholderPath, status: "installed" });
    } catch (err) {
      console.log(color("red", `  ✗ per-repo state install failed: ${err.message}`));
      installSummary.push({ component: "Per-repo state file", status: "failed", error: String(err?.message || err) });
    }
  }

  // -------------------------------------------------------------------------
  // Component 5: VS Code / Cursor extension (via `code` CLI if available)
  // -------------------------------------------------------------------------
  if (!skipVscode) {
    // Check if `code` CLI is on PATH
    const codeAvailable = await new Promise((resolve) => {
      const child = spawn("code", ["--version"], { stdio: ["ignore", "ignore", "ignore"] });
      child.on("error", () => resolve(false));
      child.on("close", (rc) => resolve(rc === 0));
    });
    if (!codeAvailable) {
      console.log(color("dim", `  ⊝ VS Code extension — \`code\` CLI not on PATH. Install from Marketplace: search "Cipherwake Trust Status Bar"`));
      installSummary.push({ component: "VS Code / Cursor extension", status: "skipped-code-cli-not-available" });
    } else {
      // Note: until the extension is published to Marketplace, `code --install-extension cipherwakelabs.cipherwake-statusbar`
      // won't resolve. We attempt the install and treat failure as a soft skip.
      const installResult = await new Promise((resolve) => {
        const child = spawn("code", ["--install-extension", "cipherwakelabs.cipherwake-statusbar"], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        child.stdout?.on("data", (d) => out += d.toString());
        child.stderr?.on("data", (d) => out += d.toString());
        child.on("close", (rc) => resolve({ rc, out }));
        child.on("error", (err) => resolve({ rc: -1, out: err.message }));
      });
      if (installResult.rc === 0) {
        console.log(color("green", `  ✓ installed VS Code extension: cipherwakelabs.cipherwake-statusbar`));
        installSummary.push({ component: "VS Code / Cursor extension", status: "installed" });
      } else {
        console.log(color("dim", `  ⊝ VS Code extension install attempted but not on Marketplace yet. Awaiting publish.`));
        installSummary.push({ component: "VS Code / Cursor extension", status: "skipped-not-on-marketplace-yet", attempted: true });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Audit trail
  // -------------------------------------------------------------------------
  try {
    const prefsDir = path.join(os.homedir(), ".config", "cipherwake");
    await fs.mkdir(prefsDir, { recursive: true });
    const prefsPath = path.join(prefsDir, "install-prefs.json");
    let prefs = { history: [] };
    try {
      const existing = await fs.readFile(prefsPath, "utf8");
      prefs = JSON.parse(existing);
      if (!Array.isArray(prefs.history)) prefs.history = [];
    } catch { /* first run */ }
    prefs.history.push({
      timestamp: new Date().toISOString(),
      command: "setup",
      mode: autoFlag ? "auto-flag" : "interactive",
      domain,
      consent_phrase: consentPhrase,
      invoked_by: invokedBy,
      cwd: process.cwd(),
      hostname: os.hostname(),
      pqcheck_version: VERSION,
      summary: installSummary,
    });
    await fs.writeFile(prefsPath, JSON.stringify(prefs, null, 2), "utf8");
    console.log("");
    console.log(color("dim", `  Audit trail: ${prefsPath}`));
  } catch (err) {
    console.log(color("dim", `  (audit trail write failed: ${err.message} — non-fatal)`));
  }

  // R74-confirm BLOCKING #16 (GPT 2026-05-22): write an install manifest so
  // a Ctrl-C'd or partially-failed install can be diagnosed + resumed. The
  // manifest is the "what got done" record, separate from install-prefs.json
  // (which is the "who/why" audit trail). A future `pqcheck doctor --repair`
  // command will use this to skip already-completed steps. For now the file
  // is the artifact you can `cat` to see exactly what got written.
  try {
    const manifestPath = path.join(os.homedir(), ".config", "cipherwake", "install-manifest.json");
    let manifestList = [];
    try {
      manifestList = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      if (!Array.isArray(manifestList)) manifestList = [];
    } catch { /* new file */ }
    manifestList.unshift({
      run_at: new Date().toISOString(),
      domain,
      auto_flag: autoFlag,
      invoked_by: invokedBy || null,
      consent_phrase: consentPhrase || null,
      cwd: process.cwd(),
      cli_version: VERSION,
      install_summary: installSummary,
      // Surface the backup paths separately so `pqcheck doctor --repair --rollback` can find them
      backups: installSummary.filter((s) => s.backup).map((s) => ({ component: s.component, backup: s.backup })),
    });
    // Keep last 20 install runs for forensics
    manifestList = manifestList.slice(0, 20);
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(manifestPath, JSON.stringify(manifestList, null, 2), "utf8");
    console.log(color("dim", `  Install manifest: ${manifestPath}`));
  } catch (err) {
    console.log(color("dim", `  (manifest write failed: ${err.message} — non-fatal)`));
  }

  // -------------------------------------------------------------------------
  // Summary table
  // -------------------------------------------------------------------------
  console.log("");
  console.log(color("bold", "◆ Setup complete — summary:"));
  console.log("");
  for (const s of installSummary) {
    const icon = s.status === "installed" || s.status === "installed-created" || s.status === "installed-updated"
      ? color("green", "✓")
      : s.status?.startsWith("skipped")
        ? color("dim", "⊝")
        : color("red", "✗");
    const label = s.component;
    const detail = s.status === "installed" || s.status === "installed-created" || s.status === "installed-updated"
      ? color("dim", `installed${s.path ? " → " + s.path.replace(os.homedir(), "~") : ""}`)
      : color("dim", s.status?.replace(/-/g, " "));
    console.log(`  ${icon} ${label.padEnd(34, " ")} ${detail}`);
  }
  console.log("");
  console.log(color("dim", `Reference: https://cipherwake.io/methodology/ai-coder-protocol`));
  console.log("");

  process.exit(0);
}

main().catch((err) => {
  console.error(color("red", `fatal: ${err.message}`));
  process.exit(2);
});
