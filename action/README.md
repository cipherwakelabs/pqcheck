# pqcheck-action

> Quantum-decryption risk gate for GitHub Actions. Fails your build if the public-surface Decryption Blast Radius score for a domain exceeds a threshold.

Wraps the [`pqcheck` CLI](https://www.npmjs.com/package/pqcheck) — same scanner that powers [cipherwake.io](https://cipherwake.io).

Current version: **v2.0.1**. See [CHANGELOG.md](./CHANGELOG.md) for release history.

> **What's new in v2.0.1**: when the underlying API falls back to a cached score (live probes failed three times), the action now emits a `::warning` annotation in the workflow check summary. Surfaces as a yellow warning on the PR check so a CI gate can't silently consume stale data. No `action.yml` changes needed — workflows pinned to `@main` get the behaviour automatically.

## Quick start

```yaml
- uses: cipherwake-io/pqcheck/action@main
  with:
    domain: mycompany.com
    threshold: '7'
```

If the score meets or exceeds `7`, the step exits `2` and the workflow fails.

## Inputs

| Input                  | Required | Default                  | Description                                                              |
|------------------------|----------|--------------------------|--------------------------------------------------------------------------|
| `domain`               | yes      | —                        | Domain to scan (e.g. `example.com`)                                      |
| `threshold`            | no       | `7`                      | Fail the step if score ≥ this (0-10)                                     |
| `fail-on-unreachable`  | no       | `true`                   | Treat unreachable domains as failures                                    |
| `comment-on-pr`        | no       | `false`                  | Post a sticky PR comment with scan summary (requires `pull-requests: write`) |
| `generate-sarif`       | no       | `false`                  | Write SARIF 2.1.0 report; pair with `codeql-action/upload-sarif@v3`      |
| `sarif-output-path`    | no       | `pqcheck-results.sarif`  | Where to write the SARIF file                                            |
| `generate-lockfile`    | no       | `false`                  | Write `cipherwake.lock` + `.md` for committing or artifact upload (preserves legacy `quantapact.lock` filename if already present) |
| `fresh`                | no       | `false`                  | Bypass server cache and force a fresh scan. Use in "deploy then verify" workflows. Subject to 20/hr per-IP cap server-side |
| `supply-chain-baseline` | no      | `''` (off)               | Path to a committed third-party baseline JSON (e.g. `.pqcheck-baseline.json`). When set, the action also runs `pqcheck deps --baseline <path>` and fails the build if any new third-party host appears since the baseline — the Polyfill.io-style change gate |
| `supply-chain-fail-on-new` | no   | `true`                   | When `supply-chain-baseline` is set, fail the build (exit `4`) if any new third-party host appeared since the baseline |
| `supply-chain-write-baseline` | no | `false`                  | When `supply-chain-baseline` is set, overwrite the baseline file with the current scan. Used to capture the initial state or deliberately accept new hosts — do NOT enable on every PR |

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
      - uses: cipherwake-io/pqcheck/action@main
        with:
          domain: mycompany.com
          threshold: '7'
```

### Surface findings in GitHub Code Scanning (Security tab)

```yaml
- uses: cipherwake-io/pqcheck/action@main
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
- uses: cipherwake-io/pqcheck/action@main
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
- uses: cipherwake-io/pqcheck/action@main
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
  - uses: cipherwake-io/pqcheck/action@main
    with:
      domain: ${{ matrix.domain }}
      threshold: '7'
```

### Supply-chain change detection (Polyfill.io-style gate)

Commit a baseline once, then every PR fails if a new third-party script appears:

```yaml
# Step 1 — capture initial baseline (run once locally or via an admin workflow)
- uses: cipherwake-io/pqcheck/action@v2.2.0
  with:
    domain: mycompany.com
    supply-chain-baseline: '.pqcheck-baseline.json'
    supply-chain-write-baseline: 'true'

# Step 2 — commit `.pqcheck-baseline.json`, then on every PR:
- uses: cipherwake-io/pqcheck/action@v2.2.0
  with:
    domain: mycompany.com
    threshold: '7'
    supply-chain-baseline: '.pqcheck-baseline.json'
    # supply-chain-fail-on-new defaults to true
```

A PR that introduces a new third-party host (analytics, CDN, font service, etc.) will fail with exit `4` and an `::error::` annotation explaining what changed. To accept the addition, re-run with `supply-chain-write-baseline: true` once and commit the updated baseline — the change becomes a reviewable diff in the PR rather than a silent supply-chain expansion.

## Exit codes

| Code | Meaning                                                |
|------|--------------------------------------------------------|
| 0    | Success — score below threshold                        |
| 1    | Usage / network / unreachable error                    |
| 2    | Score met or exceeded threshold                        |
| 4    | Supply-chain change detected — new third-party host(s) since baseline (`supply-chain-fail-on-new: true`) |

## Runner requirements

- GitHub-hosted Ubuntu / macOS / Windows runners — works out of the box (Node, `jq`, `awk` preinstalled).
- Self-hosted runners must have Node ≥ 18, `jq`, and `awk` available.

## License

MIT. © 2026 Cipherwake.
