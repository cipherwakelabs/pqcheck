# Changelog

All notable changes to `pqcheck` are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.5] — 2026-05-09

### Added
- **Degraded-state warnings** when the API falls back to a cached score because three consecutive live probes failed:
  - Text mode: prominent yellow warning block above the score with reason and last-verified timestamp.
  - `--quiet` mode: warning written to **stderr** (numeric score on stdout stays clean and pipe-safe).
  - `--watch` mode: `⚠ cached (reason)` tag appended to the change line.
  - `--gh-action` (GitHub Actions): `::warning` annotation surfaces in the PR check summary.
- Asterisk marker (`*`) next to the score in text output when the value came from cached fallback.

### Why it matters
A CI gate or one-off check that silently consumes a stale cached score is a correctness risk. v0.7.5 makes degradation visible at every output surface so devs can decide whether to act on the number or re-run.

### Compatibility
No breaking changes. JSON output adds `_meta.degraded` (bool) and `_meta.degradedReason` (string|null). Existing fields preserved.

---

## [0.7.4] — 2026-05-08

### Fixed
- **SARIF URI scheme bug**: GitHub Code Scanning rejected SARIF reports because `artifactLocation.uri` used `https://` (incompatible with the checkout `file:` scheme). Switched to a relative path `quantapact-scan/<domain>.txt` so the SARIF passes the `gh code-scanning upload` validation.

---

## [0.7.0–0.7.3] — 2026-05-07 → 2026-05-08

### Added
- `--file <path>` — bulk-scan from a newline-separated file (`#` comments allowed).
- `pqcheck diff <old.lock> <new.lock>` — compare two QXM lockfiles. Exit 2 on regression.
- `pqcheck history <domain>` — show 90-day score history with sparkline.
- `pqcheck cert <file.pem>` — analyze a local PEM/CRT cert file (offline, no network).
- `--format sarif` — emit SARIF 2.1.0 for upload to GitHub Code Scanning.
- `--gh-action` — emit GitHub Actions `::notice/::warning/::error` annotations.
- `pqcheck deps --allowlist <file>` — exit code 3 if any third-party origin is not in the allowlist (CI vendor-risk gate).

### Changed
- README rewritten with Examples / Exit codes / CI integration sections.
- npm metadata aligned to the public `quantapact/pqcheck` org repo.

---

## [0.6.0] — 2026-05-07

### Added
- `pqcheck deps <domain>` — scan all third-party scripts/styles/iframes on a page (supply-chain HNDL preview).
- `--lock` flag for `deps` — write `quantapact-deps.lock` + `.md` for committable supply-chain artifacts.

---

## [0.5.0] — 2026-05-06

### Added
- **QXM (Quantum Exposure Manifest)**: `pqcheck lock <domain>` writes `quantapact.lock` (stable JSON) + `quantapact-report.md` (renders on GitHub) — the SBOM equivalent for quantum exposure.

---

## [0.4.0] — 2026-05-05

### Added
- `--threshold <0-10>` flag — exit code 2 if score meets or exceeds the threshold (CI gate).
- `--watch [seconds]` mode — poll on an interval, log changes.
- `--webhook <url>` — POST scan results to a URL on each tick.
- Multi-domain positional support (`npx pqcheck a.com b.com c.com`).

---

## [0.3.0] — 2026-05-04

### Added
- `--format markdown`, `--format csv` output formats.
- Color-coded text output (red/yellow/green by score band).

---

## [0.2.0] — 2026-05-04

### Added
- `--format json` (raw JSON for piping; NDJSON for multi-domain).
- `-q`/`--quiet` flag — print only the numeric score.

---

## [0.1.x] — 2026-05-03

### Added
- Initial release: `npx pqcheck <domain>` runs a Decryption Blast Radius scan via the public Quantapact API.
- Human-readable text output with TLS / cert / subdomain / hybrid-PQC findings.

---

## Unreleased

Planned for upcoming releases (no committed dates):
- `pqcheck inventory` — scan a directory tree for crypto-library imports (lighter-weight code-scanner companion).
- Session-tail probe (TLS ticket TTL + 0-RTT replay window) added to score input.
- `--ci-summary` — single-line PR-comment-friendly summary.
