---
name: frameparse
description: Agentic-AI-first, zero-AI 4-layer webpage frame parser with MCP (stdio + HTTP) and CDP actuation. Use when browsing or acting on webpages so agents read fewer tokens while getting structure, text, controls, plans, and frame-ref clicks/scrolls.
---

# FrameParse — Agentic-AI-First 4-Layer MCP Skill

FrameParse is designed so AI agents read **5–20x fewer tokens** while getting **more actionable information** (structured landmarks, region-scoped text, verified CSS selectors, composite form workflows, side-effect safety tiers, executable steps, and post-action diffs) — all computed deterministically with **zero AI**.

## Preferred Path: FrameParse MCP Tools

When the `frameparse` MCP server is connected, ALWAYS follow this token-minimal loop:

### Observe

1. **`frame_open({ url | html | snapshot | fixture })`** — **Always first for a new page.**
   - Returns **ONLY Frame 1 (Structure)** + compression stats (~120–250 tokens instead of 10k+ raw HTML).
   - For live SPAs / auth pages prefer **`frame_browser({ action: "open", url, sessionId })`** (CDP live snapshot → session).

2. **`frame_query({ sessionId, query })`** — Fastest high-density lookup (~80–150 tokens).

3. **`frame_read({ sessionId, layer, regions, maxTokens, offset })`** — Progressive, budget-capped reading (layers 2–4).

4. **`frame_plan({ sessionId, goal, regions?, allowDestructive? })`** — Zero-AI action plans with `effect` tiers and `steps[]`.
   - **Safety:** NEVER execute `effect: "destructive"` without explicit user confirmation.

5. **`frame_inspect({ sessionId, ref })`** — Vertical lineage for any `s#` / `t#` / `i#` / `w#` / `a#`.

6. **`frame_diff(...)`** — Delta-only re-observation after mutations (~40–150 tokens).

### Act (CDP — no DevTools a11y uids)

7. **`frame_browser({ action: "connect" | "launch" | "navigate" | "open" | "status" })`**
   - Prefer `connect` to `http://127.0.0.1:9333` (Chrome `--remote-debugging-port` + `--remote-allow-origins=*`).

8. **`frame_act({ sessionId, ref | goal, params?, confirmDestructive? })`**
   - `ref`: `i#` (control), `a#` / `w#` (Frame 4), or `s#` (scroll region).
   - Ops: click, fill, select, toggle, submit, navigate, hover, focus, type, press.
   - Reobserves + returns `frame_diff` by default.

9. **`frame_scroll({ sessionId, op: "into_view" | "by" | "to", ... })`**

10. **`frame_sessions({ action: "list" | "close" })`** — Telemetry / cleanup.

## Rules for Agents

- **Never** dump raw HTML / full a11y trees when FrameParse answers the question.
- **Prefer** FrameParse `i#`/`a#`/`w#` over Chrome DevTools `uid` + `evaluate_script` when the CDP actuator is connected.
- **Always** pass `regions` + `maxTokens` on large pages.
- **Always** prefer Frame 4 workflows (`w#`) over hand-assembling form steps.
- **Always** use `frame_diff` / act reobserve after mutations instead of full re-dumps.
- **Never** set `confirmDestructive: true` unless the user explicitly confirmed.

## CLI Fallback

```bash
node dist/src/cli.js <url-or-file> --layer 1 --stats
node dist/src/cli.js <url-or-file> --layer 2 --region s4
node dist/src/cli.js <url-or-file> --plan "search for laptops"
node dist/src/cli.js before.html --diff after.html
```
