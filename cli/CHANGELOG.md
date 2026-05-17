# Changelog

All notable changes to `pqcheck` are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.12.0] — 2026-05-16

### Added — Developer habit-loop bundle (6 new subcommands)

Six new subcommands that put Cipherwake where developers already work: PRs, CI, release notes, vendor allowlists. Free tier covers all of them within the existing 30 Trust Diff calls/month quota.

- **`pqcheck onboard <domain>`** — one-command setup wizard. Runs in sequence: (1) public scan to show your current grade, (2) `init` to scaffold the workflow, (3) `vendors export` to capture the lockfile, (4) writes `CIPHERWAKE_CHECKLIST.md` for release notes, (5) opens your browser to the API-key page, (6) prints next-steps. Flags: `--skip-scan`, `--skip-vendors`, `--skip-checklist`, `--no-open`. Honors `CI=true` and `CIPHERWAKE_NO_BROWSER=1` env vars to suppress the browser launch.
- **`pqcheck init`** — interactive scaffold for `.github/workflows/cipherwake.yml`. Prompts for domain, fail-on severity, baseline. Flags: `--yes` / `-y` (use defaults; requires `--domain`), `--force` (overwrite existing workflow), `--stdout` (print to stdout instead of writing), `--domain`, `--fail-on`, `--baseline`.
- **`pqcheck deploy-check <domain>`** — pre-deploy Trust Diff gate with deploy-friendly framing. Uses `last-scan` as default baseline + `high` as default fail-on. Same exit semantics as `trust-diff` (0 pass / 1 warn / 2 fail / 3 error).
- **`pqcheck release-checklist [domain]`** — pure-offline markdown checklist for release notes. No API call.
- **`pqcheck vendors export <domain>`** — write `cipherwake.vendors.json` from currently observed third-party origins (schema v1). Like `package-lock.json` for vendor scripts.
- **`pqcheck vendors check <domain>`** — CI gate; exits **4** when new origins appear that aren't in the lockfile (matches `deps --fail-on-new`). Exit 0 when only removals.
- **`pqcheck vendors sync <domain>`** — Starter+ only (requires `CIPHERWAKE_API_KEY`); merges your `/api/vendor-allowlist` approvals into the lockfile.

### Docs

- README — new "Get started in 60 seconds" section (`init → secret → push → PR comment`).
- New methodology page `/methodology/vendor-lockfile` per Rule 1 (Cipherwake project rules).

### Quota notes

- All habit-loop subcommands are Free-tier-eligible. `vendors *` calls `/api/deps` which has its own per-IP rate limit (not metered against the Trust Diff 30/mo quota).
- `vendors sync` requires a Starter+ API key because the underlying `/api/vendor-allowlist` endpoint is Starter+ gated server-side.

### Paired releases

- **GitHub Action v3.1** — `mode: trust-diff` + `comment-on-pr: true` now posts a sticky PR comment with Trust Diff results. Extra `--format json` CLI call when commenting is enabled (1 additional Trust Diff quota call per PR run).
- **Browser extension v0.6.1** — popup shows a "🛡 Add CI gate" CTA after every scan; deep-links to `/account?install-action=<domain>` which auto-opens the Trust Diff config section.

## [0.11.0] — 2026-05-16

### Added — `pqcheck trust-diff <domain>` subcommand
- New subcommand calls `/api/trust-diff` to compare current public trust posture vs a configured baseline.
- Inputs: `--baseline last-week|last-month|last-scan|<ISO>` (default last-week), `--fail-on any|low|medium|high|critical` (default high), `--format pretty|json|sarif|github` (default pretty).
- Exit codes: `0` pass · `1` warn (changes below threshold) · `2` fail (changes at/above threshold) · `3` error (auth/quota/network).
- Free tier: 30 calls/month at `CIPHERWAKE_API_KEY` (generate at https://cipherwake.io/account#api-keys).
- SARIF output (`--format sarif`) is upload-ready for `github/codeql-action/upload-sarif@v3` — surfaces deltas in the GitHub Security tab.
- GitHub Actions output (`--format github`) writes `::error::` / `::warning::` / `::notice::` workflow commands directly.
- Pairs with the new `cipherwakelabs/pqcheck/action` `mode: trust-diff` for one-line CI integration.

### Marketing-funnel copy aligned to the locked free-monitoring policy
- Help text + tail messages reference Trust Diff + Vendor Change + HNDL + Key Map per the v3-way validated tier architecture (Free=1 monitored, 30 API/mo, fail-mode CI; Starter $29=5 + allowlist; Growth $79=50 + Slack/webhook + team; Scale $199=500 + direct API + CSV).

## [0.10.0] — 2026-05-15

### Changed — Default lockfile filename is now `cipherwake.lock` (was `quantapact.lock`)
- `npx pqcheck lock <domain>` in a clean directory now writes `cipherwake.lock`
  + `cipherwake-report.md` (matches the project's new name after the
  Quantapact → Cipherwake rebrand).
- **Backwards-compatible permanently.** If a `quantapact.lock` already exists
  in the directory, the CLI overwrites it in place rather than silently
  creating a second file in your repo. No migration required — your existing
  committed lockfile keeps working forever.
- Same logic applies to `pqcheck deps --lock`: writes `cipherwake-deps.lock`
  by default, preserves legacy `quantapact-deps.lock` if already present.
- SARIF output's artifact-location URI changed from `quantapact-scan/...` to
  `cipherwake-scan/...` (visible in GitHub Code Scanning UI).

### Changed — Brand-trace cleanup across surfaces
- `CIPHERWAKE_API_KEY` env var name advertised in CLI help (the older
  `QUANTAPACT_API_KEY` continues to work as a permanent fallback).
- Help text + READMEs updated.

## [0.9.0] — 2026-05-13

### Added — Cipherwake account API-key support
- New env var `QUANTAPACT_API_KEY=qpk_<hex>` authenticates every CLI → API call.
- With a key set, your CLI usage bills against your account's monthly quota
  (Starter 1K · Growth 10K · Scale 50K calls/mo) instead of the per-IP rate limit.
- Anonymous CLI use still works — the env var is optional.
- Better error messages on 401 (invalid key) and 429 (quota exceeded) — points
  you at `/account` to rotate or `/pricing` to upgrade.
- Affects every authenticated endpoint: `scan`, `history`, `deps`, `lock`,
  `changes-summary`, `watch`. Webhook POSTs to your URL never receive your
  API key — only cipherwake.io calls do.

## [0.8.2] — 2026-05-12

### Fixed — SARIF rule IDs now stable across runs
- The `--format sarif` output previously emitted positional rule IDs (`pqcheck-1`, `pqcheck-2`, …). If the same domain produced findings in a different order between scans, GitHub Code Scanning would treat reordered findings as new findings, blowing up the triage queue. Fixed: rule IDs now derive from the finding's stable registry ID (e.g., `pqcheck.tls.rsa_kex_fallback`), so the same finding gets the same rule ID across runs.
- The SARIF `rules` array is also now deduped — multiple findings tied to the same registry rule (e.g., two key-reuse findings) no longer produce duplicate rule entries.

## [0.8.1] — 2026-05-12

### Added — "Tracked by Cipherwake since X · N observations" provenance pill
- After every scan, the CLI prints a one-line provenance footer (e.g. `Tracked by Cipherwake since 2026-04-12 · 47 observations`) showing how long Cipherwake has been observing the domain and how many cert observations we've accumulated. Only renders when prior history exists — first-ever scans of a brand-new domain stay quiet.
- Mirrors the pill on the extension popup, the GitHub Action PR comment, and the Slack `/pqcheck` response footer. Closes the cross-surface parity gap (Rule 8) for provenance.
- Turns one-shot scan output into a trust signal: this isn't a single probe — it's a row in a historical record.

## [0.8.0] — 2026-05-12

### Added — `pqcheck changes <domain>` subcommand
- **New subcommand `pqcheck changes <domain>`** — summarises Cipherwake-observed public attack-surface changes for a domain in the last 14 days. Calls `/api/changes-summary` against `cipherwake.io` and prints:
  - Tracking-since date (when Cipherwake first observed the domain)
  - Total changes detected in last 14d
  - Breakdown: new subdomains, new third-party script hosts, new cert SPKI fingerprints
  - Link to the full `/domain/<host>/security-changelog` page for deeper detail
- `--json` flag emits raw API JSON for CI / scripting use.
- Backed by the new observation tables introduced server-side 2026-05-13 (subdomain_observations, script_observations, cert_observations, posture_snapshots, dns_observations, caa_observations, email_security_observations) — every scan now accumulates time-series facts on the backend, and this command exposes the delta view in the terminal.

### Why it matters
Closes the parity loop for change-detection across surfaces: extension popup shows the "Changed: N" pill, website `/r/<host>` shows the watch card + diff link, GitHub Action's PR comment includes the recent-changes count, and now the CLI surfaces the same data for terminal workflows. Devs can run `pqcheck changes acme.com` in CI to flag when a dependency domain drifts, in PR descriptions to anchor "what changed since last week," or as a daily check on watched vendors.

### Compatibility
Additive only — no breaking changes. Existing commands (`pqcheck <domain>`, `lock`, `deps`, `diff`, `history`, `cert`) unchanged. Help text updated to list the new command.

## [0.7.9] — 2026-05-12

### Added — CSP-quality verdict + vendor classification on `deps`
- **CSP-quality verdict** captured from the homepage response. `pqcheck deps <domain>` now prints a one-line site-wide verdict above the table: `✗ No CSP enforcement`, `⚠ CSP is permissive`, or `✓ Strict CSP enforced`. Surfaced in JSON as `csp: { quality, source }`. Mirrors the extension's Supply Chain tab banner — same code path, same verdict.
- **Vendor classification** per third-party host. A new `VENDOR (CATEGORY)` column shows friendly names like `New Relic (errors)` or `Cloudflare (cdn)` instead of opaque hostnames. JSON adds `thirdParties[].vendor: { name, category }` (or `null` if no match). Catalog covers ~80 of the most common third parties; **unknown hosts fall through to a conservative heuristic** (`cdn.*` / `analytics.*` / `ads.*` / `consent.*` / etc.) so most third parties get at least a category label even without an explicit catalog entry. Heuristic matches return `name: null` so JSON consumers can distinguish them from explicit catalog matches.
- Schema bumped to **v1.2** to reflect the new fields. v1.0/v1.1 readers ignore the new fields without error.

### Why it matters
Companion to extension v0.3.14 and site `/r/<domain>` v0.4. The CLI is the CI surface — `pqcheck deps --fail-on-new` already gates new third parties; now the report it prints in PR comments tells reviewers *who* the new vendor is (`New Relic · errors`) and what the site's CSP posture looks like, instead of just listing raw hostnames. Closes the supply-chain story across all four surfaces (extension, CLI, GitHub Action, website).

### Cross-surface parity
The CSP-quality verdict + vendor classification now ship on all four surfaces (Rule 8 of CLAUDE.md): extension Supply Chain tab, website `/r/<domain>` supply chain section, CLI `pqcheck deps`, and the GitHub Action (inherits CLI behavior).

### Compatibility
Backwards-compatible. Existing JSON consumers reading v1.1 fields keep working. New `csp` and `vendor` fields are additive.

---

## [0.7.8] — 2026-05-12

### Added — supply-chain change detection in CI
- **`pqcheck deps <domain> --baseline <file>`** — compare current third-party host list to a stored baseline JSON file. Hosts in the current scan that weren't in the baseline are flagged as NEW. Empty baseline file (file missing) treats everything as the initial baseline.
- **`--write-baseline`** — overwrite the baseline file with the current scan's hosts. Run this once to capture the initial state, then re-run with just `--baseline` to detect future additions.
- **`--fail-on-new`** — exit code 4 if any new host appeared since the baseline (and the baseline isn't empty). The Polyfill.io-style supply-chain change detector for CI pipelines. Drop into a GitHub Action workflow with `--baseline .pqcheck-baseline.json --fail-on-new` and every PR that adds a new third-party script fails until the baseline is deliberately updated.
- **SRI status per script** — `extractThirdPartyRefs` now captures the `integrity` attribute. Each third-party host gets `sri: { allScriptsHaveSri, allHttps }` in the JSON output. Lets vendor-risk teams see which third parties don't enforce subresource integrity (silent supply-chain risk: vendor can swap script contents without anyone knowing).

### Why it matters
Companion to browser extension v0.3.14's per-site supply-chain detection. The extension catches changes for sites individual users visit; this CLI variant catches changes in CI for sites your team OWNS — your own site, your customer-facing portals, your vendor portfolio. Drop in a workflow YAML, fail PRs that introduce new third-party scripts, audit them deliberately. Brings supply-chain change detection into the dev/PR loop where it can be reviewed and approved before it ships.

### Schema additions
- `quantapact-deps.lock` schema bumped to v1.1: adds `baseline`, `sri`, `isNew` fields per host. Backward-compatible (older tooling reading v1.0 just ignores the new fields).

---

## [0.7.7] — 2026-05-11

### Added
- **`--fresh` flag (alias: `--force`)** on the scan subcommand. Bypasses the server-side smart-cache and runs a fresh full scan. Useful when verifying a cert/key change you just deployed — without `--fresh`, scans can return up-to-1h-old data from the SWR cache window. Subject to a 20/hr per-IP cap server-side; if exceeded, the server silently downgrades to a cached scan and the CLI still gets a result.
- **429 response now surfaces the upsell hint.** When the server returns a `need_more` object (rate limit hit), pqcheck prints the message + feedback-form URL to stderr so users know how to ask for higher limits.

### Changed
- README documents the actual rate limits (300 scans/hr, 20 force-refresh/hr per IP). Previous "60/minute" claim was stale.

### Why it matters
The `--fresh` flag closes a real workflow gap: CI/CD pipelines, sysadmins testing cert rotations, and devsecops people who want guaranteed-fresh data instead of cached. The 429 upsell turns rate-limit hits into demand signals routed to /feedback rather than dead ends.

### Compatibility
Backwards-compatible. No behavioural change without `--fresh`.

---

## [0.7.6] — 2026-05-10

### Changed
- **User-Agent string now includes the subcommand context** on every API call. Was: `pqcheck-cli/0.7.5`. Now: `pqcheck-cli/0.7.6 (scan)`, `(lock)`, `(deps)`, `(history)`, or `(watch)`. The subcommand for `lock`/`deps`/`history` was already tagged in 0.7.5; this release also tags `scan` and `watch` for consistency.

### Why it matters
The server can now aggregate adoption by subcommand — useful for understanding which CLI features are most used in the wild. The subcommand token rides inside the existing User-Agent header (which has always been logged anonymously); no new data is collected. See [cipherwake.io/privacy](https://cipherwake.io/privacy) for the full data-handling spec.

### Compatibility
No breaking changes. Older CLI versions continue to work; the server records `subcommand=null` for their requests.

---

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
- npm metadata aligned to the public `cipherwake-io/pqcheck` org repo.

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
- Initial release: `npx pqcheck <domain>` runs a Decryption Blast Radius scan via the public Cipherwake API.
- Human-readable text output with TLS / cert / subdomain / hybrid-PQC findings.

---

## Unreleased

Planned for upcoming releases (no committed dates):
- `pqcheck inventory` — scan a directory tree for crypto-library imports (lighter-weight code-scanner companion).
- Session-tail probe (TLS ticket TTL + 0-RTT replay window) added to score input.
- `--ci-summary` — single-line PR-comment-friendly summary.
