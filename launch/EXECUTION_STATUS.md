# Launch execution status

Updated: 2026-11-27 (agent run)

## Completed (done)

| Step | Status | Notes |
|------|--------|-------|
| LICENSE, CONTRIBUTING, CI | ✅ | `.github/workflows/ci.yml` |
| README refresh | ✅ | CDP tools, plugin, demo GIF, benchmarks link |
| docs/BENCHMARKS.md, docs/MCP_REGISTRY.md | ✅ | |
| server.json draft | ✅ | Maintainer runs `mcp-publisher validate` |
| launch/ asset kit | ✅ | HN, PH, blog drafts |
| Merge tool-chain + remote CDP/plugin | ✅ | `main` @ `123b6b8` |
| v0.2.0 tag pushed | ✅ | `git push origin v0.2.0` |
| Tests | ✅ | 17/17 pass locally |
| Demo assets on main | ✅ | `docs/demo/frameparse-demo.gif` (from prior remote work) |

## Requires you (cannot automate from this agent)

| Step | Action |
|------|--------|
| **Show HN** | Post copy in [`HN_SHOW_HN.txt`](HN_SHOW_HN.txt) at https://news.ycombinator.com/submit |
| **GitHub Release** | Create release from tag `v0.2.0` on GitHub (UI: Releases → Draft new → attach notes from tag message) |
| **GitHub repo description** | Set: *Zero-LLM 4-layer webpage frames for AI agents (MCP)* |
| **GitHub topics** | Add `mcp-server`, `html-parser`, `token-optimization`; keep `playwright` only if you promote CDP path |
| **Social preview** | Upload `screenshots/01-ecommerce-frame1-structure.png` or visualizer shot in repo Settings → Social preview |
| **MCP Registry** | Follow `docs/MCP_REGISTRY.md` with `mcp-publisher publish` |
| **Glama / directories** | Submit GitHub URL after registry or README stable |
| **Product Hunt** | Use [`PRODUCT_HUNT.md`](PRODUCT_HUNT.md); schedule ≥3 days after HN |
| **Reddit** | Posts in [`FRAMEPARSE_LAUNCH_PACKAGE.md`](FRAMEPARSE_LAUNCH_PACKAGE.md) §6 — megathread only for r/LocalLLaMA |
| **LinkedIn / X** | Drafts in launch package §7–8 |
| **Blog** | Publish [`BLOG_DRAFT.md`](BLOG_DRAFT.md) to Dev.to/Hashnode |
| **Outreach** | §13 — send only after your review |

## Suggested immediate order

1. Create **GitHub Release** for `v0.2.0` (triggers star notifications).
2. Post **Show HN** (morning US).
3. Set repo **description + social preview**.
4. Publish blog + X thread same day or next.
5. MCP registry + Glama (day 2–3).
6. Product Hunt (day 5–7).