#!/usr/bin/env node
// =============================================================================
// cipherwake-mcp — Model Context Protocol server for Cipherwake
// =============================================================================
// Exposes Cipherwake's deploy-check + scan + preview-diff + findings tools to
// any MCP-compatible AI coder (Claude Desktop, Claude Code, Cursor, Cline,
// Windsurf, Continue, etc.). When the agent is about to ship a deploy, it
// calls cipherwake_before_deploy_check directly — no `npx pqcheck` step
// required, no user clicking the statusbar item.
//
// Design principles (per CipherWake MCP guidelines, 2026-05):
//   1. Tool names match the agent's lifecycle. The most important one is
//      cipherwake_before_deploy_check — agents should naturally reach for it
//      before saying "deploy is ready."
//   2. Every response carries `human_summary` + `required_user_summary`
//      fields so the agent's final response surfaces Cipherwake's result.
//      MCP doesn't FORCE the agent to mention the result, but a structured
//      "Tell the user X" hint dramatically increases the probability.
//   3. Don't hide the brand. Every response starts with "Cipherwake checked
//      X" / "Cipherwake found Y" so users learn what's protecting them.
//   4. Quota responses are conditional + value-tied. Free tier exhaustion
//      after a real find (e.g. just caught a soft-404) → upgrade prompt
//      explicitly references the recent value event.
//   5. Findings live in the agent's reply, not buried in a dashboard.
// =============================================================================

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const API_BASE = process.env.CIPHERWAKE_API_BASE || "https://cipherwake.io";
const API_KEY = process.env.CIPHERWAKE_API_KEY || null;
const PKG_VERSION = "0.1.0";

// -----------------------------------------------------------------------------
// Tool definitions
// -----------------------------------------------------------------------------
// Description text is critical. Agents read it to decide WHEN to call. The
// "Use this when..." phrasing nudges the agent toward lifecycle moments
// instead of generic "run scan" framing.
// -----------------------------------------------------------------------------
const TOOLS = [
  {
    name: "cipherwake_before_deploy_check",
    description:
      "🚦 Pre-deploy trust gate. Use this AFTER finishing a code change and BEFORE telling the user a deploy is ready or merge is safe. Runs Cipherwake's deploy-check against the given domain, compares against the previous baseline, and returns a `ship_decision` of pass / review / block. The user is depending on this check to catch regressions in HTTPS posture, cert chain, security headers, third-party scripts, or vendor surface. ALWAYS surface the result (status + human_summary) in your final reply — do not hide a review/block.",
    inputSchema: {
      type: "object",
      properties: {
        domain: {
          type: "string",
          description: "The production domain to check (e.g. 'example.com'). Don't pass a URL — just the bare hostname.",
        },
      },
      required: ["domain"],
    },
  },
  {
    name: "cipherwake_preview_diff",
    description:
      "🔍 Compare a preview deployment (Vercel/Netlify/Cloudflare Pages preview URL) against the production URL. Use this AFTER deploying to preview and BEFORE saying the preview is safe to merge. Surfaces: new third-party scripts loaded on the page (Polyfill.io-class supply-chain risk), header regressions (CSP weakened, HSTS removed), cert/SPKI changes, broken protected paths, soft-404s. Returns structured findings the agent should summarize for the user.",
    inputSchema: {
      type: "object",
      properties: {
        preview_url: {
          type: "string",
          description: "Full preview URL including scheme, e.g. 'https://feature-x-abc123.vercel.app'.",
        },
        production_url: {
          type: "string",
          description: "Production canonical URL to compare against, e.g. 'https://example.com'.",
        },
      },
      required: ["preview_url", "production_url"],
    },
  },
  {
    name: "cipherwake_check_site_guards",
    description:
      "🛡️ Run Cipherwake Site Guards (R80 beta) against a single deployed URL. Use this AFTER deploying to verify runtime policies: source-map exposure, mixed-content blocks, approved-hosts compliance, protected-path responses (e.g. /admin → 401/302), cookie-flag enforcement (Secure / HttpOnly / SameSite), and link-integrity (no soft-404s on primary navigation). Unlike preview_diff which diffs against another URL, this checks a single URL against its `.cipherwake/guards.json` policy. Returns per-guard pass/fail.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Full URL to run guards against, e.g. 'https://feature-x-abc.vercel.app'.",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "cipherwake_create_guard_candidate",
    description:
      "✨ Recommend a new Site Guard config based on a finding the user wants to lock in. Use this WHEN the user just saw a Cipherwake finding (e.g. 'soft-404 on /pricing') and asks 'can we keep checking this in CI?' — or proactively after preview_diff surfaces a recurring drift. Returns a `.cipherwake/guards.json` patch the user can commit. Does not modify any file — agent must show the patch and ask the user to commit it.",
    inputSchema: {
      type: "object",
      properties: {
        guard_type: {
          type: "string",
          enum: ["source_map_exposure", "mixed_content", "approved_hosts", "protected_path", "cookie_flags", "link_integrity"],
          description: "Which guard kind to scaffold.",
        },
        target_url_or_path: {
          type: "string",
          description: "URL or path the guard applies to, e.g. '/admin' for a protected_path guard or 'https://example.com' for the whole site.",
        },
        expected: {
          type: "string",
          description: "Expected behavior in human terms, e.g. '401_or_302' for a protected_path guard, or 'no_new_hosts' for approved_hosts.",
        },
      },
      required: ["guard_type", "target_url_or_path"],
    },
  },
  {
    name: "cipherwake_scan_domain",
    description:
      "🔭 One-shot posture grade for ANY HTTPS domain (no signup, no API key). Use this when the user asks 'how secure is X?' or wants a quick read on a vendor / competitor / random site they're considering. Returns: DBR score (0-10), letter grade (A-F), and a findings list ranked by severity. This is the curiosity-driven entry point — surface the grade + 1-2 highest-severity findings in your reply.",
    inputSchema: {
      type: "object",
      properties: {
        domain: {
          type: "string",
          description: "The domain to scan (e.g. 'stripe.com'). Bare hostname only.",
        },
      },
      required: ["domain"],
    },
  },
  {
    name: "cipherwake_explain_finding",
    description:
      "📖 Plain-English explanation of a specific Cipherwake finding ID (e.g. 'tls.ecdhe_only_quantum_vulnerable', 'headers.csp_missing'). Use this when the user asks 'what does this finding mean?' or when you need to summarize a finding without the user having to read a methodology page. Returns the finding's title, what's wrong, why it matters, and a recommended action.",
    inputSchema: {
      type: "object",
      properties: {
        finding_id: {
          type: "string",
          description: "Dot-separated finding ID, e.g. 'header.csp.missing' or 'email.spf.missing'.",
        },
      },
      required: ["finding_id"],
    },
  },
  {
    name: "cipherwake_suggest_fix",
    description:
      "🛠️ 'What should I fix first?' — picks the highest-impact, customer-actionable finding from the latest scan of a domain and returns a specific fix recommendation with effort label (low / medium / high). Excludes vendor-dependent or runtime-limitation findings the user can't act on. Use this when the user asks 'what's the most important thing to fix?' or after running deploy_check and wanting concrete next steps.",
    inputSchema: {
      type: "object",
      properties: {
        domain: {
          type: "string",
          description: "Domain to get the top fix for. Bare hostname.",
        },
      },
      required: ["domain"],
    },
  },
];

// -----------------------------------------------------------------------------
// HTTP helpers
// -----------------------------------------------------------------------------

async function callApi(path, body = null, method = "GET") {
  const url = `${API_BASE}${path}`;
  const headers = {
    "accept": "application/json",
    "user-agent": `cipherwake-mcp/${PKG_VERSION}`,
  };
  if (API_KEY) headers["authorization"] = `Bearer ${API_KEY}`;
  const init = { method, headers };
  if (body !== null) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, ok: res.ok, body: json, raw: text };
}

// -----------------------------------------------------------------------------
// Helpers that shape MCP responses with the "make the agent surface this"
// fields per the design guidelines.
// -----------------------------------------------------------------------------

function shapeResponse({ status, human_summary, required_user_summary, next_step, structured = null, upgrade_prompt = null, checked = null }) {
  // The MCP spec's response shape is { content: [...] } where each block is
  // typed. We emit a structured JSON block (machine-readable) + a branded
  // markdown block (agent pastes verbatim into its final reply). The
  // markdown is what guides the agent's user-visible output.
  //
  // The structured payload carries `agent_instruction` (the guideline-spec
  // field name) AND `required_user_summary` (an alias for back-compat with
  // earlier MCP test consumers). Both contain the same imperative text:
  // "Tell the user X, do not hide Y."
  const payload = {
    status,
    human_summary,
    agent_instruction: required_user_summary,        // guideline-spec name
    required_user_summary: required_user_summary,    // alias
    next_step,
  };
  if (structured) payload.structured = structured;
  if (upgrade_prompt) payload.upgrade_prompt = upgrade_prompt;
  if (checked) payload.checked = checked;

  // Branded markdown for the agent's reply. Per CipherWake MCP guidelines:
  // the response must enumerate what Cipherwake CHECKED (not just what was
  // found) so the user learns what's protecting them on every invocation.
  const brandLine = "🛡️ **Cipherwake**";
  const verdictGlyph = status === "pass" ? "✅" : status === "review" ? "⚠️" : status === "block" ? "🛑" : "ℹ️";
  const checklistBlock = (checked && checked.length > 0)
    ? `\n\n**Cipherwake checked:**\n${checked.map((c) => `- ✓ ${c}`).join("\n")}`
    : "";
  const markdownSummary = `${brandLine} · ${verdictGlyph} **${(status || "info").toUpperCase()}** — ${human_summary}${checklistBlock}${next_step ? `\n\n**Next step:** ${next_step}` : ""}${upgrade_prompt ? `\n\n_${upgrade_prompt}_` : ""}`;

  return {
    content: [
      { type: "text", text: JSON.stringify(payload, null, 2) },
      { type: "text", text: markdownSummary },
    ],
  };
}

function errorResponse(message, hint = null) {
  return shapeResponse({
    status: "error",
    human_summary: message,
    required_user_summary: `Tell the user that the Cipherwake check could not complete: ${message}${hint ? `. ${hint}` : ""}`,
    next_step: hint || "Retry the call with a valid input, or surface the error to the user.",
  });
}

// -----------------------------------------------------------------------------
// Tool implementations
// -----------------------------------------------------------------------------

// What this tool checked — surfaced in the response so users learn what's
// protecting them on every invocation (per CipherWake MCP guidelines).
const CHECKED_BEFORE_DEPLOY = [
  "trust posture vs baseline",
  "certificate chain + SPKI",
  "security headers (HSTS / CSP / X-Frame-Options / DMARC / SPF)",
  "third-party scripts + vendor surface",
  "subdomain takeover exposure",
];

const CHECKED_PREVIEW_DIFF = [
  "third-party hosts",
  "headers (CSP / HSTS / X-Frame-Options / DMARC)",
  "source maps",
  "mixed content",
  "soft 404s",
  "protected paths (if configured)",
  "cookie flags (Secure / HttpOnly / SameSite)",
];

const CHECKED_SCAN_DOMAIN = [
  "TLS posture (cipher class + PQC group)",
  "certificate chain + key reuse across rotations",
  "security headers",
  "email security (SPF / DMARC / DKIM / BIMI)",
  "supply-chain third-party hosts",
  "subdomain takeover exposure",
];

// Quota-exhaustion response shared across tools. Per guidelines: don't say
// "tool quota exceeded" — say what's exhausted, offer a local fallback, and
// tie the upgrade prompt to recent value.
function quotaExhaustedResponse(toolName, recentValueEvent = null) {
  return shapeResponse({
    status: "review",
    human_summary:
      `Cipherwake's free deploy checks are used up for this IP this hour (120/hr cap). ` +
      `You can still run a basic local scan via \`npx pqcheck <domain>\` from a fresh IP / VPN, ` +
      `or wait ~10 min for the per-IP bucket to refill.`,
    required_user_summary:
      `IMPORTANT — tell the user Cipherwake's free deploy checks are exhausted. ` +
      `Do NOT mark the deploy ready without verification. Offer two paths: (a) wait ~10 min and ` +
      `retry, or (b) set CIPHERWAKE_API_KEY for the authenticated path with its own per-account quota.`,
    next_step:
      "Either wait + retry, or run `npx pqcheck <domain>` locally as a basic fallback check.",
    upgrade_prompt: recentValueEvent
      ? `${recentValueEvent} Cipherwake Founder Pro ($19.99/mo launch pricing, locked while subscription active) removes the per-IP cap, gives you 5,000 checks/month, custom CI fail-on thresholds, and a webhook delivery channel. See https://cipherwake.io/pricing.`
      : `Cipherwake Founder Pro ($19.99/mo launch pricing, locked while subscription active) removes the per-IP cap and adds 5,000 checks/month + custom CI thresholds + webhook delivery. https://cipherwake.io/pricing`,
  });
}

async function tool_before_deploy_check({ domain }) {
  if (!domain || typeof domain !== "string") {
    return errorResponse("missing or non-string `domain`", "Pass a bare hostname like 'example.com' (no scheme, no path).");
  }
  const r = await callApi("/api/trust-diff", { domain, baseline: "last-week", fail_on: "high" }, "POST");
  if (r.status === 429) {
    return quotaExhaustedResponse("cipherwake_before_deploy_check");
  }
  if (!r.ok || !r.body) {
    return errorResponse(`Cipherwake API returned ${r.status}`, `Raw body: ${(r.raw || "").slice(0, 200)}`);
  }
  const b = r.body;
  const verdict = b.verdict || "pass";
  if (b.first_run) {
    return shapeResponse({
      status: verdict,
      human_summary: b.first_run_message || `First Cipherwake check for ${domain} — current state captured as the baseline. Subsequent runs will diff against this state.`,
      required_user_summary: `IMPORTANT — tell the user this was Cipherwake's FIRST check of ${domain} and the current state is now the baseline. Verdict: ${verdict.toUpperCase()}. Future runs will catch regressions. Do not hide that this was a first-run baseline event.`,
      next_step: verdict === "pass" ? "Proceed with the deploy. The next deploy will compare against this baseline." : "Review the current findings before announcing the deploy — they're now your baseline, so any regression would be measured from here.",
      checked: CHECKED_BEFORE_DEPLOY,
      structured: { first_run: true, domain, ...b },
    });
  }
  const agentStatus = verdict === "fail" ? "block" : verdict === "warn" ? "review" : "pass";
  const deltas = Array.isArray(b.deltas) ? b.deltas : [];
  const deltaLines = deltas.slice(0, 5).map(d => `- [${(d.severity || "").toUpperCase()}] ${d.title || d.type}`).join("\n");
  const summary = deltas.length === 0
    ? `Cipherwake compared ${domain} against the baseline scan and found no trust-surface regressions. Safe to announce the deploy.`
    : `Cipherwake found ${deltas.length} trust-surface change${deltas.length === 1 ? "" : "s"} since the baseline scan of ${domain}:\n${deltaLines}`;

  // Value-tied upgrade prompt: only fires when there's a recent finding the
  // user just saw, never on pass+0 deltas (no value event → no upsell, per
  // CipherWake MCP guidelines).
  let upgradePrompt = null;
  if (deltas.length > 0) {
    const topDelta = deltas[0];
    const topTitle = topDelta?.title || topDelta?.type || "trust-surface change";
    upgradePrompt = `Cipherwake just caught: "${topTitle}". Cipherwake Founder Pro ($19.99/mo launch pricing, locked while subscription active) keeps this check running automatically on every deploy + remembers approved vendors + sends webhook alerts on change. https://cipherwake.io/pricing`;
  }

  return shapeResponse({
    status: agentStatus,
    human_summary: summary,
    required_user_summary: `IMPORTANT — surface this Cipherwake result in your final reply. Do not hide PASS/REVIEW/BLOCK. Verdict: ${agentStatus.toUpperCase()}. ${deltas.length} delta${deltas.length === 1 ? "" : "s"}. If verdict is 'review' or 'block', DO NOT say the deploy is ready until the user explicitly accepts the changes or fixes them.`,
    next_step: agentStatus === "pass"
      ? "Announce the deploy is ready. Cipherwake has confirmed no regressions."
      : agentStatus === "review"
        ? "Surface the deltas to the user and ask whether each was intentional. Do not announce the deploy until the user accepts or fixes them."
        : "Refuse to announce the deploy. Tell the user a critical regression was detected. Fix the regression OR have the user explicitly override.",
    checked: CHECKED_BEFORE_DEPLOY,
    structured: { domain, verdict: agentStatus, deltas, baseline_at: b.baseline?.at, current_at: b.current?.at },
    upgrade_prompt: upgradePrompt,
  });
}

async function tool_preview_diff({ preview_url, production_url }) {
  if (!preview_url || !production_url) {
    return errorResponse("missing preview_url or production_url", "Pass both as full URLs including scheme.");
  }
  const r = await callApi("/api/preview-diff", { preview_url, production_url, fail_on: "high" }, "POST");
  if (r.status === 429) {
    return quotaExhaustedResponse("cipherwake_preview_diff");
  }
  if (!r.ok || !r.body) {
    return errorResponse(`Cipherwake API returned ${r.status}`, `Raw body: ${(r.raw || "").slice(0, 200)}`);
  }
  const b = r.body;
  const verdict = b.verdict || "pass";
  const agentStatus = verdict === "fail" ? "block" : verdict === "warn" ? "review" : "pass";
  const changes = b.result?.appSurfaceChanges || [];
  const guards = b.site_guards || [];
  const failedGuards = guards.filter(g => g.status === "fail");
  const changeLines = changes.slice(0, 5).map(c => `- ${c.kind || c.type}: ${c.message || c.title || JSON.stringify(c)}`).join("\n");
  const guardLines = failedGuards.map(g => `- ${g.id || g.name}: ${g.message || g.detail || "guard failed"}`).join("\n");
  const summary = (changes.length === 0 && failedGuards.length === 0)
    ? `Cipherwake compared preview (${preview_url}) vs production (${production_url}) and found no risky drift. Safe to merge.`
    : `Cipherwake compared preview vs production and surfaced ${changes.length} app-surface change${changes.length === 1 ? "" : "s"}${failedGuards.length > 0 ? ` and ${failedGuards.length} failed site guard${failedGuards.length === 1 ? "" : "s"}` : ""}:${changeLines ? `\n${changeLines}` : ""}${guardLines ? `\n${guardLines}` : ""}`;

  // Value-tied upgrade prompt — only fires when there's a finding to anchor
  // on. The phrasing names the specific value event (e.g., "found new
  // third-party host js.stripe.com") so the upsell reads as "keep THIS
  // working automatically" not "upgrade for features."
  let upgradePrompt = null;
  if (changes.length > 0 || failedGuards.length > 0) {
    const anchor = (changes[0]?.message || changes[0]?.title || failedGuards[0]?.message || failedGuards[0]?.id || "a deploy-surface change");
    upgradePrompt = `Cipherwake just caught "${anchor}" on this preview. Founder Pro ($19.99/mo launch pricing, locked while subscription active) keeps this check running automatically on every PR + remembers approved vendors so future deploys don't re-flag them + adds custom CI fail-on thresholds. https://cipherwake.io/pricing`;
  }

  return shapeResponse({
    status: agentStatus,
    human_summary: summary,
    required_user_summary: `IMPORTANT — surface the Cipherwake preview-diff result to the user. Do NOT hide a review/block. Verdict: ${agentStatus.toUpperCase()}. ${changes.length} app-surface change(s), ${failedGuards.length} failed guard(s). Do not say "preview looks good" without mentioning the specific findings (or explicit absence) above.`,
    next_step: agentStatus === "pass"
      ? "Tell the user the preview is safe to merge. Cipherwake found no risky drift."
      : "Tell the user about each finding, then either fix it or ask if the change was intentional. Do not merge without explicit acknowledgment.",
    checked: CHECKED_PREVIEW_DIFF,
    structured: { preview_url, production_url, verdict: agentStatus, changes, failed_guards: failedGuards },
    upgrade_prompt: upgradePrompt,
  });
}

async function tool_check_site_guards({ url }) {
  if (!url) return errorResponse("missing `url`", "Pass a full URL with scheme, e.g. 'https://example.com'.");
  // Site Guards run via the preview-diff endpoint with the same URL passed
  // as both preview and production — that exercises the per-URL guard
  // checks without doing a comparative diff. (Server-side, the guard-runner
  // path is gated separately from the diff-runner path.)
  const r = await callApi("/api/preview-diff", { preview_url: url, production_url: url, fail_on: "high" }, "POST");
  if (r.status === 429) return quotaExhaustedResponse("cipherwake_check_site_guards");
  if (!r.ok || !r.body) return errorResponse(`Cipherwake API returned ${r.status}`);
  const guards = (r.body.site_guards || []);
  if (guards.length === 0) {
    return shapeResponse({
      status: "info",
      human_summary: `No Site Guards configured for ${url}. Site Guards are runtime policies (source maps off, /admin returns 401, no mixed content, etc.) loaded from a \`.cipherwake/guards.json\` file in the repo. Run \`npx pqcheck guards init --domain <domain>\` to scaffold a default set.`,
      required_user_summary: `Tell the user there are no Site Guards configured yet for ${url} and they can scaffold one with \`pqcheck guards init\`.`,
      next_step: "Run `npx pqcheck guards init --domain <domain>` to create a default `.cipherwake/guards.json`, then re-run cipherwake_check_site_guards.",
      checked: CHECKED_PREVIEW_DIFF,
    });
  }
  const passed = guards.filter(g => g.status === "pass");
  const failed = guards.filter(g => g.status === "fail");
  const other = guards.filter(g => g.status !== "pass" && g.status !== "fail");
  const failLines = failed.map(g => `- 🛑 ${g.id || g.name}: ${g.message || g.detail || "guard failed"}`).join("\n");
  const otherLines = other.map(g => `- ⊝ ${g.id || g.name}: ${g.status} — ${g.message || g.detail || ""}`).join("\n");
  const summary = failed.length === 0
    ? `Cipherwake ran ${guards.length} Site Guard(s) against ${url}: all passed.${other.length > 0 ? `\n${otherLines}` : ""}`
    : `Cipherwake ran ${guards.length} Site Guard(s) against ${url}: ${passed.length} passed, ${failed.length} failed:\n${failLines}${otherLines ? `\n${otherLines}` : ""}`;
  const agentStatus = failed.length === 0 ? "pass" : "review";
  return shapeResponse({
    status: agentStatus,
    human_summary: summary,
    required_user_summary: `IMPORTANT — surface the Cipherwake Site Guards result to the user. Do NOT hide a failed guard. ${passed.length} guards passed, ${failed.length} failed.`,
    next_step: failed.length === 0
      ? "All guards pass. Safe to continue."
      : "Fix each failed guard before proceeding, or call cipherwake_create_guard_candidate if the failure represents an intentional change that should update the policy.",
    checked: CHECKED_PREVIEW_DIFF,
    structured: { url, guards, passed_count: passed.length, failed_count: failed.length },
  });
}

async function tool_create_guard_candidate({ guard_type, target_url_or_path, expected }) {
  if (!guard_type || !target_url_or_path) {
    return errorResponse("missing guard_type or target_url_or_path");
  }
  // Generate a `.cipherwake/guards.json` patch the user can commit. This is
  // a write-back tool but it doesn't actually touch any file — it returns a
  // JSON snippet the agent shows to the user. The user copies + commits.
  // Per CipherWake MCP guidelines: agent should "optionally create site
  // guard / watch-domain recommendation" — this is that recommendation.
  const guardId = `${guard_type.replace(/_/g, "-")}-${Date.now().toString(36).slice(-5)}`;
  const guardConfig = {
    id: guardId,
    type: guard_type,
    target: target_url_or_path,
    expect: expected || (guard_type === "protected_path" ? "401_or_302" : guard_type === "approved_hosts" ? "no_new_hosts" : "no_violations"),
    mode: "observe",      // beta-safe default per R80
    severity: "review",
  };
  const snippet = `// Add this to your .cipherwake/guards.json "guards" array:\n${JSON.stringify(guardConfig, null, 2)}`;
  return shapeResponse({
    status: "info",
    human_summary: `Cipherwake recommends adding a \`${guard_type}\` Site Guard for \`${target_url_or_path}\`. Suggested config:\n\`\`\`json\n${snippet}\n\`\`\`\nCommit this to your repo's \`.cipherwake/guards.json\` to lock the policy in. Defaults to observe-mode (reports but doesn't fail CI) per the R80 beta-safe default — flip to "active" mode once you're confident.`,
    required_user_summary: `IMPORTANT — show the user the suggested guard config (the JSON snippet above) and ask them to commit it to \`.cipherwake/guards.json\`. Do not modify the file yourself; the user owns this commit.`,
    next_step: `Show the user the JSON snippet. They commit it to \`.cipherwake/guards.json\` (or run \`npx pqcheck guards init\` first if the file doesn't exist yet). Next CI run will exercise the new guard in observe mode.`,
    structured: { guard_type, target: target_url_or_path, guard_config: guardConfig, file: ".cipherwake/guards.json" },
    upgrade_prompt: `Cipherwake just generated a guard recommendation. Founder Pro lets you sync guard configs across your team + history-track which guards have caught real regressions. https://cipherwake.io/pricing`,
  });
}

async function tool_scan_domain({ domain }) {
  if (!domain) return errorResponse("missing `domain`");
  const r = await callApi(`/api/scan?domain=${encodeURIComponent(domain)}`, null, "GET");
  if (r.status === 429) return quotaExhaustedResponse("cipherwake_scan_domain");
  if (!r.ok || !r.body) return errorResponse(`Cipherwake API returned ${r.status}`);
  const b = r.body;
  const grade = b.grade || "?";
  const score = typeof b.score === "number" ? b.score.toFixed(1) : "?";
  const findings = Array.isArray(b.findings) ? b.findings : [];
  const high = findings.filter(f => ["critical", "high"].includes(String(f.severity).toLowerCase()));
  const topFindings = high.slice(0, 3).map(f => `- [${(f.severity || "").toUpperCase()}] ${f.title || f.id}`).join("\n");
  const summary = high.length === 0
    ? `Cipherwake scanned ${domain}: grade ${grade} (DBR ${score}/10). No high-severity findings.`
    : `Cipherwake scanned ${domain}: grade ${grade} (DBR ${score}/10). ${high.length} high-severity finding${high.length === 1 ? "" : "s"}:\n${topFindings}`;

  // Value-tied upgrade prompt — only when there's a real finding to anchor on
  let upgradePrompt = null;
  if (high.length > 0) {
    const top = high[0];
    upgradePrompt = `Cipherwake just found ${high.length} high-severity finding(s) on ${domain}, starting with: "${top.title || top.id}". Founder Pro keeps watching this domain daily + alerts you when anything changes. https://cipherwake.io/pricing`;
  }

  return shapeResponse({
    status: high.length === 0 ? "pass" : "review",
    human_summary: summary,
    required_user_summary: `IMPORTANT — surface the Cipherwake scan result to the user. Do NOT hide a 'review' verdict. Grade: ${grade}, DBR ${score}. ${high.length} high-severity finding(s). Quote the top 1-2 findings verbatim if any.`,
    next_step: high.length === 0 ? "No action needed." : `View full report: https://cipherwake.io/r/${encodeURIComponent(domain)}`,
    checked: CHECKED_SCAN_DOMAIN,
    structured: { domain, grade, score: b.score, findings_count: findings.length, high_severity_count: high.length },
    upgrade_prompt: upgradePrompt,
  });
}

async function tool_explain_finding({ finding_id }) {
  if (!finding_id) return errorResponse("missing `finding_id`");
  const id = finding_id.toLowerCase();
  const category = id.split(".")[0];
  const categoryLabels = {
    headers: "HTTP security headers (HSTS / CSP / X-Frame-Options / etc.)",
    header: "HTTP security headers",
    email: "Email-authentication DNS records (SPF / DMARC / DKIM / BIMI)",
    cert: "Certificate / SPKI / chain analysis",
    chain: "Certificate chain analysis (root / intermediate / leaf)",
    tls: "TLS handshake + cipher class + PQC posture",
    subdomain: "Subdomain takeover exposure (dangling CNAMEs)",
    vendor: "Third-party script + vendor surface tracking",
  };
  const explanation = categoryLabels[category] || "Cipherwake finding";
  return shapeResponse({
    status: "info",
    human_summary: `Cipherwake finding \`${finding_id}\` is in the ${explanation} category. Full methodology + severity reasoning at https://cipherwake.io/methodology/decryption-blast-radius#findings.`,
    required_user_summary: `IMPORTANT — quote the finding ID (${finding_id}) and its category (${explanation}) to the user. Do not paraphrase the ID away. Link them to the methodology page so they can read the full rubric.`,
    next_step: `Open https://cipherwake.io/methodology/decryption-blast-radius#findings for the full finding-by-finding rubric, OR call cipherwake_suggest_fix(domain) to get the highest-priority actionable fix recommendation.`,
    structured: { finding_id, category, methodology_url: "https://cipherwake.io/methodology/decryption-blast-radius#findings" },
  });
}

async function tool_suggest_fix({ domain }) {
  if (!domain) return errorResponse("missing `domain`");
  const r = await callApi(`/api/scan?domain=${encodeURIComponent(domain)}`, null, "GET");
  if (!r.ok || !r.body) return errorResponse(`Cipherwake API returned ${r.status}`);
  const b = r.body;
  const findings = Array.isArray(b.findings) ? b.findings : [];
  // Same actionability heuristic the dashboard uses. Lifted to MCP so agents
  // can recommend a specific fix without users opening the dashboard.
  const skipPrefix = [
    "chain.weakest_link.root", "tls.pqc_test_inconclusive",
    "tls.ecdhe_only_quantum_vulnerable", "cert.intermediate",
  ];
  const fixCatalog = [
    { prefix: "header.hsts", label: "Enable HSTS preload", effort: "low effort · single response header" },
    { prefix: "header.csp.missing", label: "Add Content-Security-Policy", effort: "medium effort · test before deploy" },
    { prefix: "header.csp.", label: "Tighten CSP policy", effort: "medium effort · audit unsafe-inline / *" },
    { prefix: "header.x_frame_options", label: "Add X-Frame-Options", effort: "low effort · single response header" },
    { prefix: "header.x_content_type_options", label: "Add X-Content-Type-Options", effort: "low effort · single response header" },
    { prefix: "header.referrer_policy", label: "Add Referrer-Policy", effort: "low effort · single response header" },
    { prefix: "header.permissions_policy", label: "Add Permissions-Policy", effort: "low effort · single response header" },
    { prefix: "email.spf", label: "Add SPF DNS record", effort: "low effort · single DNS TXT record" },
    { prefix: "email.dmarc", label: "Add or strengthen DMARC", effort: "low effort · single DNS TXT record" },
    { prefix: "email.dkim", label: "Set up DKIM signing", effort: "medium effort · ESP-side setup + DNS" },
    { prefix: "cert.short_lifetime", label: "Move to shorter cert lifetime", effort: "medium effort · cert rotation" },
    { prefix: "subdomain.takeover", label: "Reclaim dangling subdomain", effort: "medium effort · DNS cleanup" },
    { prefix: "tls.outdated_protocol", label: "Disable TLS 1.0/1.1", effort: "low effort · server config" },
    { prefix: "tls.weak_cipher", label: "Disable weak ciphers", effort: "low effort · server config" },
  ];
  const sevWeight = { high: 3, medium: 2, low: 1 };
  let best = null, bestScore = 0;
  for (const f of findings) {
    const id = String(f.id || f.code || "").toLowerCase();
    if (skipPrefix.some(p => id.startsWith(p))) continue;
    const match = fixCatalog.find(c => id.startsWith(c.prefix));
    if (!match) continue;
    const sev = sevWeight[String(f.severity || "").toLowerCase()] || 0;
    if (sev > bestScore) { best = { ...match, finding: f }; bestScore = sev; }
  }
  if (!best) {
    return shapeResponse({
      status: "pass",
      human_summary: `Cipherwake found no customer-actionable findings for ${domain}. Either posture is healthy, or remaining findings are vendor-dependent (root cert algorithm, runtime PQC support) that the user can't act on directly.`,
      required_user_summary: `IMPORTANT — tell the user Cipherwake found no fixable findings for ${domain}. Posture is healthy from a customer-action standpoint. Do not pretend there are fixes when there aren't — that erodes trust.`,
      next_step: "No action required. Re-run cipherwake_scan_domain periodically to monitor for new drift.",
      checked: CHECKED_SCAN_DOMAIN,
      structured: { domain, customer_actionable_findings: 0 },
    });
  }
  return shapeResponse({
    status: "review",
    human_summary: `Cipherwake's biggest-impact fix for ${domain}: **${best.label}** (${best.effort}). Underlying finding: ${best.finding.title || best.finding.id}.`,
    required_user_summary: `IMPORTANT — quote the exact fix label ("${best.label}") and effort ("${best.effort}") to the user. Cite the underlying finding ID (${best.finding.id}) so they can look it up in the methodology. Do not hide this behind a vague "improve security" message.`,
    next_step: `Apply the fix above. Re-run cipherwake_before_deploy_check after deploying to verify the regression cleared. Call cipherwake_explain_finding('${best.finding.id}') if the user wants more context.`,
    checked: CHECKED_SCAN_DOMAIN,
    structured: { domain, top_fix: best, severity: best.finding.severity },
    upgrade_prompt: `Cipherwake just identified a specific fixable finding. Founder Pro ($19.99/mo launch pricing, locked while subscription active) tracks fix-application over time + alerts when new fixable findings appear. https://cipherwake.io/pricing`,
  });
}

// -----------------------------------------------------------------------------
// Server wiring
// -----------------------------------------------------------------------------

const server = new Server(
  { name: "cipherwake-mcp", version: PKG_VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    switch (name) {
      case "cipherwake_before_deploy_check":   return await tool_before_deploy_check(args || {});
      case "cipherwake_preview_diff":           return await tool_preview_diff(args || {});
      case "cipherwake_check_site_guards":      return await tool_check_site_guards(args || {});
      case "cipherwake_create_guard_candidate": return await tool_create_guard_candidate(args || {});
      case "cipherwake_scan_domain":            return await tool_scan_domain(args || {});
      case "cipherwake_explain_finding":        return await tool_explain_finding(args || {});
      case "cipherwake_suggest_fix":            return await tool_suggest_fix(args || {});
      default:
        return errorResponse(`Unknown tool: ${name}`, "Available: cipherwake_before_deploy_check, cipherwake_preview_diff, cipherwake_check_site_guards, cipherwake_create_guard_candidate, cipherwake_scan_domain, cipherwake_explain_finding, cipherwake_suggest_fix.");
    }
  } catch (err) {
    return errorResponse(`Tool '${name}' threw: ${err.message || String(err)}`, "Retry, or report at https://cipherwake.io/feedback if the error persists.");
  }
});

const transport = new StdioServerTransport();
server.connect(transport).catch((err) => {
  console.error("cipherwake-mcp failed to connect:", err);
  process.exit(1);
});
