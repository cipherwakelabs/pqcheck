# Changelog — pqcheck-action

All notable changes to the GitHub Action.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [v3.4.0] — 2026-05-19

### Added — `mode: preview-diff` (Preview Deploy Trust Diff)

The stickiest dev-workflow mode. Compares a **preview deployment URL**
against a **production URL** inside the PR. Surfaces new third-party
scripts, security-header regressions (including CSP weakening like
`script-src *` or `'unsafe-inline'` getting added), HSTS removal /
`max-age=0`, and DBR score drops — before merge.

```yaml
- uses: cipherwakelabs/pqcheck@v3
  with:
    mode: preview-diff
    preview-url: ${{ steps.vercel.outputs.preview-url }}
    production-url: https://example.com
    comment-on-pr: 'true'
```

New inputs (only used in `mode: preview-diff`):

- `preview-url` — full URL of the preview deployment
- `production-url` — full URL of the production canonical site
- `compare-transport` (default `false`) — opt TLS/cert/SPKI diffs into
  CI verdict. Default false because preview URLs typically use
  edge-host TLS (Vercel/Netlify/Cloudflare) and direct comparison is
  noise.

The existing `fail-on` input is honored: `none` / `off` → report-only,
anything else → CI fail on max severity ≥ threshold. Free tier silently
downgrades to report-only and notes the upgrade hook in the PR comment.
Starter+ honors `fail-on` for real CI gating.

### Security / scan path

Preview-diff uses a **dedicated SSRF-pinned scan path**
(`runPreviewScanForDomain`) that only invokes connect-time IP-pinned
probes: TLS handshake + page HTML fetch. It does NOT call the
unpinned probes (cipher class / cert chain / CT logs / email security
/ raw HTTP header fetch). Side benefit: preview-URL hostnames
(`feature-abc.vercel.app`) never enter Cipherwake's observation
tables — branch names stay private.

Trade-off: `preview.score` and `production.score` may be `null` in the
response (full DBR needs all components). Script / header / transport
comparison still works fully. To get a full DBR score, run
`npx pqcheck <domain>` separately — that path uses the standard
`/api/scan` pipeline.

### Hardening (R66 + R67 GPT review chain — both cleared 2026-05-19)

- `Validate mode` step rejects unknown `mode` inputs up front (typos no
  longer silently no-op)
- URL validation via Node's WHATWG parser instead of metachar denylist
  (allows query strings containing `&`)
- PR comment construction uses `jq --arg` for marker / preview-url /
  production-url variables (closes shell-concatenation injection on
  URLs containing single quotes / backslashes)
- Verdict-based exit code: `exit 2` on `verdict=fail` (CI blocked),
  `::warning::` on `warn` (CI green to keep PR comment visible)

## [v3.3.1] — 2026-05-18

### Security — INPUT_DOMAIN validation across all jobs

Per R52 / R51-B Q8.1 + Q8.3 review pass: the `domain` input is now validated
against a strict hostname regex (`^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$`)
at the top of every job (`trust-diff`, the PR-comment step, and `scan`)
before it touches any URL path, Markdown heading, badge image, or CLI
subprocess. Invalid values fail loudly with `::error::` (PR-comment step
downgrades to `::warning::` and skips so it never breaks the build for a
typo in the input).

Why: shell-quoted command substitution already prevented shell injection,
but a domain containing backticks, brackets, slashes, or newlines could
corrupt the rendered PR comment or the badge URL. Strict validation is
the right preventative fix.

### Copy — "highlight meaningful changes" replaces "flag any regressions"

The first-run PR comment now says "Future PRs and pushes will compare
against this snapshot and highlight meaningful changes." More accurate to
what the Action does (Trust Diff surfaces material posture changes, not
just regressions) and more developer-native voice.

## [v3.1.0] — 2026-05-16

### Added — Sticky PR comment for Trust Diff mode

When `mode: trust-diff` + `comment-on-pr: true` on a `pull_request` event, the Action posts a sticky PR comment with the Trust Diff verdict. Auto-edits on subsequent pushes (no comment spam). Heading `Cipherwake Trust Diff for <domain>` identifies prior comments for the dedup search.

Comment renders:
- Verdict emoji (🟢 pass / 🟡 warn / 🔴 fail) + plain-language headline
- "Changed" section with per-delta severity tags
- "No changes since baseline" branch for clean PRs
- Approve-vendor / Configure-Trust-Diff CTAs
- Quota footer (used / monthly limit)

### Quota cost

One extra Trust Diff API call per PR run when `comment-on-pr: true` — the CLI is invoked twice: once for the user-facing format + workflow log annotations, once with `--format json` for the comment markdown. Default behavior (`comment-on-pr: false`) is unchanged.

### Required permissions

Add to the workflow `permissions:` block when enabling commenting:

```yaml
permissions:
  contents: read
  pull-requests: write   # required for the sticky comment
```

### Mirror to workflow summary

The comment markdown is also written to `$GITHUB_STEP_SUMMARY` so the run page shows the verdict without opening the PR.

## [v3.0.0] — 2026-05-16

### Added — `mode: trust-diff` for CI-time public-trust-posture gating
- New `mode` input (default `scan`, new value `trust-diff`). In trust-diff mode, the Action calls `/api/trust-diff` via the CLI v0.11.0 `pqcheck trust-diff` subcommand.
- New inputs: `baseline` (last-week | last-month | last-scan | ISO date · default last-week), `fail-on` (any | low | medium | high | critical · default high), `output-format` (pretty | json | sarif | github · default github).
- Action exits 0 / 1 / 2 mapping to pass / warn / fail. CI build fails at exit code ≥ 1 unless your workflow tolerates warnings via `continue-on-error`.
- Requires `api-key` input (`secrets.CIPHERWAKE_API_KEY`). Free tier: 30 calls/month; generate at https://cipherwake.io/account#api-keys.
- The existing `mode: scan` (default) path is unchanged — workflows that don't set `mode` keep their existing behavior.

### Example
```yaml
- uses: cipherwakelabs/pqcheck/action@v3
  with:
    mode: trust-diff
    domain: my-domain.com
    baseline: last-week
    fail-on: high
    api-key: ${{ secrets.CIPHERWAKE_API_KEY }}
```

### Marketing-funnel copy aligned to the locked tier architecture
- Help text + step output reference Trust Diff + Vendor Change + HNDL + Key Map per the v3-way validated tier architecture.

## [v2.4.0] — 2026-05-15

### Changed — `generate-lockfile` now writes `cipherwake.lock` by default (was `quantapact.lock`)
- New default filename matches the project's new name after the
  Quantapact → Cipherwake rebrand. Existing workflows that already commit
  `quantapact.lock` are **unaffected** — the underlying CLI auto-detects
  the legacy file and overwrites it in place rather than creating a second
  lockfile in your repo. No migration required.
- Action README updated to advertise `secrets.CIPHERWAKE_API_KEY` as the
  recommended secret name. The legacy `secrets.QUANTAPACT_API_KEY` remains
  fully supported.
- Underlying CLI dependency bumped to `pqcheck@latest` (effectively v0.10.0+).

## [v2.3.0] — 2026-05-13

### Added — `api-key` input for Cipherwake account authentication
- New optional input `api-key`. When set, the action authenticates with your
  Cipherwake API key (Starter $29 / Growth $79 / Scale $199 tier required to
  generate one).
- Authenticated runs use your account's monthly quota (1K / 10K / 50K
  calls/mo by tier) instead of the per-IP rate limit. Critical for CI
  workflows that scan on every PR — the per-IP limit can be hit by a single
  busy monorepo before any business quota matters.
- Pass via secret: `api-key: ${{ secrets.QUANTAPACT_API_KEY }}`. Anonymous
  use still works for OSS projects without an account.
- Propagated to every CLI subprocess (scan, SARIF, lockfile, supply-chain).

## [v2.2.0] — 2026-05-12

### Added — supply-chain change detection in PRs
- **`supply-chain-baseline` input** — path to a committed third-party baseline JSON (e.g. `.pqcheck-baseline.json`). When set, the action runs an additional `pqcheck deps <domain> --baseline <path>` step.
- **`supply-chain-fail-on-new` input** (default `true`) — fail the build (exit `4`) when any new third-party host appeared since the committed baseline. Polyfill.io-style change gate: every PR that introduces a third-party script fails until a maintainer deliberately accepts the addition.
- **`supply-chain-write-baseline` input** (default `false`) — overwrite the baseline file with the current scan. Use on an admin workflow / locally to capture the initial state or to deliberately accept additions; **do not enable on every PR** or the gate becomes self-clearing.
- The step is no-op when `supply-chain-baseline` is empty (default) — backward-compatible with v2.1.0 workflows.

### Why it matters
Companion to CLI v0.7.8 and browser extension v0.3.14. Together they form a three-surface supply-chain change detection net:
- **Extension** — catches changes for sites individual users visit (per-tab popup)
- **CLI** — local checks and ad-hoc audits
- **Action** — gates PRs across every domain your team OWNS, blocking merges that quietly add a third-party script

The Polyfill.io compromise (June 2024) would have been a *failing PR check* in this model — the supply-chain change would have been visible and reviewable before the code shipped, instead of going live silently across 100K+ sites.

### Example
```yaml
- uses: cipherwakelabs/pqcheck/action@v2.2.0
  with:
    domain: mycompany.com
    threshold: '7'
    supply-chain-baseline: '.pqcheck-baseline.json'
```

To capture the initial baseline, run once with `supply-chain-write-baseline: true`, commit the resulting `.pqcheck-baseline.json`, then remove the write flag from the recurring workflow.

### Compatibility
No breaking changes. Existing v2.1.0 workflows continue to work unchanged (the new step is opt-in via the new input).

---

## [v2.1.0] — 2026-05-11

### Added
- **`fresh` input** (boolean, default `false`). When `true`, passes `--fresh` to the underlying CLI which appends `?force=1` to the API call. Bypasses the server-side smart-cache (1h SWR window + 24h ct_log_cache) and runs a fresh full scan. Subject to a 20/hr per-IP cap server-side; if exceeded the server silently downgrades to a cached scan and the step still succeeds.

### Why it matters
Closes the "deploy then verify" gap. Workflows that change a cert/key in one step and want to verify the result in the next step now get guaranteed-fresh data instead of up-to-1h-old cache. Particularly relevant for cert-rotation workflows post-Verified Monitoring rollout.

### Minor
- README documents the new input.
- Both the score step AND the SARIF step receive the `--fresh` plumbing so SARIF reports reflect post-deploy state when requested.

---

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
