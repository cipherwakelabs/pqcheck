# pqcheck

> **Decryption Blast Radius scanner** — find out how much of your data unlocks when quantum decryption arrives.

```bash
npx pqcheck stripe.com
```

Zero install. Works in any terminal with Node 18+. Free, no signup, no API key.

The same scanner that powers [quantapact.com](https://quantapact.com), the browser extension, and the GitHub Action.

---

## What's new in 0.7.6

User-Agent now consistently tags the subcommand on every request (`pqcheck-cli/0.7.6 (scan)`, `(lock)`, `(deps)`, `(history)`, `(watch)`). Lets the server aggregate adoption by subcommand. No new data collected — the subcommand token rides inside the User-Agent header that has always been logged anonymously. See [privacy](https://quantapact.com/privacy) and [CHANGELOG.md](./CHANGELOG.md).

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
npx pqcheck lock <domain>                     Generate quantapact.lock (QXM) committable manifest
npx pqcheck deps <domain>                     Scan all third-party origins on the page (supply-chain HNDL)
npx pqcheck diff <old.lock> <new.lock>        Compare two QXM lockfiles; exit 2 on regression
npx pqcheck history <domain>                  Show 90-day score history (sparkline + samples)
npx pqcheck cert <file.pem>                   Analyze a local PEM/CRT cert file (offline, no network)
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
- `--lock` — Also write `quantapact-deps.lock` + `.md`
- `-o <dir>` — Output directory for `--lock` files
- `--max=<N>` — Max third parties to scan (default 20)
- `--allowlist <file>` — Exit **3** if any third-party not in allowlist (CI vendor-risk gate)

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
#   quantapact.lock          — stable JSON manifest
#   quantapact-report.md     — human-readable summary (renders on GitHub)
```

Commit both files. Use `npx pqcheck diff old.lock new.lock` in CI to surface regressions in PR comments.

Schema documented at [quantapact.com/schemas/qxm/v1](https://quantapact.com/methodology/qxm).

### Supply-chain dependency scanning

```bash
npx pqcheck deps stripe.com
# Output: every third-party origin on stripe.com (analytics, CDN, fonts, etc.) graded for quantum risk
```

Add `--lock` to write `quantapact-deps.lock` + `.md` for committing or PR comparison. Add `--allowlist file.txt` to gate CI on vendor approval.

## Companion surfaces

This CLI is one of four ways to consume the [Decryption Blast Radius API](https://quantapact.com/api):

| Surface | Where |
|---|---|
| **CLI** (this package) | `npx pqcheck` |
| **Browser extension** | Chrome Web Store / Firefox AMO / Edge — toolbar badge per tab + dependency analysis |
| **GitHub Action** | [`quantapact/pqcheck/action@main`](https://github.com/quantapact/pqcheck/tree/main/action) — PR comments, SARIF upload, lockfile generation |
| **Slack `/pqcheck`** | [Install on workspace](https://quantapact.com/install-slack) |
| **Web** | [quantapact.com](https://quantapact.com) — share-friendly URLs at `/r/<domain>` |

## Public API

`pqcheck` is a wrapper around the public Quantapact API. You can also call the API directly:

```bash
curl -s "https://www.quantapact.com/api/scan?domain=stripe.com" | jq '.grade, .score'
```

Full API reference at [quantapact.com/api](https://quantapact.com/api).

**Rate limit:** ~60 requests/minute per IP. No API key required. Returns HTTP 429 if exceeded — back off and retry.

## Methodology

Decryption Blast Radius scoring methodology is fully open. Component weights, PQC discount math, the "what we DON'T claim" sections, edge cases — all documented:

- [Decryption Blast Radius](https://quantapact.com/methodology/decryption-blast-radius) — core methodology
- [Score components](https://quantapact.com/methodology/score-components) — the 4-bar weighted breakdown + PQC discount
- [QXM lockfile schema](https://quantapact.com/methodology/qxm) — committable manifest format
- [Browser extension methodology](https://quantapact.com/methodology/browser-extension) — supply-chain HNDL detection logic
- [Methodology library](https://quantapact.com/methodology) — full index

## Versioning + stability

We don't break the API contract. New fields are added; old fields are preserved. If we ever need a breaking change, it ships at `/api/v2/scan` with a deprecation timeline.

The CLI follows the same policy — output formats are stable across minor versions.

## Privacy

`pqcheck` sends the domain you scan to `quantapact.com/api/scan` (so the TLS handshake can be performed from the public internet). No other data is sent — no email, no client-side identifier. The server logs anonymized analytics: domain, hashed IP (for rate limiting), user-agent. We don't track individual users across scans. See [quantapact.com/privacy](https://quantapact.com/privacy).

## CI integration

```yaml
# .github/workflows/quantum-risk-gate.yml
- name: Quantapact public-surface gate
  run: npx pqcheck@latest mycompany.com --threshold 7
```

For richer integration (sticky PR comments, SARIF upload to Code Scanning, lockfile diff on regression), use the [GitHub Action](https://github.com/quantapact/pqcheck/tree/main/action):

```yaml
- uses: quantapact/pqcheck/action@main
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

MIT. © 2026 Quantapact.

---

**Source:** [github.com/quantapact/pqcheck](https://github.com/quantapact/pqcheck)

**Changelog:** [CHANGELOG.md](./CHANGELOG.md) for version-by-version release notes.

**Issues / feedback:** [quantapact.com/feedback](https://quantapact.com/feedback) or open an issue on the repo.
