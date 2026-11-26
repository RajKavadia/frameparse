---
name: frameparse
description: Agentic-AI-first, zero-AI 4-layer webpage frame parser with built-in MCP server (stdio + Streamable HTTP). Use when browsing or inspecting webpages so agents read dramatically fewer tokens while getting higher-density structure, text, controls, and executable action plans.
---

# FrameParse — Agentic-AI-First 4-Layer MCP Skill

FrameParse is designed so AI agents read **5–20x fewer tokens** while getting **more actionable information** (structured landmarks, region-scoped text, verified CSS selectors, composite form workflows, side-effect safety tiers, and post-action diffs) — all computed deterministically with **zero AI**.

## Preferred Path: FrameParse MCP Server Tools

When the `frameparse` MCP server is connected (stdio: `node /agent/dist/src/cli.js mcp`, or HTTP: `POST http://127.0.0.1:4173/mcp`), ALWAYS follow this token-minimal loop:

1. **`frame_open({ url | html | fixture })`** — **Always first.**
   - Parses once, caches a stateful `sessionId` (`p1`), and returns **ONLY Frame 1 (Structure)** + token compression stats (~120–250 tokens instead of 10,000+ tokens of raw HTML).
   - Pick the exact `s#` landmark(s) relevant to the goal (e.g., `s4 [main]`, `s6 [form]`) and ignore nav/footer boilerplate.

2. **`frame_query({ sessionId, query })`** — **Fastest high-density lookup (~80–150 tokens).**
   - Need a price, spec, status, label, or specific button? Query across Frames 2–4 with zero AI instead of reading an entire layer.

3. **`frame_read({ sessionId, layer, regions, maxTokens, offset })`** — **Progressive, budget-capped reading.**
   - Pull ONLY the layer you need (`2` Text, `3` Interactables, `4` Actions), scoped to `regions: ["s4"]`, with a hard `maxTokens` cap (default `900`) and pagination (`offset` / `nextOffset`).

4. **`frame_plan({ sessionId, goal, regions?, allowDestructive? })`** — **Zero-AI action planning.**
   - Returns ranked Frame 4 composite **workflows (`w#`)** and atomic **actions (`a#`)** with:
     - `effect` tier: `read` | `navigate` | `mutate` | `destructive`
     - `preconditions` (required fields, disabled controls)
     - executable `steps` (`op`, `ref`, `selector`, `param`) ready for Playwright / browser runners.
   - **Safety Rule:** NEVER execute `effect: "destructive"` without explicit user confirmation.

5. **`frame_inspect({ sessionId, ref })`** — **Cross-layer vertical X-ray.**
   - Given any ref (`s#`, `t#`, `i#`, `w#`, `a#`), returns everything beneath and above it across Frames 1–4.

6. **`frame_diff({ sessionId, url | html | fixture })`** — **Delta-only re-observation (~40–150 tokens).**
   - After executing an action, diff against the cached session instead of re-reading the whole page. Inspect only `+text` alerts, `~changed interactables`, and `+actions`.

7. **`frame_sessions({ action: "list" | "close" })`** — **Check token savings telemetry** (raw HTML tokens avoided vs compact frame tokens emitted) or close sessions.

## CLI Fallback (when MCP is not mounted)

```bash
# Frame 1 (Structure)
node /agent/dist/src/cli.js <url-or-file> --layer 1 --stats

# Region-scoped Frame 2 (Text) or Frame 4 (Actions)
node /agent/dist/src/cli.js <url-or-file> --layer 2 --region s4
node /agent/dist/src/cli.js <url-or-file> --layer 4 --region s4

# Zero-AI Action Plan
node /agent/dist/src/cli.js <url-or-file> --plan "search for laptops"

# Post-action Frame Diff
node /agent/dist/src/cli.js before.html --diff after.html
```

## Rules for Agents

- **Never** dump raw HTML into context when `frame_open` + `frame_query` / region-scoped `frame_read` answers the question.
- **Always** pass `regions` and `maxTokens` to `frame_read` on large pages.
- **Always** prefer Frame 4 `workflows` (`w#`) over piecing form inputs and submit buttons together manually.
- **Always** use `frame_diff` after page mutations instead of calling `frame_open` again.
