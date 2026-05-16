# pqcheck

Public source for the [`pqcheck`](https://www.npmjs.com/package/pqcheck) CLI and the [`cipherwakelabs/pqcheck/action`](https://github.com/cipherwakelabs/pqcheck/tree/main/action) GitHub Action — both wrappers around the free [Cipherwake API](https://www.cipherwake.io/api).

Same scanner that powers [cipherwake.io](https://www.cipherwake.io), the browser extension, and Slack `/pqcheck`.

## Repository contents

```
cli/      Source for the npm package `pqcheck`
action/   Source for the GitHub Action `cipherwakelabs/pqcheck/action`
```

## CLI — `npx pqcheck`

```bash
npx pqcheck stripe.com
```

Zero install. Free, no signup. Full reference: [`cli/README.md`](./cli/README.md) or run `npx pqcheck --help`.

## GitHub Action — `cipherwakelabs/pqcheck/action`

```yaml
- uses: cipherwakelabs/pqcheck/action@main
  with:
    domain: mycompany.com
    threshold: '7'
    comment-on-pr: 'true'
```

Full input/output reference: [`action/README.md`](./action/README.md).

## Server-side source

The TLS scanner, scoring engine, methodology code, and API endpoints live in a separate (private) repo. The public API at `https://www.cipherwake.io/api/scan` is the contract the CLI and Action are built against — see [cipherwake.io/api](https://www.cipherwake.io/api) for endpoint reference.

## Methodology

Scoring is fully open: [cipherwake.io/methodology](https://www.cipherwake.io/methodology). Argue with the math in public.

## License

MIT. © 2026 Cipherwake.

## Contributing / feedback

Issues and PRs welcome on this repo. Or reach us at [cipherwake.io/feedback](https://www.cipherwake.io/feedback).
