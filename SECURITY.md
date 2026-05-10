# Security policy

## Reporting a vulnerability

If you believe you've found a security issue in `pqcheck` (the CLI, the GitHub Action, or anything else in this repo), please report it privately rather than opening a public issue.

**Email:** security@quantapact.com

Include:
- A description of the issue and its impact
- Steps to reproduce
- The affected component (CLI version / Action version / endpoint)
- Optional: a suggested fix

We aim to:
- Acknowledge the report within 3 business days
- Confirm or dispute the issue within 14 days
- Ship a patched release (or document why we won't) within 30 days for confirmed issues

We do not currently run a paid bug-bounty program. We're happy to credit reporters in the changelog and the GitHub release notes if you'd like.

## Supported versions

| Component | Supported |
| --- | --- |
| Latest CLI (`pqcheck` on npm) | ✅ |
| Latest Action (`quantapact/pqcheck/action@main`) | ✅ |
| Older releases | ❌ — please upgrade |

## Out of scope

- The hosted scanner at `https://quantapact.com` is covered by [quantapact.com/privacy](https://quantapact.com/privacy) and standard responsible-disclosure practice. Email `security@quantapact.com` for issues there too.
- Findings *produced by* pqcheck about third-party domains' TLS configuration are public observations, not vulnerabilities in pqcheck itself — they are not in scope here.
