# pqcheck-action

> Cipherwake CI gate for GitHub Actions. Two modes: **scan** (full Decryption Blast Radius scan + threshold gate) and **trust-diff** (regression vs baseline + sticky PR comment).

Wraps the [`pqcheck` CLI](https://www.npmjs.com/package/pqcheck) — same scanner that powers [cipherwake.io](https://cipherwake.io).

Current version: **v3.1.0**. See [CHANGELOG.md](./CHANGELOG.md) for release history.

> **What's new in v3.1**: Trust Diff mode now posts a **sticky PR comment** when `comment-on-pr: true` on `pull_request` events. The comment auto-edits on subsequent pushes (no spam), shows the verdict (🟢 pass / 🟡 warn / 🔴 fail), per-delta breakdown with severity tags, and Approve-vendor / Configure-Trust-Diff links. Quota cost: 1 extra Trust Diff call per PR run when commenting is enabled.

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
| `mode` | no | `scan` | `scan` (full Decryption Blast Radius + threshold gate) or `trust-diff` (regression vs baseline + sticky PR comment) |
| `domain` | yes | — | Domain to scan (e.g. `example.com`) |
| `api-key` | no | `''` | Cipherwake API key (`qpk_...`). **Optional** for `mode=trust-diff` — if your workflow declares `permissions: id-token: write`, the action falls back to OIDC (Free=100 calls/repo/mo). Required only when running outside Actions, or to bypass per-IP rate limits on `mode=scan`. Pass via secret: `${{ secrets.CIPHERWAKE_API_KEY }}` |
| `comment-on-pr` | no | `false` | Post a sticky PR comment on `pull_request` events. Requires `permissions: pull-requests: write` |
| `github-token` | no | `${{ github.token }}` | Token used to post/edit the PR comment |

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
