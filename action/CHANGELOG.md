# Changelog — pqcheck-action

All notable changes to the GitHub Action.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [v2.0.1] — 2026-05-09

### Added (via underlying CLI 0.7.5)
- **Degraded-score `::warning` annotation** in the workflow check summary when the API falls back to a cached value (live probes failed three times). Surfaces as a yellow warning on the PR check, so a CI gate can't silently consume stale data without a maintainer noticing.

### Notes
- No `action.yml` changes — the warning is emitted automatically by the wrapped `pqcheck --gh-action` invocation. Workflows pinned to `@main` get the new behaviour on the next run with no edits required.

---

## [v2.0.0] — 2026-05-08

### Added
- **`generate-sarif` input** — emits SARIF 2.1.0 to a configurable path. Pair with `github/codeql-action/upload-sarif@v3` to surface findings as alerts in the GitHub Security tab (Code Scanning).
- **`sarif-output-path` input** — where to write the SARIF file (default `pqcheck-results.sarif`).
- **`generate-lockfile` input** — writes `quantapact.lock` + `quantapact-report.md` to the workflow checkout directory. Useful for committing crypto posture as a versioned artifact, or for diffing across PRs (combine with `actions/upload-artifact@v4`).
- **Sticky PR comment** when `comment-on-pr: true` — updates the existing comment on subsequent runs instead of duplicating, tracked via comment marker.
- **Outputs**: `score`, `grade`, `report-url` for downstream steps to consume.

### Changed
- Wraps `pqcheck` CLI 0.7.x — picks up SARIF, multi-format output, `--gh-action` annotations, etc. automatically.

---

## [v1.0.0] — 2026-05-04

### Added
- Initial release: simple gate. Inputs: `domain`, `threshold`, `fail-on-unreachable`. Wraps `npx pqcheck@latest`.
- Exit code `2` when score meets or exceeds threshold.

---

## Unreleased

Planned (no committed dates):
- `multi-domain` input — accept a comma-separated list to gate multiple domains in one step.
- `mode: monitor` — run on schedule and write a status badge to the workflow summary without failing the build.
