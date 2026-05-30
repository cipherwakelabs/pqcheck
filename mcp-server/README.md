# cipherwake-mcp

MCP server exposing [Cipherwake](https://cipherwake.io)'s deploy-gate + scan + preview-diff + suggest-fix tools to any [Model Context Protocol](https://modelcontextprotocol.io)-compatible AI coder.

Once installed, your AI agent can call these tools **directly** as part of its reasoning loop — no `npx pqcheck` step, no manual scanning. Customer asks "is this safe to deploy?" → Claude calls `cipherwake_before_deploy_check` → result lands in the chat reply.

## Tools

| Tool | When the agent should call it |
|---|---|
| `cipherwake_before_deploy_check` | After finishing a change, **before** telling the user a deploy is ready. Returns `pass` / `review` / `block`. |
| `cipherwake_preview_diff` | After deploying to a preview URL, before merging. Catches new third-party scripts, header regressions, soft-404s, broken protected paths. |
| `cipherwake_scan_domain` | When the user asks "how secure is X?" about any HTTPS domain. Returns DBR grade + top findings. |
| `cipherwake_explain_finding` | When the user asks "what does finding `headers.csp.missing` mean?" |
| `cipherwake_suggest_fix` | When the user asks "what should I fix first?" Returns the highest-impact, customer-actionable fix. |

Every tool response includes a `human_summary` and `required_user_summary` field so the agent surfaces the result in its final reply instead of hiding the check.

## Install

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%/Claude/claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "cipherwake": {
      "command": "npx",
      "args": ["-y", "cipherwake-mcp"]
    }
  }
}
```

Restart Claude Desktop. The 5 tools above appear in Claude's tool list.

### Claude Code (CLI)

Add to your `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "cipherwake": {
      "command": "npx",
      "args": ["-y", "cipherwake-mcp"]
    }
  }
}
```

### Cursor

Edit `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "cipherwake": {
      "command": "npx",
      "args": ["-y", "cipherwake-mcp"]
    }
  }
}
```

Restart Cursor. Tools appear in Cursor's MCP-mode tool list.

### Cline (VS Code extension)

Open the Cline panel → MCP Servers → Edit `cline_mcp_settings.json`:

```json
{
  "mcpServers": {
    "cipherwake": {
      "command": "npx",
      "args": ["-y", "cipherwake-mcp"],
      "disabled": false
    }
  }
}
```

### Windsurf / Continue / other MCP clients

Same shape — point the client's MCP config at:

```
command: npx
args: ["-y", "cipherwake-mcp"]
```

## Configuration

`cipherwake-mcp` reads two environment variables (both optional):

- `CIPHERWAKE_API_BASE` — override the API base URL (default: `https://cipherwake.io`)
- `CIPHERWAKE_API_KEY` — authenticated API key (`qpk_...`) for the [per-account quota path](https://cipherwake.io/pricing). Without it, you fall under the per-IP free tier (120 scans/hour shared with `npx pqcheck`).

## How the agent uses it

Anthropic's MCP doesn't *force* an agent to call a tool, but it strongly nudges. Cipherwake's tool descriptions are written to match agent lifecycle moments — `cipherwake_before_deploy_check` literally says "Use this AFTER finishing a code change and BEFORE telling the user a deploy is ready." That's the kind of phrasing agents respond to.

Combined with [Cipherwake's AI Coder Protocol](https://cipherwake.io/methodology/ai-coder-protocol) (installed via `npx pqcheck protocol install`), the agent has both:

1. **A rule** telling it to gate every deploy on `ship_decision`
2. **A tool** to actually run the check

The protocol rule + MCP tool together make the agent's behavior reliable across Claude Desktop, Claude Code, Cursor, Cline, and any future MCP client.

## Brand visibility

Every MCP response from `cipherwake-mcp` includes a markdown summary like:

```
🛡️ **Cipherwake** · ⚠️ **REVIEW** — found 2 trust-surface changes since baseline:
- [HIGH] New third-party script: widget.intercom.io
- [MEDIUM] Strict-Transport-Security weakened: max-age=31536000 → max-age=3600
```

Agents are expected to paste this verbatim into their final reply. The brand stays visible to the user — Cipherwake doesn't run silently in the background.

## Free vs paid

The MCP server is free to install + use. Underlying API quotas:

- **Free (anonymous, per-IP)**: 120 scans/hour shared with `npx pqcheck`. Fine for ad-hoc checks; can be exhausted by heavy CI use.
- **Cipherwake Founder Pro ($19.99/mo launch pricing, locked while subscription active)**: 5,000 calls/month + custom CI thresholds + Slack/webhook delivery + saved baselines. Set `CIPHERWAKE_API_KEY` to use this path.

See [cipherwake.io/pricing](https://cipherwake.io/pricing).

## Source + feedback

- Source: [github.com/cipherwakelabs/pqcheck/tree/main/mcp-server](https://github.com/cipherwakelabs/pqcheck/tree/main/mcp-server)
- Bug reports + feedback: [cipherwake.io/feedback](https://cipherwake.io/feedback)
- Cipherwake methodology (every probe documented): [cipherwake.io/methodology](https://cipherwake.io/methodology)

## License

MIT
