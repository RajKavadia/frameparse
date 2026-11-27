# Product Hunt launch sheet — FrameParse

## Core fields

**Name:** FrameParse

**Tagline (≤60 chars):** Progressive webpage frames for AI agents

**Description:**
FrameParse is an open-source TypeScript parser and MCP server that turns HTML into four agent-friendly layers—Structure, Text, Interactables, and Actions—so your model sees hundreds of tokens instead of a full DOM dump. Deterministic (no LLM in the parse path), session-cached MCP tools, zero-AI action planner, and post-click diffs. Includes a 3D visualizer to inspect how layers stack. MIT.

**Categories:** Developer Tools, Artificial Intelligence, Open Source

**Topics:** MCP, AI agents, browser automation, TypeScript

## Maker comment (first comment)

Hi PH — I'm Raj, builder of FrameParse.

I kept hitting context limits when wiring browser agents: the model was "reading" script tags and grid markup before it could answer simple questions. FrameParse is my attempt at a proper observation layer—like giving the agent a map and an index instead of the entire book.

It's early (just open-sourced, tests + benchmarks in repo). I'd love feedback from anyone building MCP workflows or Playwright agents: what would make this indispensable for you?

No upvotes needed—issues and real use cases help more.

## Gallery (5 images)

1. Hero — visualizer 3D stack (screenshots/01-ecommerce-frame1-structure.png)
2. Token comparison — benchmark terminal output
3. MCP tool list (8 tools)
4. frame_inspect lineage screenshot
5. Architecture diagram (from README draft mermaid export)

## Demo video (60s) — shot list

| Sec | Visual | Audio |
|-----|--------|-------|
| 0-8 | Scroll endless HTML in editor | "Agents shouldn't start here." |
| 8-18 | `npm run visualizer`, orbit 3D | "Four layers, cross-linked." |
| 18-30 | CLI `frame_open` + stats | "Frame one: structure only." |
| 30-42 | Cursor MCP `frame_plan` | "Plan without summarizing in an LLM." |
| 42-52 | `frame_diff` before/after | "After the click, diff—not dump." |
| 52-60 | GitHub URL | "MIT, contributors welcome." |

## FAQ

**Q: Does it click buttons?**  
A: It outputs selectors and steps; you bring Playwright/CDP.

**Q: Models required?**  
A: Not for parsing. Your agent LLM is separate.

**Q: How do I install?**  
A: Clone repo, Node 20+, npm install && npm run build.

**Q: npm package?**  
A: Coming; git install for now.

## PH compliance checklist

- [ ] No "upvote us" language
- [ ] Maker disclosed
- [ ] Working demo link (visualizer local or hosted GIF)
- [ ] Honest "early stage" positioning
- [ ] Schedule NOT same calendar day as Show HN (recommended)

## Launch-day engagement

- Reply to every comment within 2h
- Link benchmark reproduction steps when asked about numbers
- Escalate bug reports to GitHub issues publicly