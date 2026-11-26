# FrameParse

**Zero-AI, deterministic 4-layer webpage frame parser for fast AI agent browsing.**

FrameParse decomposes any HTML webpage into **4 progressive, cross-referenced frames** in a few milliseconds with **zero LLM calls** and **zero runtime dependencies**:

1. **Frame 1 — Structure (`s#`)**: Semantic landmarks (`header`, `nav`, `main`, `article`, `form`, `table`, `footer`), heading outline, per-region text/interactable counts, and structural hash.
2. **Frame 2 — Text (`t#`)**: Clean, deduplicated readable content (`heading`, `paragraph`, `list_item`, `table_row`, `alert`) anchored to its parent Frame 1 region (`@s#`), with `<script>`, `<style>`, and hidden DOM noise stripped.
3. **Frame 3 — Interactables (`i#`)**: Canonical registry of interactive controls (`link`, `button`, `input`, `select`, `checkbox`, `form`, `tab`, etc.) with resolved accessible names, states (`required`, `disabled`, `checked`, `expanded`), `<select>` options, form links, and deterministic CSS selectors.
4. **Frame 4 — Actions (`w#`, `a#`)**: Deterministic specification of **what each control or multi-step form workflow will do**, including verb, intent category (`search`, `auth`, `commerce`, `crud_delete`, `download`, etc.), side-effect safety tier (`read`, `navigate`, `mutate`, `destructive`), preconditions, typed parameters, and executable browser steps — plus a **zero-AI action planner** (`planAction`) and **frame differ** (`diffFrames`).

## Quick Start

```bash
npm install
npm run build
npm test
```

## CLI Usage

```bash
# 1. Inspect Frame 1 (Structure) first
node dist/src/cli.js tests/fixtures/ecommerce.html --layer 1 --stats

# 2. Pull Frame 2 (Text) only for a specific landmark region (e.g. s4)
node dist/src/cli.js tests/fixtures/ecommerce.html --layer 2 --region s4

# 3. Inspect Frame 3 (Interactables) or Frame 4 (Actions)
node dist/src/cli.js tests/fixtures/ecommerce.html --layer 4 --url https://novastore.example.com

# 4. Run the zero-AI action planner for a goal
node dist/src/cli.js tests/fixtures/ecommerce.html --plan "search for laptops"

# 5. Diff two page states after executing an action
node dist/src/cli.js tests/fixtures/dashboard.html --diff tests/fixtures/dashboard-after.html

# 6. Launch the interactive 3D Layered Frame Visualizer
npm run visualizer
# or: node dist/src/cli.js serve --port 4173
```

## 3D Layered Frame Visualizer

Run `npm run visualizer` and open `http://127.0.0.1:4173` to inspect all 4 frames stacked in 3D space:

- **Pass any webpage**: Enter any live URL, paste raw HTML, or pick a built-in sample.
- **See what's beneath each frame**: Drag to orbit in 3D, expand the **Z-Axis Layer Gap**, drag the **Peel Upper Frames** slider to lift Frame 4/3/2 off the stack, or adjust per-layer opacity.
- **Cross-layer X-Ray**: Hover or click any card on any frame (e.g., a Frame 4 workflow `w1`) to illuminate its exact vertical lineage down through Frame 3 (Interactables), Frame 2 (Text), and Frame 1 (Structure) with glowing 3D connector beams.
- **Zero-AI Planner**: Enter a goal like `"search for laptops"` or `"add to cart"` to highlight the winning workflow and everything beneath it.

## Library Usage

```ts
import { FrameSession, parsePageFrames, planAction, diffFrames } from "frameparse";

const session = new FrameSession(html, { url: "https://novastore.example.com" });
const frame1 = session.getStructure();
const mainRegion = frame1.landmarks.find((l) => l.role === "main");
const frame2 = session.getText(mainRegion ? [mainRegion.id] : undefined);
const matches = session.plan("add to cart", { allowDestructive: false });
```

## Agentic-First MCP Server (Less Tokens, More Info)

FrameParse ships with a **zero-dependency MCP server** supporting both **stdio** and **Streamable HTTP (`POST /mcp`)**, exposing 7 token-minimal tools over stateful cached page sessions:

| MCP Tool | Purpose | Typical Cost |
|---|---|---|
| `frame_open` | Parse URL/HTML once, cache `sessionId`, return **Frame 1 (Structure)** only | ~120–250 tok |
| `frame_query` | Zero-AI cross-layer search for facts, prices, controls, or actions | ~80–180 tok |
| `frame_read` | Progressive region-scoped layer reader with hard `maxTokens` + pagination | Budgeted |
| `frame_plan` | Zero-AI goal-to-action planner with safety tiers & executable steps | ~120–250 tok |
| `frame_inspect` | Vertical cross-layer lineage X-ray for any ref (`s#`, `t#`, `i#`, `w#`, `a#`) | ~100–200 tok |
| `frame_diff` | Post-action delta (alerts, changed control states, new actions only) | ~40–150 tok |
| `frame_sessions` | List cached sessions + cumulative token savings telemetry | ~80 tok |

### Connect to Cursor / Claude Desktop

See `mcp.json.example`:

```json
{
  "mcpServers": {
    "frameparse": {
      "command": "node",
      "args": ["/agent/dist/src/cli.js", "mcp"]
    }
  }
}
```

Or connect via Streamable HTTP while running `npm run visualizer` at `http://127.0.0.1:4173/mcp`.

## Agent Skill

The AI agent skill is included at `skills/frameparse/SKILL.md` (and installed to `/cursor/stores/user/skills/frameparse/SKILL.md`).
