#!/usr/bin/env node
// =============================================================================
// pqcheck CLI — npx pqcheck <domain>
// =============================================================================
// Tiny wrapper around the public scan API at cipherwake.io.
// Zero deps (uses node:fetch). Works under `npx pqcheck` without installation.
// =============================================================================

const API_BASE = process.env.PQCHECK_API_BASE || "https://cipherwake.io";
const VERSION = "0.10.0";

// API-key support — paid tiers (Starter $29 / Growth $79 / Scale $199) get
// per-account monthly quotas instead of the per-IP rate limit. Set via:
//   export CIPHERWAKE_API_KEY=qpk_<32-hex>
// Anonymous CLI use still works (no env var → falls back to IP rate limit).
//
// QUANTAPACT_API_KEY is honored as a deprecated fallback for existing users
// (rebrand 2026-05-15). Will be removed in v1.0; in the meantime no break.
const QP_API_KEY = (process.env.CIPHERWAKE_API_KEY || process.env.QUANTAPACT_API_KEY || "").trim();

// Builds headers with optional Authorization. Use for every CLI → API call
// so a single env-var toggle authenticates every endpoint at once.
function apiHeaders(extra = {}) {
  const h = { accept: "application/json", "user-agent": `pqcheck-cli/${VERSION}`, ...extra };
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

  // One-shot scan(s)
  let worstExit = 0;
  for (const domain of domains) {
    const exit = await runOneScan({ domain, format, quiet, threshold, webhookUrl, multi: domains.length > 1, fresh });
    if (exit > worstExit) worstExit = exit;
  }
  process.exit(worstExit);
}

async function runOneScan({ domain, format, quiet, threshold, webhookUrl, multi, fresh }) {
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
      headers: apiHeaders({ "user-agent": `pqcheck-cli/${VERSION} (scan)` }),
    });
    if (!quiet && format === "text") process.stderr.write("\r\x1b[K");
    if (!resp.ok) {
      const errBody = await safeJSON(resp);
      console.error(color("red", `error scanning ${domain}: ${resp.status} ${errBody?.error || resp.statusText}`));
      if (errBody?.detail) console.error(color("dim", errBody.detail));
      // Surface the 429 upsell hint if present — tells users how to ask for
      // higher limits via the feedback form. Same demand signal we capture
      // on the homepage.
      if (resp.status === 429 && errBody?.need_more?.feedback_url) {
        console.error(color("dim", `${errBody.need_more.message} → ${errBody.need_more.feedback_url}`));
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
      headers: { "content-type": "application/json", "user-agent": `pqcheck-cli/${VERSION}` },
      body: JSON.stringify({ domain, report, source: "pqcheck-cli", at: new Date().toISOString() }),
    }).catch(() => { /* best-effort — never fail the scan on webhook delivery */ });
  }

  // In --quiet mode the score still goes to stdout (script-pipeable), but a
  // degraded warning lands on stderr so silent fallback to cached data can't
  // mislead a CI gate or one-off check.
  if (quiet && report._meta?.degraded) {
    console.error(`pqcheck: ⚠ ${domain} — using cached score (live probe failed: ${report._meta.degradedReason || "unknown"}; last verified ${report._meta.lastUpdated || "?"})`);
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
          headers: apiHeaders({ "user-agent": `pqcheck-cli/${VERSION} (watch)` }),
        });
        if (!resp.ok) continue;
        const report = await resp.json();
        const prev = previous.get(domain);
        const changed = prev !== undefined && typeof report.score === "number" && report.score !== prev;
        previous.set(domain, report.score);

        if (changed && webhookUrl) {
          fetch(webhookUrl, {
            method: "POST",
            headers: { "content-type": "application/json", "user-agent": `pqcheck-cli/${VERSION}` },
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
  lines.push(`Cipherwake Starter $29/mo · 5 domains · daily scans + email alerts on cert/script/posture changes. Invite your team on Growth ($79/mo) when ready.`);
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
  console.log(color("dim",    `     Cipherwake Starter $29/mo · 5 watched domains · email alerts · cancel anytime`));
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
Add ${color("dim", "QUANTAPACT_API_KEY")} env var for higher rate limits + private results
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
      headers: apiHeaders({ "user-agent": `pqcheck-cli/${VERSION} (lock)` }),
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
    generator: `pqcheck-cli/${VERSION}`,
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
            headers: apiHeaders({ "user-agent": `pqcheck-cli/${VERSION} (deps)` }),
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
      headers: { "User-Agent": `pqcheck-cli/${VERSION} (deps; +https://cipherwake.io)` },
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
      headers: apiHeaders({ "user-agent": `pqcheck-cli/${VERSION} (history)` }),
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
      headers: apiHeaders({ "user-agent": `pqcheck-cli/${VERSION} (changes)` }),
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
// QUANTAPACT_API_KEY env var. Closes the CLI ↔ account loop: developers
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

main().catch((err) => {
  console.error(color("red", `fatal: ${err.message}`));
  process.exit(2);
});
