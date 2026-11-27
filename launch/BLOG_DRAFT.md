# Why AI Browser Agents Don’t Need to Read Every Line of HTML

*Draft for Dev.to / Hashnode / personal blog. Grounded in [FrameParse](https://github.com/RajKavadia/frameparse).*

---

When you connect a language model to a web browser, the default observation is brutal: dump HTML, or something almost as large. On a product catalog, that can mean tens of thousands of tokens before the agent reads a single price. You pay for layout wrappers, hydration JSON, and duplicated cards—not for decisions.

This isn’t a modeling problem. It’s an **observation interface** problem.

## What agents actually need

Most web tasks follow a loop:

1. **Orient** — Where is the main content? Is there a form or grid?
2. **Read** — Specific facts (price, status, error message).
3. **Act** — Which control maps to the user’s goal?
4. **Observe again** — What changed after the click?

Raw HTML serves all four poorly. It optimizes for rendering, not for agency.

## Structured observation

FrameParse (MIT, TypeScript) parses HTML or a live DOM snapshot into **four cross-linked frames**:

| Layer | IDs | Agent use |
|-------|-----|-----------|
| Structure | `s#` | Landmarks, folded repeated cards |
| Text | `t#` | Clean copy anchored to structure |
| Interactables | `i#` | Buttons, links, inputs + selectors |
| Actions | `w#`, `a#` | Inferred workflows, effect tiers, steps |

Refs tie layers together. One MCP call, `frame_inspect`, walks the vertical lineage for any id.

Parsing is **deterministic**—no LLM in the hot path. Session caching means agents call progressive tools instead of re-uploading the page.

## MCP-shaped agent loop

Eight tools (on the latest branch: including `frame_chain`) implement a token-budgeted workflow:

- `frame_open` → Frame 1 only (~hundreds of tokens on samples, not thousands).
- `frame_query` / budgeted `frame_read` → targeted facts.
- `frame_plan` → ranked actions with `read | navigate | mutate | destructive` tiers.
- `frame_diff` → post-mutation delta.

Stdio or HTTP (`POST /mcp` on the local visualizer). Cursor setup is a few lines in `mcp.json`.

## Benchmarks (reproducible, not marketing fluff)

All numbers below come from `npm run benchmark` in the repo on **synthetic fixtures**:

- **Large SPA (~251 KB, 200 cards):** ~64,257 estimated raw tokens vs **196** Frame 1 tokens (~328× on that layer).
- **Same page, MCP “open + query”:** **447** emitted tokens vs 64,257 raw (~99.3% reduction in the harness’s comparison).

Token estimates use a simple character heuristic (`estimateTokens`), not a specific model tokenizer—use these for **relative** comparisons, not billing.

## A realistic workflow

1. Open session on a product page (`frame_open`).
2. Query `"warranty"` instead of reading all text.
3. `frame_plan` with goal `"add to cart"` → workflow `w#` with steps and selectors.
4. Your Playwright/CDP runner executes steps (FrameParse does **not** ship a driver).
5. After navigation, `frame_diff` instead of `frame_open` on the full HTML again.

For SPAs, a small extractor script (served as an MCP resource) captures post-hydration DOM; you pass JSON to `frame_open`.

## Limitations (read this before production)

- Action inference is heuristic—destructive actions need human confirmation.
- URL fetch in MCP has no cookie jar; auth flows need snapshots or your browser stack.
- Early project: install from git, Node ≥ 20, no npm package yet at v0.1.0.
- Live snapshots are as trustworthy as the page supplying them.

## What’s next

Community help wanted: false-positive action labels, CI, npm publish, and reference integrations with Playwright or browser-use **without** overclaiming built-in automation.

If you build agents on MCP, try the visualizer (`npm run visualizer`) and open an issue with a page that breaks your assumptions.

**Repo:** https://github.com/RajKavadia/frameparse

---

### Publishing notes

- **Dev.to:** `canonical_url` if you repost; tags: `mcp`, `ai`, `opensource`, `webdev`.
- **Hashnode:** mirror with canonical to primary.
- **Medium:** disable paywall for launch week.