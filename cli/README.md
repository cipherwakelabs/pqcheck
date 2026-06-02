# pqcheck

> **Type `npx pqcheck stripe.com`** (or any HTTPS domain) to scan its public posture in seconds — Decryption Blast Radius grade (0–10), letter (A–F), and findings ranked by severity. No signup, no API key, per-IP rate limited.
>
> **Or, for your own deploys:** wire `npx pqcheck deploy-check yourdomain.com --ai` into Claude Code / Cursor / Copilot. Your AI coder parses `ship_decision=pass|review|block` and decides whether to announce the deploy, ask you, or stop.

[![npm version](https://img.shields.io/npm/v/pqcheck.svg?style=flat-square&color=06b6d4)](https://www.npmjs.com/package/pqcheck)
[![npm downloads](https://img.shields.io/npm/dm/pqcheck.svg?style=flat-square&color=06b6d4)](https://www.npmjs.com/package/pqcheck)
[![license](https://img.shields.io/npm/l/pqcheck.svg?style=flat-square&color=06b6d4)](./LICENSE)

> **Latest: v0.16.17** — fail-loud AI guard now covers the no-baseline first-deploy fallback. `pqcheck deploy-check <new-domain> --ai` previously exited 3 with bare `error: /api/scan returned 429` if the very first scan got rate-limited — no `CIPHERWAKE_AI_GUARD_RESULT` block, leaving the calling AI agent with no `ship_decision` to route on. Now every error path in that fallback emits a `ship_decision=review` block with a status-specific `top_issue` code. [Full changelog →](./CHANGELOG.md)

## Two ways to use it

### 1. Scan any domain — no signup, no API key, no per-account quota

```bash
npx pqcheck stripe.com
```

```
◆ Cipherwake · stripe.com  DBR 2.3 B · 1 finding

Top finding:
  [MEDIUM] Intermediate cert uses RSA — quantum-vulnerable chain link

Full report: https://cipherwake.io/r/stripe.com
```

Anonymous. Per-IP rate limited (120 scans/hour) for cost protection — that's it. Use it to spot-check a vendor before signing, audit a competitor's HTTPS posture, or just satisfy "I wonder how `<domain>` grades."

### 2. Gate your own deploys with your AI coder

```bash
npx pqcheck deploy-check yourdomain.com --ai
```

```
◆ Cipherwake · yourdomain.com ⚠ REVIEW · 2 changes since last scan · HIGH

Surface changes:
  + New third-party script: widget.intercom.io
  ~ Strict-Transport-Security weakened: max-age=31536000 → max-age=3600

CIPHERWAKE_AI_GUARD_RESULT
ship_decision=review
top_issue=vendor.new_third_party_script
END_CIPHERWAKE_AI_GUARD_RESULT
```

The last block — `CIPHERWAKE_AI_GUARD_RESULT` — is what your AI coding agent parses. It contains a single field, `ship_decision=pass|review|block`, that tells the agent whether to:

- **pass** — go ahead and announce the deploy is shipped
- **review** — stop and ask you what to do (your HTTPS posture drifted vs. last scan)
- **block** — refuse to announce until you investigate (something critical changed)

Zero install. Works in any terminal with Node 18+. Both modes are free — no signup, no API key required for first use of either.

## What pqcheck actually checks

### Bare scan (`pqcheck <domain>`) — current-state posture grade

Scans any public HTTPS surface and produces a **DBR score** (0–10), a **letter grade** (A–F), and a **findings list** ranked by severity. Same scanner that powers [cipherwake.io](https://cipherwake.io), the browser extension, and the GitHub Action — what it checks:

- **TLS posture** — ciphersuite class, hybrid PQC key agreement (`X25519MLKEM768`), forward secrecy
- **Certificate chain** — issuer, intermediate quality, key reuse across rotations (★ unique to pqcheck), wildcard / subdomain blast radius
- **Security headers** — HSTS (preload + max-age), CSP, X-Frame-Options, Referrer-Policy, Permissions-Policy, COOP, CORP
- **Email security** — SPF, DMARC, DKIM (~30 selectors probed including Resend/Mailgun/SES), BIMI
- **Supply chain** — every third-party script loaded by the page, graded for quantum risk
- **Subdomain takeover** — fingerprint scan against AWS S3, GitHub Pages, Heroku, Shopify, Fastly, etc.

### Deploy gate (`pqcheck deploy-check --ai`) — drift since your last scan

Compares your site's public HTTPS surface *now* against your last scan and surfaces what changed:

- **New third-party scripts** loading on the page that weren't there before (the Polyfill.io-class supply-chain risk)
- **Header regressions** — CSP weakened, HSTS shortened or removed, X-Frame-Options dropped, permissive tokens (`'unsafe-inline'`, `*`) introduced
- **Certificate / SPKI changes** — unexpected rotations, key reuse across renewals, intermediate-chain changes
- **TLS posture changes** — ciphersuite shifts, hybrid PQC key-agreement added or removed
- **Vendor surface changes** — new email senders (SPF/DMARC), new CDN origins, new analytics endpoints
- **Subdomain takeover exposure** — new dangling CNAMEs

The gate routes each change through the same DBR severity model above to decide `pass` / `review` / `block`. Cosmetic drift passes; high-severity drift (new script from an unknown origin, header regression that breaks defense-in-depth, cert SPKI change without a rotation event) triggers `review`; critical drift (expired cert served, takeover-vulnerable subdomain, malicious vendor injected) triggers `block`. DBR's full severity rubric: [/methodology/decryption-blast-radius](https://cipherwake.io/methodology/decryption-blast-radius).

On **first use** with no prior scan to diff against, `deploy-check` falls back to the bare scan's absolute-posture grading to give you a baseline. Every subsequent run is drift-relative to the previous scan.

---

## Commands at a glance

Grouped by intent: **deploy gate** (the flagship wedge) → **drift comparison** (the engine the gate runs on) → **AI setup / install** → **workflow scaffolds** → **committable artifacts** → **posture grade + tracking** → **diagnostic**. Every CLI command is listed here exactly once; flags / output formats / exit codes are in [Flags, formats & exit codes](#flags-formats--exit-codes) further down.

| Command | What it gives you |
|---|---|
| **Deploy gate — the flagship wedge** | |
| `npx pqcheck deploy-check <domain> --ai` | **The flagship.** Scans the domain, compares against the previous scan (first run sets the baseline), and emits a `ship_decision=pass\|review\|block` field your AI coding agent parses to decide whether to announce the deploy, ask you, or stop. Works anonymously — no signup needed. |
| **`npx pqcheck guard --domain <D> -- <cmd>`** | **Deploy guard wrapper.** Wraps any deploy command. Runs `deploy-check` first; conditionally runs `<cmd>` based on `ship_decision`. Modes: `--gate-mode balanced` (default) / `advisory` / `strict`. ONE command instead of two — the strongest single artifact for AI-coder workflows because the AI never has to remember to chain check + deploy. |
| **`--ai` flag** (any of the above) | **AI Coder Mode.** Three-layer output (banner / body / structured `CIPHERWAKE_AI_GUARD_RESULT` block) tuned for Claude Code / Cursor / Aider / Zed. Includes a `ship_decision=pass\|review\|block` field your AI coworker parses to decide whether to announce the deploy, ask you, or revert. See [/methodology/ai-coder-mode](https://cipherwake.io/methodology/ai-coder-mode). |
| **Drift comparison — what the gate runs on** | |
| `npx pqcheck trust-diff <domain>` | Compare today's HTTPS surface against a saved baseline (last week / last month / a saved CI baseline). For CI gates and release checklists. |
| `npx pqcheck preview-diff --preview <URL> --production <URL>` | Compare a Vercel/Netlify preview deployment URL to production. Surfaces new third-party scripts, header regressions, and DBR score drops *inside the PR*, before merge. Renders per-signal N vs N+1 status on every run (scripts, headers, cert SPKI, TLS, …) so you can see *every* check fired, not just "did something change." Add `--verbose` for the full side-by-side table. |
| **AI setup / install** | |
| **`npx pqcheck setup --auto --domain <D>`** | **One-command full setup for every AI coder.** Installs (idempotently): GitHub Action workflow, AI Coder Protocol across all detected rules files (Claude / Cursor / Copilot / Aider / Windsurf / Continue / Cline / AGENTS.md) using fenced markers (`<!-- CIPHERWAKE_AI_CODER_PROTOCOL_START/END -->`), git pre-push hook, Claude Code statusLine + 2 hooks (PostToolUse Bash + **UserPromptSubmit**), per-repo `.cipherwake/last-status.json` for Cursor / Copilot / Continue to read as context. Skip flags available. Backups taken before any `~/.claude/settings.json` write. Audit trail at `~/.config/cipherwake/install-prefs.json`; install manifest at `~/.config/cipherwake/install-manifest.json`. |
| **`npx pqcheck setup --plan --domain <D>`** | **Dry-run mode.** Prints every file change `--auto` would make (target paths + operation type: create / append-markered / deep-merge / backup-first) without writing anything. Run this first when you're not sure what `--auto` will touch. |
| **`npx pqcheck protocol install`** | **Opt-in installer** for the AI Coder Protocol — appends the pre-deploy verification rule to your `CLAUDE.md` / `.cursorrules` / `.aider.conf.yml` with explicit consent (Rule 17). One upfront question (auto / manual / no). Never silent writes. |
| **`UserPromptSubmit` hook** | **Claude sees `ship_decision` before responding to every prompt.** When `pqcheck setup --auto` runs, it wires `cipherwake-prompt-hook` as a Claude Code UserPromptSubmit hook. On every user prompt, the hook injects `additionalContext` with the current scan's `ship_decision` IF it's `review`/`block` and the state is <24h old. Silent when state is missing, stale, or `pass`. Different timing from the PostToolUse chat-hook: this fires *before* Claude thinks (proactive), the chat-hook fires *after* a Bash command (reactive). |
| **Per-repo state file** `.cipherwake/last-status.json` | **Cursor / Copilot / Continue read this for workspace context.** Every `pqcheck` scan writes the same payload as the per-user file. Created by `setup --auto`; auto-added to `.gitignore` (per-developer state, not committable). Gives AI agents inside VS Code-family editors a repo-local artifact they pick up automatically when reading workspace files. |
| **Workflow scaffolds** | |
| `npx pqcheck onboard <domain>` | One command: scan → scaffold the GitHub Action → capture a vendor lockfile → set a baseline → commit + push. Zero copy-paste from docs. |
| `npx pqcheck init` | Interactive scaffold for `.github/workflows/cipherwake.yml`. Use when you want manual control instead of `onboard`'s all-in-one flow. |
| `npx pqcheck release-checklist [domain]` | Pre-release trust checklist (markdown, offline). Paste into release notes. |
| `npx pqcheck vendors export/check/sync <domain>` | Vendor lockfile (`cipherwake.vendors.json`) + CI gate that exits non-zero when a new third-party origin appears. Like `package-lock.json` for vendor scripts. |
| **Committable artifacts (SBOM-style)** | |
| `npx pqcheck lock <domain>` | Generate `cipherwake.lock` (QXM committable manifest) + human-readable `cipherwake-report.md`. SBOM-style artifact for quantum exposure — commit both, diff in PRs. |
| `npx pqcheck diff <old.lock> <new.lock>` | Compare two QXM lockfiles; exit 2 on regression. For CI PR-comment diffs. |
| `npx pqcheck deps <domain>` | Scan all third-party origins on the page (supply-chain HNDL grading). `--lock` writes `cipherwake-deps.lock` + `.md`; `--allowlist`, `--baseline`, `--fail-on-new` for CI vendor gates. |
| `npx pqcheck cert <file.pem>` | Analyze a local PEM/CRT cert file offline (no network). |
| **Posture grade + tracking** | |
| `npx pqcheck <domain>` | **Posture grade (no diff baseline).** Returns DBR score (0–10), letter grade (A–F), and a list of findings ranked by severity. Use when you want a one-shot health check without setting up a baseline — for first-time audits, ad-hoc spot checks, or grading a domain you don't own. For ongoing deploys, use `deploy-check` instead. |
| `npx pqcheck history <domain>` | 90-day score history (sparkline + samples). `--days <N>` to change window. |
| `npx pqcheck changes <domain>` | Summarize public attack-surface changes in last 14 days. |
| `npx pqcheck watch <domain>` | Add domain to your watched list on the server (needs `CIPHERWAKE_API_KEY`). Distinct from the `--watch <secs>` flag, which is local polling. |
| **Diagnostic** | |
| **`npx pqcheck debug-network`** | **Connectivity diagnostic.** Probes cipherwake.io API, homepage, crt.sh upstream, and the direct Vercel URL (bypassing Cloudflare). Reports HTTP status + timing per hop. Use when "scan hung" / "command not found" / corporate proxy issues come up — surfaces the actual broken hop with an actionable cause list. |

Free tier covers all of the above within 100 Trust Diff calls/month per repo via OIDC. **Founder Pro** ($19.99/mo, locked while subscription active) raises that to 5,000 calls/month + unlocks custom thresholds, vendor lockfile, CI fail rules, and 5 watched domains. Single-domain scans (`npx pqcheck <domain>`) are anonymous + rate-limited per IP — no account or key needed. `npx pqcheck deploy-check <domain> --ai` also works fully anonymously for first-deploy gating.

### AI Coder Mode in 30 seconds

```bash
npx pqcheck deploy-check cipherwake.io --ai
```

Output:

```
◆ Cipherwake · cipherwake.io ⚠ REVIEW · 1 change since last scan · HIGH

Surface changes:
  + New third-party script: widget.intercom.io
    Loaded from an origin not present in your last scan.

Why it matters:
  New third-party scripts execute in full page context. A script that
  appeared without an intentional code change = supply-chain risk vector
  (Polyfill.io-class). Confirm it was added on purpose.

Recommended next action:
  Review the change above and decide if it was intentional.
  View full report: https://cipherwake.io/r/cipherwake.io
  Re-scan after fix: npx pqcheck deploy-check cipherwake.io --ai

CIPHERWAKE_AI_GUARD_RESULT
status=review
domain=cipherwake.io
ship_decision=review
max_severity=high
top_issue=vendor.new_third_party_script
advisory_only=true
END_CIPHERWAKE_AI_GUARD_RESULT
```

The structured block is what your AI coworker (Claude / Cursor / Aider / Zed) parses to decide whether to announce the deploy, ask you, or revert. Exit code in `--ai` mode reflects `ship_decision`: `0` pass · `1` review · `2` block.

---

## Get started in 60 seconds

Wire Cipherwake into your CI so every PR gets a Trust Diff comment when your domain's public trust posture changes.

**One command does almost everything:**

```bash
npx pqcheck onboard cipherwake.io
```

That runs in sequence: scan your domain → write the GitHub Action workflow → capture a vendor lockfile → generate a release checklist → commit + push. **No API key, no repo secret.** The scaffolded workflow uses GitHub Actions OIDC (`id-token: write`) to authenticate to Cipherwake — Free includes 100 Trust Diff calls/month per repo, no setup required.

**Or step-by-step if you prefer:**

```bash
# 1. Scaffold a GitHub Actions workflow (interactive prompts)
npx pqcheck init

# 2. Commit + push
git add .github/workflows/cipherwake.yml
git commit -m "ci: add Cipherwake Trust Diff gate"
git push
```

That's it. The scaffolded workflow includes `permissions: id-token: write`, so the runner mints a signed OIDC token on each run and Cipherwake meters per repo — no secret to manage. Open a PR and Cipherwake comments inline when cert / SPKI / HSTS / CSP / DMARC / vendor scripts drift since your baseline.

**Need higher limits?** **Founder Pro ($19.99/mo)** lifts the per-repo quota to 5,000 calls/month and unlocks custom thresholds, the approved-vendor allowlist, vendor lockfile, CI fail rules, and 5 watched domains. Generate an API key at [/account#api-keys](https://cipherwake.io/account#api-keys), then add it as the repo secret `CIPHERWAKE_API_KEY`. The Action uses the secret when present and falls back to OIDC when not — no code change needed to upgrade. *Founder pricing is locked while your subscription remains active.*

**Want more?**
- Pre-commit hook: `npx pqcheck deploy-check <domain>` before every deploy
- Release ritual: `npx pqcheck release-checklist <domain>` for your release notes
- Vendor lockfile: `npx pqcheck vendors export <domain>` to commit `cipherwake.vendors.json` and fail PRs introducing new third-party scripts

---

## Features

For the per-release version history see [CHANGELOG.md](./CHANGELOG.md).

### Trust Diff — CI gate for posture regressions

```bash
npx pqcheck trust-diff mycompany.com --baseline last-week --fail-on high
```

Compares today's public trust posture against a configured baseline (`last-week`, `last-month`, or a saved per-branch baseline). Surfaces cert / SPKI / HSTS / CSP / DMARC / vendor-script drift since the baseline and gates the PR by severity. SARIF output uploads to GitHub Code Scanning. Pair with the [GitHub Action](https://github.com/cipherwakelabs/pqcheck/tree/main/action) `mode: trust-diff` for one-line CI integration.

Exit codes: `0` pass · `1` warn · `2` fail · `3` error. Free tier (100 calls/repo/mo via GitHub Actions OIDC, no API key required) silently downgrades fail → report; **Founder Pro** honors `--fail-on` for real CI gating.

### Preview Trust Diff — PR-time URL-vs-URL comparison

```bash
npx pqcheck preview-diff \
  --preview https://feature-x-abc123.vercel.app \
  --production https://example.com
```

Compares a preview-deployment URL to a production URL and surfaces application-surface changes (new third-party scripts, header regressions, DBR score drops) *inside the PR review, before merge*. SSRF-pinned scan path keeps preview-URL hostnames out of Cipherwake's moat tables — feature-branch names stay private.

Sample output:

```
  Cipherwake Preview Trust Diff
  preview=https://feature-x-abc123.vercel.app
  production=https://example.com

  Application surface:
    + New third-party script: widget.intercom.io
    - Content-Security-Policy [script-src] added permissive token(s): 'unsafe-inline'
    ~ Strict-Transport-Security weakened: max-age=31536000 → max-age=3600

  Transport: preview is edge-hosted (Let's Encrypt) — informational only.

  Verdict: WARN (max severity: high)
  Tier: free · policy: report
```

Flags: `--preview <URL>` · `--production <URL>` · `--compare-transport` · `--fail-on <severity>` (default `high`; `none` for report-only) · `--format pretty|json` · `--protected-path <PATH>` (repeatable) · `--first-party-host <HOSTNAME>` (repeatable). CSP weakening detection diffs `script-src` / `default-src` / `object-src` / `frame-ancestors` / `base-uri` / `style-src` for newly-permissive tokens (`*`, `'unsafe-inline'`, `'unsafe-eval'`, `data:`, `blob:`).

**First-party hosts.** Subdomains of the scanned hostname are auto-promoted to first-party (PSL-backed: scanning `acme.com` makes `api.acme.com` first-party, but `acme.co.uk` does NOT auto-promote `evil.co.uk`). If your owned hosts span different registrable domains (`acme.com` + `acmecdn.net`), add them via `--first-party-host` or persist in `.cipherwake/config.json`:

```json
{
  "firstPartyHosts": ["acmecdn.net", "static.acme.io"],
  "protectedPaths": ["/api/admin/export", "/internal/billing"]
}
```

**Diffing a local dev build against prod?** Cipherwake runs the comparison server-side, so `--preview http://localhost:3000` is rejected (we'd be reaching for *our* loopback, not yours). Expose your dev build via a public tunnel:

```bash
# Vercel/Netlify preview deploys — automatic per PR, free, the design target
--preview https://feature-x-abc123.vercel.app

# ngrok — ad-hoc, one command
ngrok http 3000
--preview https://9b1f-203-0-113-7.ngrok-free.app

# Cloudflare Tunnel — zero-auth quick tunnel
cloudflared tunnel --url http://localhost:3000
--preview https://random-words-1234.trycloudflare.com
```

### Vendor lockfile — `cipherwake.vendors.json`

Like `package-lock.json`, but for the third-party scripts that load on your domain. Capture currently observed vendor origins, commit the lockfile, and CI fails when a PR introduces a new vendor.

```bash
npx pqcheck vendors export mycompany.com    # write cipherwake.vendors.json
npx pqcheck vendors check mycompany.com     # CI gate; exit 4 on new origins
npx pqcheck vendors sync mycompany.com      # Founder Pro — pull dashboard allowlist
```

`pqcheck deps` also surfaces a one-line site-wide **CSP verdict** above the supply-chain table (`✗ No CSP enforcement` / `⚠ CSP is permissive` / `✓ Strict CSP enforced`) and friendly vendor labels (`New Relic · errors` / `Cloudflare · cdn` / `Adobe Fonts · fonts`) instead of raw hostnames. Same data shape ships on `/r/<domain>` and in the browser extension.

> **GitHub Action note:** when scaffolded via `pqcheck onboard` or `pqcheck init`, the Action posts a **sticky PR comment** with results when `comment-on-pr: true` is set on `pull_request` events. The comment auto-edits on subsequent pushes — no spam.

---

## How DBR scoring works

`pqcheck` scans any HTTPS domain and computes its **Decryption Blast Radius score** — the first continuous metric for harvest-now-decrypt-later (HNDL) risk. Every other TLS scanner answers "is post-quantum cryptography enabled?" with yes/no. `pqcheck` answers the question that actually matters: *if an adversary harvests this traffic today and decrypts it in 2035, how much past + future data unlocks?*

The score combines (Quantum / cert findings — our differentiator):
- **Public-key reuse across rotations** — detects when the same private key has been live across multiple cert renewals (often 4+ years at large enterprises). **★ Unique to pqcheck — no other ASM/TLS scanner surfaces this.**
- **Cipher-class probing** — does the server accept RSA fallback even if it prefers ECDHE?
- **Certificate chain analysis** — including the intermediate cert (the chain's actual quantum failure point)
- **Subject scale** — wildcard certs and subdomain count multiplying the blast radius
- **Hybrid PQC TLS detection** — credits servers using `X25519MLKEM768` with a methodology-aware discount

Plus a full ASM check suite for credibility:
- **Email security** — SPF, DMARC, DKIM (~30 selectors probed including Resend/Mailgun/SES/etc.), BIMI
- **HTTP header security** — HSTS (with preload + max-age), CSP, X-Frame-Options, Referrer-Policy, Permissions-Policy, COOP, CORP
- **Subdomain takeover detection** — fingerprint-based scan against AWS S3, GitHub Pages, Heroku, Shopify, Fastly, etc.

## Flags, formats & exit codes

Every CLI command is documented in [Commands at a glance](#commands-at-a-glance) above. What follows is reference material for usage patterns, flags, output formats, and exit codes shared across commands.

### Multi-domain

```
npx pqcheck a.com b.com c.com                 Multi-domain scan (positional)
npx pqcheck --file domains.txt                Bulk scan from a newline-separated file (# comments allowed)
```

### Output formats

| Format | Use case |
|---|---|
| `--format text` *(default)* | Human-readable terminal output |
| `--format json` (or `--json`) | Raw JSON for piping; NDJSON for multi-domain |
| `--format markdown` | GitHub-issue / Slack-ready Markdown |
| `--format csv` | Spreadsheet-friendly CSV row |
| `--format sarif` | SARIF 2.1.0 for upload to GitHub Code Scanning |
| `--gh-action` | GitHub Actions `::notice/::warning/::error` annotations |

### Common flags

| Flag | Purpose |
|---|---|
| `-h`, `--help` | Show help |
| `-v`, `--version` | Show version |
| `--threshold <0-10>` | Exit 2 if score meets or exceeds this (CI gate) |
| `-q`, `--quiet` | Print only the numeric score |
| `--watch [seconds]` | Poll every N seconds (default 300) and report changes |
| `--webhook <url>` | POST scan results to a URL (one-shot or each watch tick) |

### Subcommand-specific flags

**`pqcheck deps`:**
- `--lock` — Also write `cipherwake-deps.lock` + `.md`
- `-o <dir>` — Output directory for `--lock` files
- `--max=<N>` — Max third parties to scan (default 20)
- `--allowlist <file>` — Exit **3** if any third-party not in allowlist (CI vendor-risk gate)
- `--baseline <file>` — Compare current hosts to baseline JSON; flag `*NEW*` and surface `isNew` in JSON output
- `--write-baseline` — Overwrite `--baseline` file with current scan (use once to capture initial state)
- `--fail-on-new` — Exit **4** if any new hosts appeared since baseline (CI supply-chain change gate)

**`pqcheck lock`:**
- `-o <dir>` — Output directory
- `--stdout` — Print JSON to stdout instead of writing files

**`pqcheck history`:**
- `--days <N>` — History window (default 90)
- `--json` — Raw JSON output

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Usage / network / scan error |
| `2` | Score met or exceeded `--threshold`, or `diff` detected regression |
| `3` | Allowlist violation (`pqcheck deps --allowlist`) |
| `4` | Supply-chain change detected — new host(s) since baseline (`pqcheck deps --fail-on-new`) |

## Examples

```bash
# Quick scan
npx pqcheck stripe.com

# CI gate — fail if score >= 7
npx pqcheck mybank.com --threshold 7

# Generate committable QXM lockfile (like SBOM, but for quantum exposure)
npx pqcheck lock mycompany.com

# Track posture changes in PRs by diffing lockfiles
npx pqcheck diff main.lock pr.lock

# Supply-chain HNDL — scan all third-party scripts/iframes on a page
npx pqcheck deps mycompany.com --lock

# Vendor-risk CI gate — fail PR if any third-party not in allowlist
npx pqcheck deps mycompany.com --allowlist allowed-vendors.txt

# Capture initial supply-chain baseline (run once, commit the JSON file)
npx pqcheck deps mycompany.com --baseline .pqcheck-baseline.json --write-baseline

# Supply-chain change gate — fail PR if any new third-party script appeared since baseline
npx pqcheck deps mycompany.com --baseline .pqcheck-baseline.json --fail-on-new

# Score history sparkline
npx pqcheck history mycompany.com

# Offline cert analysis (no network)
npx pqcheck cert ./mycert.pem

# Bulk scan from list, NDJSON output
npx pqcheck --file domains.txt --format json > scans.ndjson

# Upload findings to GitHub Code Scanning
npx pqcheck mybank.com --format sarif > pqcheck.sarif

# GitHub Actions inline PR annotations
npx pqcheck mybank.com --gh-action

# Watch mode — poll, alert via webhook on change
npx pqcheck mybank.com --watch 600 --webhook https://hooks.slack.com/...
```

### QXM — Quantum Exposure Manifest

Like SBOM, `package-lock.json`, or `cargo audit` outputs — track quantum exposure as a versioned artifact in your repo. Diffs surface real changes in pull requests.

```bash
npx pqcheck lock yourcompany.com
# Writes:
#   cipherwake.lock          — stable JSON manifest
#   cipherwake-report.md     — human-readable summary (renders on GitHub)
```

Commit both files. Use `npx pqcheck diff old.lock new.lock` in CI to surface regressions in PR comments.

> **Filename history.** This tool was previously named Quantapact and earlier versions wrote `quantapact.lock` + `quantapact-report.md`. Both names work forever — `pqcheck lock` auto-detects an existing legacy lockfile and overwrites it in place rather than silently creating a second file in your repo. New repos get the new `cipherwake.lock` default. No migration required.

Schema documented at [cipherwake.io/schemas/qxm/v1](https://cipherwake.io/methodology/qxm).

### Supply-chain dependency scanning

```bash
npx pqcheck deps stripe.com
# Output: every third-party origin on stripe.com (analytics, CDN, fonts, etc.) graded for quantum risk
```

Add `--lock` to write `cipherwake-deps.lock` + `.md` for committing or PR comparison. Add `--allowlist file.txt` to gate CI on vendor approval.

## Companion surfaces

This CLI is one of four ways to consume the [Decryption Blast Radius API](https://cipherwake.io/api):

| Surface | Where |
|---|---|
| **CLI** (this package) | `npx pqcheck` |
| **Browser extension** | [Chrome Web Store](https://chromewebstore.google.com/) — toolbar badge per tab + dependency analysis. Runs on any Chromium-based browser (Edge, Brave, Arc) via sideload. |
| **GitHub Action** | [`cipherwakelabs/pqcheck/action@main`](https://github.com/cipherwakelabs/pqcheck/tree/main/action) — PR comments, SARIF upload, lockfile generation |
| **Web** | [cipherwake.io](https://cipherwake.io) — share-friendly URLs at `/r/<domain>` |

## Public API

`pqcheck` is a wrapper around the public Cipherwake API. You can also call the API directly:

```bash
curl -s "https://www.cipherwake.io/api/scan?domain=stripe.com" | jq '.grade, .score'
```

Full API reference at [cipherwake.io/api](https://cipherwake.io/api).

**Rate limits:** 120 scans per hour per IP for anonymous CLI use, 20 `--fresh` (force-refresh) scans per hour per IP. **Authenticated paths bypass this:** GitHub Actions OIDC (Free = 100 calls/month per repo) and API key (Founder Pro = 5,000/month per account) each have their own per-account / per-repo quota with no per-IP cap. No API key required for the anonymous path. Returns HTTP 429 if exceeded — back off and retry, or [let us know via the feedback form](https://cipherwake.io/feedback) if you need higher limits.

## Methodology

Decryption Blast Radius scoring methodology is fully open. Component weights, PQC discount math, the "what we DON'T claim" sections, edge cases — all documented:

- [Decryption Blast Radius](https://cipherwake.io/methodology/decryption-blast-radius) — core methodology
- [Score components](https://cipherwake.io/methodology/score-components) — the 4-bar weighted breakdown + PQC discount
- [QXM lockfile schema](https://cipherwake.io/methodology/qxm) — committable manifest format
- [Browser extension methodology](https://cipherwake.io/methodology/browser-extension) — supply-chain HNDL detection logic
- [Methodology library](https://cipherwake.io/methodology) — full index

## Versioning + stability

We don't break the API contract. New fields are added; old fields are preserved. If we ever need a breaking change, it ships at `/api/v2/scan` with a deprecation timeline.

The CLI follows the same policy — output formats are stable across minor versions.

## Privacy

`pqcheck` sends the domain you scan to `cipherwake.io/api/scan` (so the TLS handshake can be performed from the public internet). No other data is sent — no email, no client-side identifier. The server logs anonymized analytics: domain, hashed IP (for rate limiting), user-agent. We don't track individual users across scans. See [cipherwake.io/privacy](https://cipherwake.io/privacy).

## CI integration

```yaml
# .github/workflows/quantum-risk-gate.yml
- name: Cipherwake public-surface gate
  run: npx pqcheck@latest mycompany.com --threshold 7
```

For richer integration (sticky PR comments, SARIF upload to Code Scanning, lockfile diff on regression), use the [GitHub Action](https://github.com/cipherwakelabs/pqcheck/tree/main/action):

```yaml
- uses: cipherwakelabs/pqcheck/action@main
  with:
    domain: mycompany.com
    threshold: '7'
    comment-on-pr: 'true'
    generate-sarif: 'true'
- uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: pqcheck-results.sarif
```

## Disclaimer

`pqcheck` measures only the **public** surface of a domain — what's observable from the open internet. Internal Blast Radius (east-west traffic, internal databases, VPN tunnels, backup pipelines) is typically 12–40× the public score depending on sector. A passing public-surface grade does **not** mean low internal exposure.

## License

MIT. © 2026 Cipherwake.

---

**Source:** [github.com/cipherwakelabs/pqcheck](https://github.com/cipherwakelabs/pqcheck)

**Changelog:** [CHANGELOG.md](./CHANGELOG.md) for version-by-version release notes.

**Issues / feedback:** [cipherwake.io/feedback](https://cipherwake.io/feedback) or open an issue on the repo.
