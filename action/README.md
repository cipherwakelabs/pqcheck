# pqcheck-action

> Cipherwake CI gate for GitHub Actions. Three modes: **scan** (full Decryption Blast Radius scan + threshold gate), **trust-diff** (regression vs baseline + sticky PR comment), and **preview-diff** (preview deployment URL vs production URL — the stickiest dev-workflow mode).

Wraps the [`pqcheck` CLI](https://www.npmjs.com/package/pqcheck) — same scanner that powers [cipherwake.io](https://cipherwake.io).

Current version: **v3.4.0**. See [CHANGELOG.md](./CHANGELOG.md) for release history.

> **What's new in v3.4**: New `mode: preview-diff` compares a preview deployment URL against a production URL inside the PR. Surfaces new third-party scripts, CSP/HSTS/XFO regressions (including obvious CSP weakening like `script-src *` or `'unsafe-inline'` getting added), and DBR score drops. Uses a dedicated SSRF-pinned scan path that keeps preview-URL hostnames out of Cipherwake's moat tables (feature-branch names stay private). Free tier: 100 calls/repo/mo, report-only. Starter+ unlocks real CI fail gating via `fail-on`.

> **v3.1**: Trust Diff mode posts a **sticky PR comment** when `comment-on-pr: true` on `pull_request` events. Comment auto-edits on subsequent pushes (no spam).

## Quick start — Trust Diff PR gate (recommended)

The fastest path. Drop this in `.github/workflows/cipherwake.yml`:

```yaml
name: Cipherwake Trust Diff
on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

permissions:
  contents: read
  pull-requests: write   # required for the sticky PR comment

jobs:
  trust-diff:
    runs-on: ubuntu-latest
    steps:
      - uses: cipherwakelabs/pqcheck@v3
        with:
          mode: trust-diff
          domain: mycompany.com
          baseline: last-week
          fail-on: high
          comment-on-pr: 'true'
          api-key: ${{ secrets.CIPHERWAKE_API_KEY }}
```

Open a PR → Cipherwake comments inline when cert / SPKI / HSTS / CSP / DMARC / vendor scripts drift since your baseline.

**Don't want to copy-paste?** Run [`npx pqcheck init`](https://www.npmjs.com/package/pqcheck) — interactive scaffold for this exact workflow.

Free tier: 100 Trust Diff calls/month per repo via GitHub Actions OIDC — no API key, no repo secret required. For higher limits or off-Actions usage, generate an API key at [cipherwake.io/account#api-keys](https://cipherwake.io/account#api-keys).

## Quick start — Preview Trust Diff (PR-time)

The stickiest mode. Compares your **preview deployment URL** to your **production URL** inside the PR. Catches new third-party scripts, header regressions, score drops before merge.

```yaml
name: Preview Trust Diff
on: pull_request

permissions:
  contents: read
  id-token: write       # Free tier: 100 calls/repo/mo via OIDC, no API key needed
  pull-requests: write  # for the sticky PR comment

jobs:
  preview-diff:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # Use your existing preview-deploy step. Vercel example:
      - id: vercel
        uses: amondnet/vercel-action@v25
        with:
          vercel-token: ${{ secrets.VERCEL_TOKEN }}
          vercel-org-id: ${{ secrets.VERCEL_ORG_ID }}
          vercel-project-id: ${{ secrets.VERCEL_PROJECT_ID }}

      - uses: cipherwakelabs/pqcheck@v3
        with:
          mode: preview-diff
          preview-url: ${{ steps.vercel.outputs.preview-url }}
          production-url: https://mycompany.com
          comment-on-pr: 'true'
          # fail-on: high       # default; pass `none` for report-only
```

What you get on every PR:

```
🟡 Cipherwake Preview Trust Diff — Review recommended

Compared:
- Preview:    https://feature-x-abc123.vercel.app
- Production: https://mycompany.com

Application surface:
- + New third-party script: widget.intercom.io
- - Content-Security-Policy [script-src] added permissive token: 'unsafe-inline'
- ~ DBR: 7.2 → 6.8 (worse by 0.4)

Transport (informational):
- Preview TLS is served by an edge provider (Let's Encrypt).
- Transport posture differs because hosts differ — not a CI-failing condition by default.

Policy: Enforced · max severity high · tier starter
```

**Free tier silently downgrades `fail-on` → report-only** and notes the upgrade hook in the PR comment. Starter $29/mo unlocks real CI fail rules + the approved-vendor allowlist.

**Reduced SSRF-pinned scan path:** preview-diff uses only connect-time IP-pinned probes (TLS handshake + page HTML fetch). It does NOT call the unpinned probes (cipher class / cert chain / CT logs / email security). Trade-off: `preview.score` and `production.score` may be `null` in the response (full DBR needs all components); script/header/transport comparison still works fully. To get a full DBR score, run `npx pqcheck <domain>` separately.

## Quick start — full scan mode

```yaml
- uses: cipherwakelabs/pqcheck@v3
  with:
    domain: mycompany.com
    threshold: '7'
```

If the score meets or exceeds `7`, the step exits `2` and the workflow fails. No API key needed for one-shot scans on public domains (per-IP rate limits apply).

## Inputs

### Common (both modes)

| Input | Required | Default | Description |
|---|---|---|---|
| `mode` | no | `scan` | `scan` (full Decryption Blast Radius + threshold gate), `trust-diff` (regression vs baseline + sticky PR comment), or `preview-diff` (preview-URL vs production-URL diff + sticky PR comment) |
| `domain` | yes for scan/trust-diff | — | Domain to scan (e.g. `example.com`). Not used in `mode: preview-diff` — use `preview-url` + `production-url` instead |
| `api-key` | no | `''` | Cipherwake API key (`qpk_...`). **Optional** for `mode=trust-diff` — if your workflow declares `permissions: id-token: write`, the action falls back to OIDC (Free=100 calls/repo/mo). Required only when running outside Actions, or to bypass per-IP rate limits on `mode=scan`. Pass via secret: `${{ secrets.CIPHERWAKE_API_KEY }}` |
| `comment-on-pr` | no | `false` | Post a sticky PR comment on `pull_request` events. Requires `permissions: pull-requests: write` |
| `github-token` | no | `${{ github.token }}` | Token used to post/edit the PR comment |

### Preview Diff mode (`mode: preview-diff`) — NEW in v3.4

| Input | Required | Default | Description |
|---|---|---|---|
| `preview-url` | yes | — | Full URL of the preview deployment (e.g. `${{ steps.vercel.outputs.preview-url }}`) |
| `production-url` | yes | — | Full URL of the production canonical site (e.g. `https://mycompany.com`) |
| `compare-transport` | no | `false` | Opt TLS / cert / SPKI diffs INTO the CI verdict. Default false because preview URLs typically use edge-host TLS (Vercel/Netlify/Cloudflare) and direct transport comparison is noise. Set true only when both URLs are real production-shaped origins you own |
| `fail-on` | no | `high` | Severity threshold — `any` / `low` / `medium` / `high` / `critical` / `none`. Pass `none` (or `off`) for report-only. Honored on Starter+; Free tier silently downgrades to report-only |

Exit codes: `2` fail (paid + max severity ≥ `fail-on`), `0` pass or warn. Warn results post `::warning::` but keep CI green.

### Trust Diff mode (`mode: trust-diff`)

| Input | Required | Default | Description |
|---|---|---|---|
| `baseline` | no | `last-week` | One of `last-week` / `last-month` / `last-scan` / ISO 8601 timestamp |
| `fail-on` | no | `high` | Severity threshold — `any` / `low` / `medium` / `high` / `critical`. CI exits non-zero when any delta meets or exceeds this severity |
| `output-format` | no | `github` | `pretty` / `json` / `sarif` / `github` (workflow commands) |

### Scan mode (`mode: scan`, the default)

| Input | Required | Default | Description |
|---|---|---|---|
| `threshold` | no | `7` | Fail the step if score ≥ this (0-10) |
| `fail-on-unreachable` | no | `true` | Treat unreachable domains as failures |
| `generate-sarif` | no | `false` | Write SARIF 2.1.0 report; pair with `codeql-action/upload-sarif@v3` |
| `sarif-output-path` | no | `pqcheck-results.sarif` | Where to write the SARIF file |
| `generate-lockfile` | no | `false` | Write `cipherwake.lock` + `.md` for committing or artifact upload (preserves legacy `quantapact.lock` filename if already present) |
| `fresh` | no | `false` | Bypass server cache and force a fresh scan. Use in "deploy then verify" workflows. Subject to 20/hr per-IP cap server-side |
| `supply-chain-baseline` | no | `''` (off) | Path to a committed third-party baseline JSON (e.g. `.pqcheck-baseline.json`). When set, also runs `pqcheck deps --baseline <path>` and fails the build if any new third-party host appears since the baseline — the Polyfill.io-style change gate |
| `supply-chain-fail-on-new` | no | `true` | When `supply-chain-baseline` is set, fail the build (exit `4`) if any new third-party host appeared since the baseline |
| `supply-chain-write-baseline` | no | `false` | When `supply-chain-baseline` is set, overwrite the baseline file with the current scan. Used to capture the initial state or deliberately accept new hosts — do NOT enable on every PR |

## Outputs

| Output       | Description                              |
|--------------|------------------------------------------|
| `score`      | Decryption Blast Radius score (0-10)     |
| `grade`      | Letter grade A-F                         |
| `report-url` | Shareable report URL on `cipherwake.io` |

## Examples

### Block PRs that regress the score

```yaml
name: Quantum-Risk Gate
on: [pull_request]
jobs:
  pqcheck:
    runs-on: ubuntu-latest
    steps:
      - uses: cipherwakelabs/pqcheck/action@main
        with:
          domain: mycompany.com
          threshold: '7'
```

### Surface findings in GitHub Code Scanning (Security tab)

```yaml
- uses: cipherwakelabs/pqcheck/action@main
  with:
    domain: mycompany.com
    generate-sarif: 'true'
- uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: pqcheck-results.sarif
```

Findings appear in the GitHub Security tab as code-scanning alerts, fully integrated with PR review UI.

### Track crypto posture over time as a committed artifact

```yaml
- uses: cipherwakelabs/pqcheck/action@main
  with:
    domain: mycompany.com
    generate-lockfile: 'true'
- uses: actions/upload-artifact@v4
  with:
    name: cipherwake-lock
    path: |
      cipherwake.lock
      cipherwake-report.md
```

Or commit the lockfile to your repo (similar to `package-lock.json`) so PR diffs surface posture changes.

### Use the score in a follow-up step (e.g. PR comment)

```yaml
- uses: cipherwakelabs/pqcheck/action@main
  id: scan
  with:
    domain: mycompany.com
    threshold: '10'      # never fail; we just want the score
- run: |
    echo "Score: ${{ steps.scan.outputs.score }} (${{ steps.scan.outputs.grade }})"
    echo "Report: ${{ steps.scan.outputs.report-url }}"
```

### Scan a matrix of domains

```yaml
strategy:
  matrix:
    domain: [api.mycompany.com, app.mycompany.com, www.mycompany.com]
steps:
  - uses: cipherwakelabs/pqcheck/action@main
    with:
      domain: ${{ matrix.domain }}
      threshold: '7'
```

### Supply-chain change detection (Polyfill.io-style gate)

Commit a baseline once, then every PR fails if a new third-party script appears:

```yaml
# Step 1 — capture initial baseline (run once locally or via an admin workflow)
- uses: cipherwakelabs/pqcheck/action@v2.2.0
  with:
    domain: mycompany.com
    supply-chain-baseline: '.pqcheck-baseline.json'
    supply-chain-write-baseline: 'true'

# Step 2 — commit `.pqcheck-baseline.json`, then on every PR:
- uses: cipherwakelabs/pqcheck/action@v2.2.0
  with:
    domain: mycompany.com
    threshold: '7'
    supply-chain-baseline: '.pqcheck-baseline.json'
    # supply-chain-fail-on-new defaults to true
```

A PR that introduces a new third-party host (analytics, CDN, font service, etc.) will fail with exit `4` and an `::error::` annotation explaining what changed. To accept the addition, re-run with `supply-chain-write-baseline: true` once and commit the updated baseline — the change becomes a reviewable diff in the PR rather than a silent supply-chain expansion.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Pass — score below threshold (scan mode) or no regression (trust-diff mode) |
| 1 | Usage / network / unreachable error. **Note:** Trust Diff "warn" (changes observed below `fail-on` threshold) is translated to exit `0` so CI is not blocked — a `::warning::` annotation is emitted instead |
| 2 | Scan: score met or exceeded threshold. Trust Diff: regression detected at or above `fail-on` |
| 4 | Supply-chain change detected — new third-party host(s) since baseline (`supply-chain-fail-on-new: true`) |

## Runner requirements

- GitHub-hosted Ubuntu / macOS / Windows runners — works out of the box (Node, `jq`, `awk` preinstalled).
- Self-hosted runners must have Node ≥ 18, `jq`, and `awk` available.

## License

MIT. © 2026 Cipherwake.
