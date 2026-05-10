# Contributing to pqcheck

Thanks for your interest. This repo hosts the `pqcheck` CLI (`/cli`) and the companion GitHub Action (`/action`). Both share the same scoring methodology, documented at [quantapact.com/methodology](https://quantapact.com/methodology).

## Maintainer

`pqcheck` is built and maintained by **Dr. Michael Zon**, MD (McMaster University) and PhD in Biomedical Engineering (McMaster University). The project is a single-maintainer effort.

## Quickest contribution path

- **Bugs / unexpected output:** open an issue with the exact domain you scanned, the command you ran, the version you're on (`pqcheck --version`), and the output. Redact anything you don't want public.
- **Methodology feedback:** open an issue tagged `methodology`. Cite the relevant page under [`/methodology/`](https://quantapact.com/methodology). Score-weighting changes are version-bumped (v1.x) and documented in the per-tool changelog before they ship.
- **Code:** read the rest of this file.

## Local dev

```bash
git clone https://github.com/quantapact/pqcheck.git
cd pqcheck/cli
node bin/pqcheck.js stripe.com
```

The CLI is plain Node.js (>=18), zero build step, **zero npm dependencies**. The bin file is self-contained and calls `https://quantapact.com/api/scan` via the built-in `fetch`. Keep it that way — every added dependency becomes a supply-chain surface for a tool whose job is to find supply-chain surfaces.

The Action wraps the same CLI; see `/action/action.yml` for inputs and outputs.

## Style

- Plain JS for the CLI; TypeScript on the server side of the API. No transpilation for the CLI bin.
- Match existing formatting (2-space indent, double quotes in JSON, single quotes in JS).
- Keep CLI output deterministic and grep-friendly. No surprise color in non-TTY contexts.
- New `--flag` or new subcommand? Add it to `cli/README.md` (flags / subcommands tables) **in the same commit**. The repo's hygiene rule is that docs match code at every published version.

## Versioning

Semver:
- Patch (`0.7.5` → `0.7.6`) — bug fix, behavior tightening, no contract change.
- Minor (`0.7` → `0.8`) — new flag/subcommand/feature, backward-compatible.
- Major (`0.x` → `1.0`) — breaking change to inputs, outputs, or scoring contract.

Every released change updates `cli/CHANGELOG.md` (or `action/CHANGELOG.md`) and bumps `version` in the affected `package.json` in the same commit, then ships via `npm publish` + a tagged GitHub release.

## Funding

`pqcheck` has no funding, no sponsors, and no commercial backing. Quantapact is bootstrapped; there are no donation, GitHub Sponsors, or grant channels accepting contributions, financial or otherwise. The hosted scanner at [quantapact.com](https://quantapact.com) is run as a free public utility, and the CLI / Action / extension are MIT-licensed open source.

If you'd like to support the project, the most useful things are: (a) star the repo, (b) file a bug or methodology issue you've actually hit, (c) tell a colleague.

## License

By contributing, you agree your contribution is licensed under MIT (same as this project).

## Conduct

Be civil and stay on-topic. We don't have a separate code of conduct; if behavior degrades, the maintainer will intervene.
