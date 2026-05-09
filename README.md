# pqcheck

Public source for the [`pqcheck`](https://www.npmjs.com/package/pqcheck) CLI and the [`quantapact/pqcheck/action`](https://github.com/quantapact/pqcheck/tree/main/action) GitHub Action — both wrappers around the free [Quantapact API](https://quantapact.com/api).

Same scanner that powers [quantapact.com](https://quantapact.com), the browser extension, and Slack `/pqcheck`.

## Repository contents

```
cli/      Source for the npm package `pqcheck`
action/   Source for the GitHub Action `quantapact/pqcheck/action`
```

## CLI — `npx pqcheck`

```bash
npx pqcheck stripe.com
```

Zero install. Free, no signup. Full reference: [`cli/README.md`](./cli/README.md) or run `npx pqcheck --help`.

## GitHub Action — `quantapact/pqcheck/action`

```yaml
- uses: quantapact/pqcheck/action@main
  with:
    domain: mycompany.com
    threshold: '7'
    comment-on-pr: 'true'
```

Full input/output reference: [`action/README.md`](./action/README.md).

## Server-side source

The TLS scanner, scoring engine, methodology code, and API endpoints live in a separate (private) repo. The public API at `https://www.quantapact.com/api/scan` is the contract the CLI and Action are built against — see [quantapact.com/api](https://quantapact.com/api) for endpoint reference.

## Methodology

Scoring is fully open: [quantapact.com/methodology](https://quantapact.com/methodology). Argue with the math in public.

## License

MIT. © 2026 Quantapact.

## Contributing / feedback

Issues and PRs welcome on this repo. Or reach us at [quantapact.com/feedback](https://quantapact.com/feedback).
