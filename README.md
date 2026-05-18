# pqcheck

> **HTTPS posture scanner for engineers.** Trust Diff in CI, vendor lockfile + drift alerts, cross-tenant key map, HNDL/quantum-decryption risk score. Free, no signup.

Public source for the [`pqcheck`](https://www.npmjs.com/package/pqcheck) CLI and the [`cipherwakelabs/pqcheck/action`](https://github.com/cipherwakelabs/pqcheck/tree/main/action) GitHub Action. Both wrap the free [Cipherwake API](https://cipherwake.io/api).

The same scanner powers [cipherwake.io](https://cipherwake.io) and the browser extension.

---

## 60-second setup

```bash
npx pqcheck onboard your-domain.com
```

Scans your domain, scaffolds `.github/workflows/cipherwake.yml`, captures a vendor lockfile (`cipherwake.vendors.json`), and generates a release checklist. **No API key. No repo secret.** Commit the generated files + push, and Cipherwake will comment inline on every PR that drifts your domain's posture.

The scaffolded workflow uses GitHub's OIDC token (via `permissions: id-token: write`) to authenticate — 30 calls/month per repo on the Free tier, fully keyless. [How it works →](https://cipherwake.io/methodology)

---

## CLI — `npx pqcheck`

```bash
# One-shot grade for any HTTPS domain
npx pqcheck stripe.com

# What changed since last week?  (Trust Diff)
npx pqcheck trust-diff stripe.com --baseline last-week --fail-on high

# Vendor lockfile — fail PRs that add new third-party origins
npx pqcheck vendors export stripe.com         # capture current vendors
npx pqcheck vendors check  stripe.com         # CI gate, exits 4 on new origins

# Pre-deploy gate
npx pqcheck deploy-check stripe.com

# Markdown release-notes line (no API call)
npx pqcheck release-checklist stripe.com

# Local polling watcher (useful for cert rotation work)
npx pqcheck watch stripe.com --interval 60
```

Zero install, Node 18+. Full reference: [`cli/README.md`](./cli/README.md) or `npx pqcheck --help`.

### Exit codes (CI-friendly)

| Code | Meaning |
|---|---|
| `0` | Pass — no regression, no findings above threshold |
| `1` | Warn — changes below `--fail-on` threshold (CI not blocked) |
| `2` | Fail — regression detected at or above `--fail-on` (CI blocked) |
| `3` | Error — scanner failure / network / invalid input |
| `4` | New vendor origin detected by `vendors check` (CI blocked) |

---

## GitHub Action — `cipherwakelabs/pqcheck/action`

### Basic grade gate

```yaml
- uses: cipherwakelabs/pqcheck/action@v3
  with:
    domain: mycompany.com
    threshold: '7'
    comment-on-pr: 'true'
```

### Trust Diff — comment on every PR when posture drifts

```yaml
permissions:
  contents: read
  id-token: write          # keyless OIDC metering (Free=30 calls/repo/mo)
  pull-requests: write     # required for the sticky PR comment

jobs:
  trust-diff:
    runs-on: ubuntu-latest
    steps:
      - uses: cipherwakelabs/pqcheck/action@v3
        with:
          mode: trust-diff
          domain: mycompany.com
          baseline: last-week         # or last-month / last-scan / ISO timestamp
          fail-on: high               # any / low / medium / high / critical
          comment-on-pr: 'true'
```

No `CIPHERWAKE_API_KEY` needed on the Free tier — the workflow's `id-token: write` permission lets the Action mint a GitHub-signed JWT. Server verifies it and meters per repo. To raise limits, link the repo to a paid Cipherwake account (request via the [feedback form](https://cipherwake.io/feedback?topic=linked-repos) while the linking UI is rolling out).

Full input/output reference: [`action/README.md`](./action/README.md).

---

## Repository layout

```
cli/      Source for the npm package `pqcheck`
action/   Source for the GitHub Action
```

Server-side code (TLS scanner, scoring engine, API endpoints) lives in a separate private repo. The public contract is `cipherwake.io/api/scan` — same surface every CLI/Action call goes through. See [API docs](https://cipherwake.io/api) for the full schema.

## Methodology — the moat

Scoring is fully open: [cipherwake.io/methodology](https://cipherwake.io/methodology). Per-tool methodology pages document every weight, threshold, signal, and edge case. Argue with the math in public.

## Pricing

Free covers `pqcheck` CLI from any terminal (per-IP rate limit) + the GitHub Action with OIDC (30 calls/repo/month). Paid tiers ($29/$79/$199) add larger quotas, approved-vendor allowlist, webhook delivery, cross-tenant key map, and CSV export. Full breakdown at [cipherwake.io/pricing](https://cipherwake.io/pricing).

## License

MIT. © 2026 Cipherwake.

## Contributing / feedback

Issues and PRs welcome on this repo. Or reach us at [cipherwake.io/feedback](https://cipherwake.io/feedback).
