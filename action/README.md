# pqcheck-action

> Quantum-decryption risk gate for GitHub Actions. Fails your build if the public-surface Decryption Blast Radius score for a domain exceeds a threshold.

Wraps the [`pqcheck` CLI](https://www.npmjs.com/package/pqcheck) — same scanner that powers [quantapact.com](https://quantapact.com).

## Quick start

```yaml
- uses: mzon7/quantapact/action@main
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
| `generate-lockfile`    | no       | `false`                  | Write `quantapact.lock` + `.md` for committing or artifact upload        |

## Outputs

| Output       | Description                              |
|--------------|------------------------------------------|
| `score`      | Decryption Blast Radius score (0-10)     |
| `grade`      | Letter grade A-F                         |
| `report-url` | Shareable report URL on `quantapact.com` |

## Examples

### Block PRs that regress the score

```yaml
name: Quantum-Risk Gate
on: [pull_request]
jobs:
  pqcheck:
    runs-on: ubuntu-latest
    steps:
      - uses: mzon7/quantapact/action@main
        with:
          domain: mycompany.com
          threshold: '7'
```

### Surface findings in GitHub Code Scanning (Security tab)

```yaml
- uses: mzon7/quantapact/action@main
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
- uses: mzon7/quantapact/action@main
  with:
    domain: mycompany.com
    generate-lockfile: 'true'
- uses: actions/upload-artifact@v4
  with:
    name: quantapact-lock
    path: |
      quantapact.lock
      quantapact-report.md
```

Or commit the lockfile to your repo (similar to `package-lock.json`) so PR diffs surface posture changes.

### Use the score in a follow-up step (e.g. PR comment)

```yaml
- uses: mzon7/quantapact/action@main
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
  - uses: mzon7/quantapact/action@main
    with:
      domain: ${{ matrix.domain }}
      threshold: '7'
```

## Exit codes

| Code | Meaning                                                |
|------|--------------------------------------------------------|
| 0    | Success — score below threshold                        |
| 1    | Usage / network / unreachable error                    |
| 2    | Score met or exceeded threshold                        |

## Runner requirements

- GitHub-hosted Ubuntu / macOS / Windows runners — works out of the box (Node, `jq`, `awk` preinstalled).
- Self-hosted runners must have Node ≥ 18, `jq`, and `awk` available.

## License

MIT. © 2026 Quantapact.
