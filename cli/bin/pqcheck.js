#!/usr/bin/env node
// =============================================================================
// pqcheck CLI — npx pqcheck <domain>
// =============================================================================
// Tiny wrapper around the public scan API at quantapact.com.
// Zero deps (uses node:fetch). Works under `npx pqcheck` without installation.
// =============================================================================

const API_BASE = process.env.PQCHECK_API_BASE || "https://quantapact.com";
const VERSION = "0.7.3";

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

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(args.length === 0 ? 1 : 0);
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
  if (args[0] === "cert") {
    return runCertCommand(args.slice(1));
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

  // One-shot scan(s)
  let worstExit = 0;
  for (const domain of domains) {
    const exit = await runOneScan({ domain, format, quiet, threshold, webhookUrl, multi: domains.length > 1 });
    if (exit > worstExit) worstExit = exit;
  }
  process.exit(worstExit);
}

async function runOneScan({ domain, format, quiet, threshold, webhookUrl, multi }) {
  if (!quiet && format === "text") process.stderr.write(color("dim", `Scanning ${domain} ...`));
  let report;
  try {
    const resp = await fetch(`${API_BASE}/api/scan?domain=${encodeURIComponent(domain)}`, {
      method: "GET",
      headers: { accept: "application/json", "user-agent": `pqcheck-cli/${VERSION}` },
    });
    if (!quiet && format === "text") process.stderr.write("\r\x1b[K");
    if (!resp.ok) {
      const errBody = await safeJSON(resp);
      console.error(color("red", `error scanning ${domain}: ${resp.status} ${errBody?.error || resp.statusText}`));
      if (errBody?.detail) console.error(color("dim", errBody.detail));
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
          headers: { accept: "application/json", "user-agent": `pqcheck-cli/${VERSION}` },
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
          if (changed) {
            console.log(color("yellow", `[${stamp}] ${domain}: ${prev} → ${report.score}  (${report.scoreLabel}) ${color("yellow", "★ changed")}`));
          } else if (!quiet) {
            console.log(color("dim", `[${stamp}] ${domain}: ${report.score}  (${report.scoreLabel})`));
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
  const v = String(s ?? "");
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
  console.log(`  ${color("bold", "PUBLIC SURFACE BLAST RADIUS:")} ${color(labelColor, `${r.score} / 10`)} ${color(labelColor, `(${r.scoreLabel})`)}`);
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

  console.log(color("violet", `  → Full report: ${API_BASE}/?check=${encodeURIComponent(r.domain)}`));
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

function printUsage() {
  console.log(`
${color("bold", "pqcheck")} ${color("dim", `v${VERSION}`)}

Public Surface Blast Radius — quantum-decryption risk for any domain.

${color("bold", "Commands:")}
  npx pqcheck <domain>                          Scan + print human-readable report
  npx pqcheck lock <domain>                     Generate quantapact.lock (QXM) committable manifest
  npx pqcheck deps <domain>                     Scan all third-party origins on the page (supply-chain HNDL)
  npx pqcheck diff <old.lock> <new.lock>        Compare two QXM lockfiles; exit 2 on regression
  npx pqcheck history <domain>                  Show 90-day score history (sparkline + samples)
  npx pqcheck cert <file.pem>                   Analyze a local PEM/CRT cert file (offline, no network)

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

${color("bold", "Subcommand-specific:")}
  pqcheck deps:
    --lock                                       Also write quantapact-deps.lock + .md
    -o <dir>                                     Output directory for --lock files
    --max=<N>                                    Max third parties to scan (default 20)
    --allowlist <file>                           Exit 3 if any third-party not in allowlist (CI gate)
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

${color("bold", "Examples:")}
  npx pqcheck chase.com
  npx pqcheck mybank.com --threshold 7      ${color("dim", "# fail CI if score ≥ 7")}
  npx pqcheck deps stripe.com --lock
  npx pqcheck deps acme.com --allowlist allowed-vendors.txt   ${color("dim", "# CI vendor-risk gate")}
  npx pqcheck diff main.lock pr.lock        ${color("dim", "# regression detection in PR")}
  npx pqcheck history quantapact.com
  npx pqcheck cert ./mycert.pem             ${color("dim", "# offline cert analysis")}
  npx pqcheck --file domains.txt --format json > scans.ndjson
  npx pqcheck mybank.com --format sarif > pqcheck.sarif   ${color("dim", "# upload to Code Scanning")}
  npx pqcheck mybank.com --gh-action        ${color("dim", "# inline PR annotations")}

Backed by the patented Decryption Blast Radius methodology.
${color("violet", "https://quantapact.com")}
`);
}

// =============================================================================
// `pqcheck lock` — QXM (Quantum Exposure Manifest) generator
// =============================================================================
// Generates two files committable to a git repo:
//   quantapact.lock          — stable JSON manifest (machine-readable)
//   quantapact-report.md     — human-readable summary (renders on GitHub)
//
// Like SBOM / package-lock.json / cargo audit / snyk test outputs — devs commit
// these to track quantum exposure as a first-class technical concern.
//
// Usage:
//   npx pqcheck lock <domain>           Write to ./quantapact.lock + .md
//   npx pqcheck lock <domain> -o dir/   Write into a specific directory
//   npx pqcheck lock <domain> --stdout  Print JSON to stdout (no files)
//   npx pqcheck lock                    Read domain from existing
//                                       quantapact.lock if present, else error
// =============================================================================

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

  if (!domain) {
    try {
      const existing = await fs.readFile(path.join(outDir, "quantapact.lock"), "utf8");
      const parsed = JSON.parse(existing);
      domain = parsed.domain;
      if (!stdout) {
        console.error(color("dim", `Re-locking from existing quantapact.lock (domain: ${domain})`));
      }
    } catch {
      console.error(color("red", "error: no domain provided and no existing quantapact.lock found"));
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
      headers: { accept: "application/json", "user-agent": `pqcheck-cli/${VERSION} (lock)` },
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

  // Write both files
  const lockPath = path.join(outDir, "quantapact.lock");
  const mdPath = path.join(outDir, "quantapact-report.md");
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
    schema: "https://quantapact.com/schemas/qxm/v1",
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
      methodology: "https://quantapact.com/methodology",
      shareableReport: `https://quantapact.com/r/${encodeURIComponent(report.domain)}`,
      badge: `https://quantapact.com/badge/${encodeURIComponent(report.domain)}.svg`,
    },
    remediation: {
      tessera: tesseraNeeded ? "join-waitlist" : "not-needed",
      tesseraWaitlist: "https://quantapact.com/feedback?source=qxm-tessera-interest",
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
  lines.push(`> Generated by [pqcheck](https://quantapact.com) at ${m.generatedAt}`);
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
// optional committable lockfile (quantapact-deps.lock).
//
// Parallel to the browser extension's Dependencies tab, exposed as a CLI for
// CI integration: gate PR builds on third-party crypto posture.
//
// Usage:
//   npx pqcheck deps <domain>           Scan + print summary table
//   npx pqcheck deps <domain> --json    JSON output (pipe to jq, etc.)
//   npx pqcheck deps <domain> --lock    Also write quantapact-deps.lock + .md
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

  const positional = args.filter((a) => !a.startsWith("-") && a !== outDir);
  const domain = positional.length > 0 ? normalizeDomain(positional[0]) : null;
  if (!domain || !isValidDomain(domain)) {
    console.error(color("red", "error: pqcheck deps requires a valid domain"));
    console.error(color("dim", "Usage: npx pqcheck deps <domain> [--json|--lock] [-o dir/] [--max=N]"));
    process.exit(1);
  }

  if (!json) process.stderr.write(color("dim", `Fetching ${domain} HTML...`));
  const html = await fetchPageHTML(domain);
  if (!json) process.stderr.write("\r\x1b[K");
  if (!html) {
    console.error(color("red", `error: could not fetch https://${domain}/`));
    process.exit(1);
  }

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
    if (!byHost.has(r.host)) byHost.set(r.host, { host: r.host, types: new Set(), occurrences: 0 });
    const e = byHost.get(r.host);
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
            headers: { accept: "application/json", "user-agent": `pqcheck-cli/${VERSION} (deps)` },
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

  // Build manifest
  const manifest = {
    $schema: "https://quantapact.com/schemas/deps/v1",
    schemaVersion: "1.0",
    domain,
    scannedAt: new Date().toISOString(),
    tool: "pqcheck-cli",
    toolVersion: VERSION,
    summary,
    thirdParties: results.map((r) => ({
      host: r.host,
      types: r.types,
      occurrences: r.occurrences,
      scan: r.scan,
      error: r.error,
    })),
    evidence: {
      methodology: `${API_BASE}/methodology/browser-extension`,
      reportLink: `${API_BASE}/r/${domain}`,
    },
  };

  if (json) {
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }

  // Pretty terminal table
  console.log("");
  console.log(`  ${color("bold", "Supply-chain HNDL exposure")} for ${color("violet", domain)}`);
  console.log(`  ${color("dim", `${summary.uniqueOrigins} unique third-party origins · ${summary.totalReferences} references · weakest: ${summary.weakestLink?.host ?? "—"} (${summary.weakestLink?.grade ?? "—"})`)}`);
  console.log("");
  console.log(`  ${color("dim", "GRADE  HOST                                          PQC  TYPES")}`);
  console.log(`  ${color("dim", "─────  ─────────────────────────────────────────  ───  ─────")}`);
  for (const r of results) {
    const gradeStr = r.scan?.grade ?? "?";
    const gradeColored = gradeStr === "A" ? color("green", gradeStr) : gradeStr === "F" || gradeStr === "D" ? color("red", gradeStr) : color("yellow", gradeStr);
    const host = r.host.length > 41 ? r.host.slice(0, 40) + "…" : r.host.padEnd(41, " ");
    const pqc = r.scan?.hybridPQC ? color("green", "yes") : color("dim", "no ");
    const types = r.types.join(",");
    console.log(`  ${gradeColored.padEnd(8, " ")}  ${host}  ${pqc}  ${color("dim", types)}`);
  }
  console.log("");
  console.log(`  ${color("dim", "Each row scanned via")} ${color("violet", "/api/scan")}${color("dim", " · /methodology/browser-extension explains scoring")}`);
  console.log("");

  if (lock) {
    const lockPath = path.join(outDir, "quantapact-deps.lock");
    const mdPath = path.join(outDir, "quantapact-deps-report.md");
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
      headers: { "User-Agent": `pqcheck-cli/${VERSION} (deps; +https://quantapact.com)` },
    });
    clearTimeout(t);
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  }
}

function extractThirdPartyRefs(html, targetDomain) {
  const out = [];
  // Patterns: <tag ... attr="..."> — non-greedy, single or double quoted
  const patterns = [
    { type: "script", re: /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi },
    { type: "iframe", re: /<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi },
    { type: "link",   re: /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi },
    { type: "img",    re: /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi },
  ];
  const targetRoot = registeredDomain(targetDomain);
  for (const { type, re } of patterns) {
    let m;
    while ((m = re.exec(html)) !== null) {
      try {
        const u = new URL(m[1], `https://${targetDomain}`);
        if (u.protocol !== "http:" && u.protocol !== "https:") continue;
        const host = u.hostname.toLowerCase();
        if (!host || host === targetDomain || registeredDomain(host) === targetRoot) continue;
        out.push({ host, type });
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
          informationUri: "https://quantapact.com",
          rules: findings.map((f, i) => ({
            id: `pqcheck-${i + 1}`,
            name: (f.title || "finding").replace(/[^A-Za-z0-9]/g, "_"),
            shortDescription: { text: f.title || "finding" },
            fullDescription: { text: f.detail || f.title || "finding" },
            defaultConfiguration: { level: sevMap[f.severity] || "note" },
          })),
        },
      },
      results: findings.map((f, i) => ({
        ruleId: `pqcheck-${i + 1}`,
        level: sevMap[f.severity] || "note",
        message: { text: `${f.title || "finding"}${f.detail ? ` — ${f.detail}` : ""}` },
        locations: [{
          physicalLocation: {
            artifactLocation: { uri: `https://${report.domain || ""}` },
          },
        }],
        properties: {
          domain: report.domain,
          score: report.score,
          grade: report.grade,
          severity: f.severity,
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
  // Top-line score/grade as a notice
  console.log(`::notice title=Quantapact: ${report.domain}::Grade ${report.grade || "?"} · score ${report.score ?? "?"} / 10`);
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
      headers: { accept: "application/json", "user-agent": `pqcheck-cli/${VERSION} (history)` },
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
  console.log(`  ${color("bold", "Quantapact lockfile diff")}`);
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
