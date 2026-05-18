# pqcheck

> **Decryption Blast Radius scanner** — find out how much of your data unlocks when quantum decryption arrives.

```bash
npx pqcheck stripe.com
```

Zero install. Works in any terminal with Node 18+. Free, no signup, no API key.

The same scanner that powers [cipherwake.io](https://cipherwake.io), the browser extension, and the GitHub Action.

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

**Need higher limits?** Paid tiers (Starter $29/mo · Growth $79/mo · Scale $199/mo) lift the per-repo quota to 1,000 / 10,000 / 50,000 calls/month. Generate an API key at [/account#api-keys](https://cipherwake.io/account#api-keys), then add it as the repo secret `CIPHERWAKE_API_KEY`. The Action uses the secret when present and falls back to OIDC when not — no code change needed to upgrade.

**Want more?**
- Pre-commit hook: `npx pqcheck deploy-check <domain>` before every deploy
- Release ritual: `npx pqcheck release-checklist <domain>` for your release notes
- Vendor lockfile: `npx pqcheck vendors export <domain>` to commit `cipherwake.vendors.json` and fail PRs introducing new third-party scripts

---

## What's new in 0.12.0

**Developer habit-loop bundle (locked 2026-05-16).** Five new subcommands that put Cipherwake where developers already work: PRs, CI, release notes, vendor allowlists. Free tier covers all of them within the 100 Trust Diff calls/month per repo quota.

- `pqcheck init` — interactive scaffold for `.github/workflows/cipherwake.yml`. Prompts for domain, fail-on severity, baseline. No copy-paste from docs required.
- `pqcheck deploy-check <domain>` — pre-deploy Trust Diff gate with deploy-friendly framing. Uses last-scan as default baseline. Same exit semantics as `trust-diff`.
- `pqcheck release-checklist [domain]` — markdown checklist for release notes. Offline, no API call.
- `pqcheck vendors export <domain>` — write `cipherwake.vendors.json` from currently observed third-party origins. Like `package-lock.json` for vendor scripts.
- `pqcheck vendors check <domain>` — CI gate; exits **4** when new origins appear that aren't in the lockfile.
- `pqcheck vendors sync <domain>` — Starter+ only; pulls your dashboard-managed approved-vendor allowlist into the lockfile.

Plus: the GitHub Action v3.1 now posts a **sticky PR comment** with Trust Diff results when `comment-on-pr: true` is set, and `/r/<domain>` has a "Copy as GitHub issue" button on every finding.

## What's new in 0.11.0

**Trust Diff subcommand** — `npx pqcheck trust-diff <domain>` calls `/api/trust-diff` and gates CI on regression severity vs a configured baseline. SARIF output uploads to GitHub's Code Scanning. Pair with `cipherwakelabs/pqcheck@v3` action `mode: trust-diff` for one-line CI integration.

## What's new in 0.7.9

**CSP verdict + vendor labels on `pqcheck deps`.** The supply-chain table now shows a friendly vendor label (`New Relic · errors` / `Cloudflare · cdn` / `Adobe Fonts · fonts`) per host instead of raw `bam.nr-data.net`-style hostnames, plus a one-line site-wide CSP verdict above the table (`✗ No CSP enforcement` / `⚠ CSP is permissive` / `✓ Strict CSP enforced`). Same data shape ships on `/r/<domain>` and in the browser extension — cross-surface parity for the supply-chain story. See [CHANGELOG.md](./CHANGELOG.md).

## What's new in 0.7.8

**Supply-chain change detection in CI** — `pqcheck deps <domain> --baseline file.json` compares the current third-party host list to a stored baseline. New hosts since the last accepted state are flagged `*NEW*` in the pretty table and `"isNew": true` in JSON. Add `--fail-on-new` to exit `4` if anything new appeared — the Polyfill.io-style CI gate that fails PRs introducing third-party scripts until you deliberately accept them with `--write-baseline`. Each row also shows an `SRI` column (on/off/n/a) so you can see which scripts allow silent vendor-side content swaps. See [CHANGELOG.md](./CHANGELOG.md).

---

## What it does

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

## Commands

```
npx pqcheck <domain>                          Scan + print human-readable report
npx pqcheck lock <domain>                     Generate cipherwake.lock (QXM) committable manifest
npx pqcheck deps <domain>                     Scan all third-party origins on the page (supply-chain HNDL)
npx pqcheck diff <old.lock> <new.lock>        Compare two QXM lockfiles; exit 2 on regression
npx pqcheck history <domain>                  Show 90-day score history (sparkline + samples)
npx pqcheck changes <domain>                  Summarize public attack-surface changes in last 14 days
npx pqcheck cert <file.pem>                   Analyze a local PEM/CRT cert file (offline, no network)
npx pqcheck trust-diff <domain>               Trust Diff vs configured baseline; CI gate (Free: 30/mo)
npx pqcheck deploy-check <domain>             Pre-deploy gate (Trust Diff alias with last-scan baseline)
npx pqcheck onboard <domain>                  One-command setup wizard (scan + init + vendors + checklist)
npx pqcheck init                              Interactive scaffold for .github/workflows/cipherwake.yml
npx pqcheck release-checklist [domain]        Pre-release trust checklist (markdown, offline)
npx pqcheck vendors export <domain>           Write cipherwake.vendors.json from observed third-party scripts
npx pqcheck vendors check <domain>            CI gate; exit 4 on new origins not in lockfile
npx pqcheck vendors sync <domain>             Pull dashboard allowlist into lockfile (Starter+, needs API key)
npx pqcheck watch <domain>                    Add domain to your watched list (needs CIPHERWAKE_API_KEY)
```

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
| **Browser extension** | Chrome Web Store / Firefox AMO / Edge — toolbar badge per tab + dependency analysis |
| **GitHub Action** | [`cipherwakelabs/pqcheck/action@main`](https://github.com/cipherwakelabs/pqcheck/tree/main/action) — PR comments, SARIF upload, lockfile generation |
| **Slack `/pqcheck`** | [Install on workspace](https://cipherwake.io/install-slack) |
| **Web** | [cipherwake.io](https://cipherwake.io) — share-friendly URLs at `/r/<domain>` |

## Public API

`pqcheck` is a wrapper around the public Cipherwake API. You can also call the API directly:

```bash
curl -s "https://www.cipherwake.io/api/scan?domain=stripe.com" | jq '.grade, .score'
```

Full API reference at [cipherwake.io/api](https://cipherwake.io/api).

**Rate limits:** 300 scans per hour per IP, 20 `--fresh` (force-refresh) scans per hour per IP. No API key required. Returns HTTP 429 if exceeded — back off and retry, or [let us know via the feedback form](https://cipherwake.io/feedback) if you need higher limits (we're prioritizing the API tier based on real demand).

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
