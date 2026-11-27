# FrameParse — Full Launch & Growth Package

**Audit date:** 2026-11-27  
**Repo:** https://github.com/RajKavadia/frameparse  
**Launch branch (newest features):** https://github.com/RajKavadia/frameparse/tree/cursor/direct-tool-chain-783c  
**Default branch:** `main` (does not yet include `frame_chain`; merge or launch from feature branch)

**Status legend:** ✅ Done locally (not pushed unless you approve) · 📋 Draft only · ⛔ Needs your approval to execute

---

## Executive summary — highest-impact actions first

| Priority | Action | Reach | Effort | Approval |
|----------|--------|-------|--------|----------|
| P0 | Merge `cursor/direct-tool-chain-783c` → `main`, tag **v0.2.0**, add root `LICENSE` + `CONTRIBUTING.md` | Credibility | Low | ⛔ |
| P0 | Replace README with [`launch/README_DRAFT.md`](README_DRAFT.md) + add 30s screen recording (visualizer + MCP) | Conversion | Medium | ⛔ |
| P0 | Publish **Show HN** (Tue–Thu morning US) with benchmark numbers from `npm run benchmark` | High dev reach | Low | ⛔ |
| P1 | Official MCP Registry `server.json` + namespace verification (`io.github.RajKavadia/frameparse`) | Long-tail discovery | Medium | ⛔ |
| P1 | Glama “Add MCP Server” (GitHub repo link) | MCP audience | Low | ⛔ |
| P1 | Record GIF: raw HTML token count vs `frame_open` output side-by-side | Explain in 10s | Medium | ⛔ |
| P2 | Product Hunt (avoid same day as HN; follow PH rules: no upvote begging) | Broad | High | ⛔ |
| P2 | Dev.to / Hashnode blog (draft §16) | SEO | Medium | ⛔ |
| P2 | r/LocalLLaMA **bi-weekly Project Showcase** thread only (not standalone promo) | Agent builders | Low | ⛔ |
| P3 | Awesome-MCP PR, PulseMCP/mcp.so forms (verify each portal’s current submit UX) | Directory | Medium | ⛔ |

**Baseline metrics (verified 2026-11-27):** Stars **0**, Forks **0**, Open issues **0**, Contributors **1**, Tests **13/13 pass**, `npm run benchmark` reproducible locally.

---

## 1. Repository audit (verified)

### What FrameParse actually does

1. **Parses** static HTML, fetched URLs, built-in fixtures, or a **live DOM JSON snapshot** (`browser-adapter.ts`, `LIVE_DOM_EXTRACTOR_SCRIPT` MCP resource).
2. **Emits four linked frames:** Structure (`s#`), Text (`t#`), Interactables (`i#`), Actions (`w#`, `a#`) with cross-refs.
3. **Exposes** MCP (stdio + `POST /mcp`), HTTP visualizer (`/api/parse`, `/api/chain` on feature branch), CLI, and TypeScript library.
4. **Sessions:** `SessionStore` caches parses; agents call progressive tools instead of re-ingesting HTML.
5. **Planner:** `planAction` / `frame_plan` — keyword/heuristic ranking over Frame 4, not an LLM.
6. **Diff:** `frame_diff` post-mutation deltas + optional `ActionEffectCache` learning per origin.

### Strongest USPs (defensible)

- **Zero-LLM parse path** — sub‑ms to low‑ms on fixtures; benchmarked full parse ~6–35 ms on large synthetic SPAs.
- **Progressive disclosure** — Frame 1 first (~90–250 tok on samples), deeper layers on demand.
- **MCP-native agent loop** — purpose-built tools vs generic `fetch_html`.
- **Deterministic refs & lineage** — `frame_inspect` for vertical traceability.
- **Repeated-card folding** — Frame 1 collapses sibling patterns (tested: 120 articles → &lt;250 tok).
- **Live DOM snapshot path** — shadow DOM (declarative + adapter), iframes inlined in snapshot, div-soup clickables, visibility hints.

### Target audience

- MCP / Cursor / Claude Desktop agent builders
- Teams building browser agents who pay **token + latency** for raw HTML
- OSS contributors interested in **DOM distillation** and **structured observation**
- **Not** primary: non-technical marketers; teams wanting turnkey Playwright-in-the-box

### Problem solved

Agents waste context on layout noise, scripts, and duplicate cards; they lack stable refs tying structure → control → intended action. FrameParse compresses observation and standardizes the read/plan/observe loop.

### Differentiation (honest)

| Approach | vs FrameParse |
|----------|----------------|
| Raw HTML / `innerText` | No structure, no action tiers, huge tokens |
| Generic readability (Mozilla Readability, etc.) | Text-only; weak interactables/actions |
| Accessibility tree snapshots (CDP a11y) | Great for driving UI; verbose; different shape; FrameParse targets **token-budgeted agent text** |
| LLM “summarize this page” | Costly, non-deterministic |
| `browser-use` / agent frameworks | Often still page-level; FrameParse is a **parser + MCP layer** to sit underneath |

### Installation friction

- Requires **Node ≥ 20**, clone + `npm install && npm run build` (no npm package publish yet).
- MCP path must point to **absolute** `dist/src/cli.js` after build.
- **No CI** in repo — contributors cannot see green checks on GitHub.
- Launch URL confusion: best code on **feature branch**, `main` behind.

### Documentation weaknesses

- No “10-second” hero demo embedded in README (screenshots exist under `screenshots/` but not in README).
- No architecture diagram in published README (draft adds mermaid).
- Benchmark **methodology** not in README (only in `benchmarks/benchmark.ts`).
- Missing `LICENSE` file in tree (MIT in `package.json` only).
- No `CONTRIBUTING.md`, no GitHub Actions.
- GitHub **description empty**; topic `playwright` is **misleading** (no Playwright dependency).

### Missing demos / visuals

- No README demo GIF/video.
- No published npm install.
- Visualizer exists but not showcased on GitHub social preview.

### Claims to verify before marketing

| Claim | Status |
|-------|--------|
| 4-layer frames | ✅ Code + tests |
| 8 MCP tools incl. `frame_chain` | ✅ On `cursor/direct-tool-chain-783c` |
| 327× Frame 1 compression large SPA | ✅ `npm run benchmark` 2026-11-27 |
| 99.3% token savings open+query | ✅ Same benchmark; **MCP-emitted text vs raw HTML estimate** |
| “5–20×” in skill prose | ⚠️ Use benchmark table instead of range |
| Built-in browser automation | ❌ **Do not claim** — steps only |
| Playwright integration | ❌ Topic only; wire yourself |

### Security / reliability / compatibility

- `frame_open` URL fetch: SSRF risk if MCP exposed to untrusted users on a server — document **localhost / trusted use**.
- HTTP body limit 5 MB (`server.ts`).
- No dependency audit CI (`dependabot` disabled on GitHub).
- Live snapshot trust: malicious page could craft snapshot JSON — treat like unsanitized HTML.
- Cursor MCP config: stdio child process per connection (normal MCP pattern).

### Prioritized repo improvements (for your approval)

1. **LICENSE** (MIT text) + **CONTRIBUTING.md** + **GitHub Actions** (`npm test`, `npm run benchmark` optional).
2. **README** refresh ([`README_DRAFT.md`](README_DRAFT.md)).
3. **Merge** tool-chain branch; **release** v0.2.0 with notes.
4. **Fix topics:** remove `playwright` or add real Playwright example repo/docs.
5. **Add** `docs/BENCHMARKS.md` copying benchmark output + methodology.
6. **Social assets:** 1280×640 OG image (visualizer screenshot + token stats).
7. **npm publish** optional later (`frameparse` name).

---

## 2. GitHub presentation

### Completed (local drafts only — not committed)

- ✅ [`launch/README_DRAFT.md`](README_DRAFT.md) — hero, quick start, mermaid, limitations.

### Recommendations (metadata)

**Description (≤350 chars):**  
`Zero-LLM 4-layer webpage frames (Structure→Text→Interactables→Actions) for AI agents. MCP server, session cache, planner, diff. TypeScript.`

**Topics:** `mcp`, `mcp-server`, `ai-agents`, `html-parser`, `dom`, `web-automation`, `cursor`, `model-context-protocol`, `token-optimization`  
**Remove:** `playwright` unless you ship an example.

**Social preview:** Visualizer + caption “64k → 196 tokens (Frame 1)” from **your** benchmark run.

**Discoverability keywords:** MCP browser observation, DOM distillation, agent token reduction, frame_diff, structured page understanding.

---

## 3. Launch positioning

**One-liner:** FrameParse gives AI agents a progressive, deterministic view of the web without feeding the whole DOM to the model.

**Category:** Developer tool / MCP server / Agent infrastructure (not “autonomous browser”).

**Proof points:** Reproducible `npm run benchmark`; open MIT code; visualizer for skeptics.

---

## 4. Hacker News — Show HN

**Title options**

1. `Show HN: FrameParse – progressive webpage frames for agents (MCP, zero LLM parse)`
2. `Show HN: 64k-token HTML → 196-token structure map for browser agents`
3. `Show HN: MCP server that caches pages as Structure/Text/Controls/Actions`

**Recommended:** #1 (accurate; #2 is strong but cite “synthetic benchmark” in comment).

**Submission text (draft)**

> FrameParse is a small TypeScript library + MCP server that parses HTML/DOM into four cross-linked frames: Structure, Text, Interactables, and Actions. Agents start with ~150 tokens of landmarks (`frame_open`), then query, read budgeted layers, plan actions, and diff after clicks—without re-sending raw HTML.
>
> No LLM is used in the parser. On a synthetic 251KB SPA fixture, our benchmark reports ~64k estimated raw tokens vs 196 for Frame 1 (~328× on that layer). MCP stdio round-trips are ~1ms for most tools after cold start.
>
> Includes a 3D visualizer (`npm run visualizer`), live DOM snapshot script (for post-hydration pages), and optional multi-step `frame_chain` on the current feature branch.
>
> MIT: https://github.com/RajKavadia/frameparse
>
> I built this because agent loops were spending most of their context on layout/script noise before they could even find the “Add to cart” button. Feedback welcome—especially on false positives in action inference and destructive-action tiers.

**Likely questions & answers**

- *How is this different from Readability?* Text extraction only; we keep interactables, workflows, effect tiers, MCP sessions.
- *Does it drive the browser?* No—Frame 4 emits steps/selectors; you connect Playwright/CDP.
- *Tokenizer accuracy?* `estimateTokens` is char/4 heuristic—compare trends, not billing.
- *SPAs?* Inject extractor JS in real browser, pass snapshot JSON to `frame_open`.
- *Security?* Don’t expose URL-fetch MCP to untrusted multi-tenant without sandboxing.

**Comment strategy:** Reply with benchmarks, link to `benchmarks/benchmark.ts`, invite issues on false action labels; avoid arguing about % savings—offer reproducibility.

---

## 5. Product Hunt

**Name:** FrameParse  
**Tagline:** Progressive webpage frames for AI agents—without the HTML dump.  
**Description (short):** Open-source MCP server + parser: Structure → Text → Interactables → Actions. Zero LLM. Session cache. Plan and diff.  
**Categories:** Developer Tools, Artificial Intelligence, Open Source  
**Tags:** MCP, AI Agents, Browser Automation, Open Source, Developer Tools  

**Maker comment (draft):** Personal story (context waste on agent projects) + link visualizer + honest “early project, needs contributors” + ask for use cases not upvotes.

**Gallery plan:** (1) Visualizer 3D stack (2) Terminal `frame_open` output (3) Benchmark table screenshot (4) MCP tool list (5) Architecture diagram.

**Demo video storyboard (60s):** Problem 3s → raw HTML scroll 5s → FrameParse CLI 10s → visualizer X-ray 15s → MCP in Cursor 15s → CTA GitHub 7s.

**FAQ:** Browser built-in? No. Models required? No for parse. npm install? Clone for now. Cursor setup? `mcp.json.example`.

**PH rules:** No “please upvote,” no giveaways; disclose you’re the maker; first comment within an hour.

**Launch-day plan:** Respond to every comment; GitHub issue template ready; monitor HN-if-same-week separation (recommend **≥3 days** after Show HN).

---

## 6. Reddit (verify rules before posting — do not post without approval)

| Subreddit | Exists | Promo rules (summary) | Format | Recommend? |
|-----------|--------|----------------------|--------|------------|
| r/LocalLLaMA | Yes | 1/10 self-promo; disclosure | **Bi-weekly Project Showcase megathread** | ✅ Yes (thread only) |
| r/MachineLearning | Yes | Strict; research focus | Often removed for tools | ⚠️ Skip unless research angle |
| r/programming | Yes | No pure ads | Text post w/ technical depth | ⚠️ Risky as launch post |
| r/webdev | Yes | Check sidebar | Showcase / feedback | ⚠️ Frame as “library design feedback” |
| r/opensource | Yes | Project announcements allowed w/ substance | OSS release post | ✅ After v0.2.0 tag |
| r/mcp | Search if exists | MCP-specific | Tool announcement | ✅ If community active |
| r/Cursor | Unofficial subs vary | Check each | MCP setup guide | ⚠️ Verify sub rules |

**r/LocalLLaMA megathread post (draft)**  
Title: `[Project] FrameParse – MCP server for token-budgeted page structure (zero-LLM parse)`  
Body: Technical description + benchmark caveat + ask for agent-loop feedback + GitHub link. **Disclose:** author.

**r/opensource (draft)**  
Title: `FrameParse – MIT MCP server that parses pages into 4 agent-friendly frames`  
Body: Problem, architecture, what’s implemented, roadmap, how to contribute. **Not** a copy-paste of LocalLLaMA post.

**Timing:** US morning weekdays; avoid launching same hour as HN.

---

## 7. LinkedIn

**Version A (technical):** Benchmark table + architecture + MCP loop; link GitHub.  
**Version B (story):** “We kept hitting token limits on browser agents…” + lesson learned.  
**Version C (short):** 3 paragraphs + visualizer screenshot.

**Carousel (6 slides):** Problem → 4 frames diagram → MCP tools → benchmark (1 slide, sourced) → visualizer → CTA star/repo.

**Hashtags (sparingly):** `#MCP` `#AIAgents` `#OpenSource` `#DeveloperTools` `#TypeScript`

**Week-later follow-up:** “What we learned from Show HN / first issues” (only after real feedback).

---

## 8. X (Twitter)

**Launch post:** One-liner + visualizer GIF + GitHub link.

**Thread (8 tweets):**

1. Hook: agents don’t need 64k tokens of div soup  
2. 4 frames explained  
3. `frame_open` only returns structure  
4. `frame_query` / `frame_read` budgets  
5. `frame_plan` + destructive tier warning  
6. `frame_diff` after actions  
7. Benchmark **447 vs 64257** on synthetic SPA (cite benchmark harness)  
8. MIT, early project, contributors welcome

**Benchmark post (standalone):** Screenshot of benchmark table only—caption “synthetic SPA fixture; reproduce with `npm run benchmark`.”

**Engagement:** Reply in MCP/Claude/Cursor threads when relevant; **no** mass @mentions.

---

## 9. Developer communities (distribution plan)

| Platform | URL | Audience | Fit | Submit | Priority |
|----------|-----|----------|-----|--------|----------|
| MCP Discord (official) | modelcontextprotocol.io community links | MCP builders | High | Channel #showcase when allowed | 9 |
| Anthropic MCP docs discussion | GitHub discussions | Protocol | Medium | Issue/Discussion | 7 |
| LangChain / LangGraph Discord | Various | Agent devs | Medium | #tools after rules read | 6 |
| Browser-use Discord | Project discord | Browser agents | High | Integration example | 8 |
| DevOps Weekly / Changelog | Newsletters | Devs | Medium | Pitch “agent infra” | 5 |
| Console.dev | console.dev | OSS tools | Medium | Submit product | 6 |
| Awesome MCP lists | GitHub search `awesome-mcp` | Discovery | High | PR adding entry | 8 |
| Cursor Forum | forum.cursor.com | Cursor users | High | “How I wired FrameParse MCP” | 9 |

---

## 10. MCP & tool directories

### Official MCP Registry

- **Active:** Yes (modelcontextprotocol/registry).  
- **Qualifies:** Open-source GitHub MIT; stdio MCP.  
- **Method:** `mcp-publisher` CLI + `server.json` schema + namespace proof (`io.github.RajKavadia/...`).  
- **Action:** Prepare `server.json` (draft below) — **verify schema version** at publish time against registry docs.  
- **Note:** Remote `http://127.0.0.1` URLs may fail public registry validation; prefer **stdio package** entry.

**Short listing:** Token-budgeted webpage frames for agents (Structure/Text/Interactables/Actions).  
**Long listing:** See README draft.  
**Tags:** browser, html, agents, automation, parsing  

### Glama (glama.ai)

- **Submit:** “Add MCP Server” + GitHub repo (per Glama FAQ).  
- **Content:** Same as short/long; screenshot visualizer.

### Smithery / mcp.so / PulseMCP

- **Verify** current submit forms (third-party blogs list them as free directories; confirm on each site before filling).  
- **Listing copy:** Reuse MCP registry text; unique first sentence per site to avoid duplicate-content filters.

### Awesome lists

- PR to `awesome-mcp-servers` or similar with one paragraph + link.

**`server.json` skeleton (validate before publish):**

```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  "name": "io.github.rajkavadia/frameparse",
  "description": "Zero-LLM 4-layer webpage parser and MCP server for AI agent browsing.",
  "repository": {
    "url": "https://github.com/RajKavadia/frameparse",
    "source": "github"
  },
  "version": "0.2.0",
  "packages": [
    {
      "registryType": "npm",
      "identifier": "frameparse",
      "version": "0.2.0",
      "transport": {
        "type": "stdio",
        "command": "node",
        "args": ["{absolutePath}/dist/src/cli.js", "mcp"]
      }
    }
  ]
}
```

*(Adjust name namespace, npm vs git package transport per current registry schema—run `mcp-publisher validate`.)*

---

## 11. Content & demo strategy (storyboards)

### 30s demo

0–5s: Terminal `wc` / token estimate on fixture HTML  
5–12s: `frame_open` output scroll  
12–22s: Visualizer peel layers + X-ray  
22–30s: “github.com/RajKavadia/frameparse” overlay  

**Narration:** “Same page. Agent sees structure first—not sixty thousand tokens of markup.”

### 60s technical

Add `frame_plan` + `frame_diff` on dashboard-after fixture.

### Before/after split screen

Left: raw HTML; Right: Frame 1 formatted text; counter overlay from `estimateTokens`.

### Real browser-agent workflow

Show: extractor JS in DevTools → snapshot → MCP `frame_open` → plan → **your** Playwright click (external).

### Benchmark viz

Bar chart: raw vs MCP tasks from benchmark section 2 (use exact numbers from latest run).

### Quick-start tutorial (video)

Clone → build → mcp.json → one `frame_query` in Cursor.

**CTA all:** Star + try visualizer + open issue.

---

## 12. Technical blog

**Title:** Why AI Browser Agents Don’t Need to Read Every Line of HTML  

**Outline:** Observation problem → token economics → structured layers → FrameParse architecture → MCP workflow → benchmark methodology (`estimateTokens`, synthetic SPA) → limitations (no driver, heuristics) → future (npm, CI, community).  

**Dev.to / Hashnode / Medium:**  
- Dev.to: tags `#mcp` `#ai` `#opensource`, canonical URL if cross-posting.  
- Hashnode: map to personal blog.  
- Medium: paywall off; use friend link sparingly.  

**Full article draft:** see [`launch/BLOG_DRAFT.md`](BLOG_DRAFT.md) (companion file).

---

## 13. Outreach (drafts only — do not send)

| Target | URL | Relevance | Angle | Draft opener |
|--------|-----|-----------|-------|----------------|
| MCP registry maintainers | github.com/modelcontextprotocol/registry | Protocol | List quality | “Prepared server.json—seeking validation tips for stdio-only TS server” |
| Glama team | glama.ai contact | Directory | Listing | “New OSS MCP for DOM distillation—fits agent browsing category” |
| Browser-use maintainers | github.com/browser-use/browser-use | Agents | Complement | “FrameParse as observation layer before your planner—interested in example?” |
| Firecrawl / similar | Product sites | Scraping | Differentiation | “We compress cached DOM for agents, not crawl at scale—complementary?” |
| Latent Space newsletter | latent.space | AI eng | Guest/tool | Pitch short blurb + benchmark reproducibility |
| Simon Willison (if OSS note fits) | simonwillison.net | MCP blogging | Technical | “Show HN-style technical post on deterministic page frames” |
| Cursor team | forum / X | Integration | MCP | “Setup guide for frameparse MCP—any directory?” |

**No** cold DMs to individuals without public “contact for tools” signals.

---

## 14. 14-day launch calendar

| Day | Platform | Content | Goal | CTA | Asset | Expected | Status |
|-----|----------|---------|------|-----|-------|----------|--------|
| D0 | GitHub | Merge + tag v0.2.0 | Clean main | Clone | Release notes | Baseline | ⛔ |
| D1 | HN Show HN | §4 post | Developers | Try benchmark | — | Discussion | ⛔ |
| D2 | GitHub | README + LICENSE | Stars | Star | README draft | +traffic | ⛔ |
| D3 | X | Thread §8 | Reach | GitHub | GIF | Followers | ⛔ |
| D4 | Dev.to | Blog | SEO | Install | Article | Reads | ⛔ |
| D5 | MCP Registry | Submit server.json | Discovery | Install | server.json | Listing | ⛔ |
| D6 | Glama | Add server | MCP users | Connect | Screenshot | Listing | ⛔ |
| D7 | Reddit | LocalLLaMA thread | Agents | Feedback | Unique post | Comments | ⛔ |
| D8 | LinkedIn | Post B | Founders | Star | Carousel | DMs | ⛔ |
| D9 | Awesome MCP PR | List entry | Long-tail | PR merge | — | Stars | ⛔ |
| D10 | Product Hunt | Launch | Broad | Try | Gallery | Votes organic | ⛔ |
| D11 | r/opensource | Release post | OSS | Contribute | — | Issues | ⛔ |
| D12 | YouTube / X | 60s demo | Proof | Visualizer | Video | Views | ⛔ |
| D13 | Follow-up X | Lessons learned | Trust | Issues | — | Engagement | ⛔ |
| D14 | Newsletter pitch | Console.dev etc. | Spike | Link | Blurb | Referrals | ⛔ |

---

## 15. Analytics & growth

**Baseline (2026-11-27):** Stars 0, forks 0, issues 0, clones unknown (enable GitHub traffic insights if not already).

**Track daily:** Stars/forks, referral sources (GitHub traffic), HN/PH comment count, visualizer demo views (if hosted).

**Track weekly:** New issues/PRs, directory listing status, benchmark regressions, npm download (if published).

**Experiments:** README A/B (hero with vs without GIF); HN title variant on next milestone only if first post flops.

**Do not claim** causality without UTM (`?utm_source=hn` etc.) on links.

---

## 16. Launch checklist

- [ ] Merge feature branch, tag release  
- [ ] LICENSE + CONTRIBUTING + CI  
- [ ] README + social preview image  
- [ ] 30s demo recorded  
- [ ] `mcp-publisher validate` on server.json  
- [ ] Show HN drafted & scheduled  
- [ ] PH assets (not same day as HN)  
- [ ] Reddit rules rechecked  
- [ ] Directory submissions queued  
- [ ] Issue templates (bug, false action label)  
- [ ] UTM links prepared  

---

## 17. Risk & credibility review

| Risk | Mitigation |
|------|------------|
| Overclaiming token savings | Always “synthetic fixture; run `npm run benchmark`” |
| Playwright topic mismatch | Remove topic or add example |
| No browser built-in | Lead with observation layer positioning |
| SSRF via `frame_open` URL | Document trusted deployment |
| Early 0-star repo | Emphasize MIT + tests + visualizer |
| Branch confusion | Launch from `main` after merge |

---

## 18. Approval queue (ready for your go/no-go)

1. ⛔ Push README_DRAFT + LICENSE + CONTRIBUTING + CI  
2. ⛔ Merge `cursor/direct-tool-chain-783c` and tag v0.2.0  
3. ⛔ Post Show HN (paste §4)  
4. ⛔ Submit MCP registry / Glama  
5. ⛔ Publish blog Dev.to  
6. ⛔ Post Reddit megathread  
7. ⛔ Product Hunt launch  
8. ⛔ Send outreach emails/DMs from §13  

---

## 19. File index (local drafts)

| File | Purpose |
|------|---------|
| `launch/FRAMEPARSE_LAUNCH_PACKAGE.md` | This document |
| `launch/README_DRAFT.md` | Proposed README replacement |
| `launch/BLOG_DRAFT.md` | Full blog article |
| `launch/HN_SHOW_HN.txt` | Copy-paste HN |
| `launch/PRODUCT_HUNT.md` | PH fields |
| `screenshots/*.png` | Existing frame visuals |

**Nothing in `launch/` has been committed or pushed.**

---

## 20. Verified benchmark snapshot (2026-11-27)

```
Large SPA (200 cards): raw 64,257 tok → Frame 1 196 tok (327.8×)
MCP open+query same page: 447 tok vs 64,257 raw (99.3% fewer in harness)
E-Commerce fixture open+plan cached: 227 tok vs 833 raw (72.7% fewer)
stdio frame_query round-trip: ~1.02 ms (after cold initialize ~48 ms)
```

Reproduce: `npm run benchmark` in repo root.