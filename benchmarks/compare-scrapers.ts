/**
 * Head-to-head: common scrape/extract baselines vs FrameParse MCP
 * on the same fixtures + agent tasks used by the existing suite.
 *
 * Baselines (agent-facing payload after scrape/extract):
 *   - raw-html: dump full HTML into the model
 *   - cheerio-text: strip scripts/styles, emit visible-ish text
 *   - jsdom-text: DOM textContent after removing script/style
 *   - readability: Mozilla Readability article extract
 *   - frameparse-mcp: progressive frame_open + query/plan/diff
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { FrameParseMcpServer, estimateTokens } from "../src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");
const fixturesDir = path.join(projectRoot, "tests", "fixtures");

const dashboardHtml = readFileSync(path.join(fixturesDir, "dashboard.html"), "utf8");
const dashboardAfterHtml = readFileSync(path.join(fixturesDir, "dashboard-after.html"), "utf8");
const ecommerceHtml = readFileSync(path.join(fixturesDir, "ecommerce.html"), "utf8");

type Framework =
  | "raw-html"
  | "cheerio-text"
  | "jsdom-text"
  | "readability"
  | "frameparse-mcp";

interface TaskResult {
  task: string;
  framework: Framework;
  latencyMs: number;
  outputTokens: number;
  foundAnswer: boolean;
  notes: string;
}

function buildSyntheticSpa(cardCount: number, cssNoiseRepeat: number, jsNoiseRepeat: number): string {
  const cards = Array.from(
    { length: cardCount },
    (_, i) => `
    <article class="card shadow-lg rounded-xl p-4 bg-white border border-slate-200" data-sku="SKU-${i + 1}">
      <h3>Developer Workstation #${i + 1}</h3>
      <p>Modular workstation with 64GB unified memory, NVMe RAID storage, and whisper-quiet thermal design.</p>
      <div class="price">$${1299 + (i % 20) * 50}.00</div>
      <a href="/products/${i + 1}" data-testid="view-${i + 1}">View Product ${i + 1}</a>
      <button type="button" data-testid="buy-${i + 1}">Add to Cart</button>
    </article>`,
  ).join("\n");

  const hugeState = JSON.stringify({
    hydrationPayload: "x".repeat(jsNoiseRepeat),
    flags: Array.from({ length: 50 }, (_, i) => `flag_${i}`),
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Enterprise Hardware Catalog (${cardCount} items)</title>
  <style>${".card-grid-item{display:flex;box-shadow:0 4px 12px rgba(0,0,0,.15);border-radius:12px;}".repeat(cssNoiseRepeat)}</style>
  <script>window.__NEXT_DATA__ = ${hugeState};</script>
</head>
<body>
  <header aria-label="Global Header">
    <nav aria-label="Main Navigation">
      <a href="/">Home</a><a href="/catalog">Catalog</a><a href="/pricing">Pricing</a><a href="/docs">Docs</a>
    </nav>
    <form id="catalog-search" role="search" action="/search" method="GET">
      <label for="q">Search catalog</label>
      <input id="q" name="q" type="search" placeholder="Search workstations..." required />
      <button type="submit">Search</button>
    </form>
  </header>
  <main aria-label="Catalog Grid">
    <h1>Hardware Catalog</h1>
    ${cards}
  </main>
  <footer><p>&copy; 2026 Enterprise Hardware Inc.</p></footer>
</body>
</html>`;
}

function extractCheerioText(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();
  return $("body").text().replace(/\s+/g, " ").trim();
}

function extractJsdomText(html: string): string {
  const dom = new JSDOM(html);
  const { document } = dom.window;
  document.querySelectorAll("script, style, noscript").forEach((el) => el.remove());
  return (document.body?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function extractReadability(html: string, url: string): string {
  const dom = new JSDOM(html, { url });
  const article = new Readability(dom.window.document).parse();
  if (!article) return "";
  return `${article.title}\n${article.textContent}`.replace(/\s+/g, " ").trim();
}

function containsNeedle(haystack: string, needles: string[]): boolean {
  const lower = haystack.toLowerCase();
  return needles.every((n) => lower.includes(n.toLowerCase()));
}

async function runFrameparse(
  mcp: FrameParseMcpServer,
  calls: Array<{ name: string; args: Record<string, unknown> }>,
): Promise<{ text: string; tokens: number; ms: number }> {
  const t0 = performance.now();
  const chunks: string[] = [];
  for (const call of calls) {
    const resp = await mcp.handleMessage({
      jsonrpc: "2.0",
      id: Math.random(),
      method: "tools/call",
      params: { name: call.name, arguments: call.args },
    });
    const text = (resp?.result as { content: Array<{ text: string }> }).content[0].text;
    chunks.push(text);
  }
  const text = chunks.join("\n");
  return { text, tokens: estimateTokens(text), ms: Number((performance.now() - t0).toFixed(2)) };
}

function timeExtract(fn: () => string): { text: string; ms: number; tokens: number } {
  const t0 = performance.now();
  const text = fn();
  return {
    text,
    ms: Number((performance.now() - t0).toFixed(2)),
    tokens: estimateTokens(text),
  };
}

async function compareTask(opts: {
  task: string;
  html: string;
  url: string;
  needles: string[];
  frameparseCalls: Array<{ name: string; args: Record<string, unknown> }>;
  mcp: FrameParseMcpServer;
  afterHtml?: string;
}): Promise<TaskResult[]> {
  const { task, html, url, needles, frameparseCalls, mcp } = opts;
  const rows: TaskResult[] = [];

  const raw = timeExtract(() => html);
  rows.push({
    task,
    framework: "raw-html",
    latencyMs: raw.ms,
    outputTokens: raw.tokens,
    foundAnswer: containsNeedle(raw.text, needles),
    notes: "full page dump",
  });

  const cheer = timeExtract(() => extractCheerioText(html));
  rows.push({
    task,
    framework: "cheerio-text",
    latencyMs: cheer.ms,
    outputTokens: cheer.tokens,
    foundAnswer: containsNeedle(cheer.text, needles),
    notes: "scripts/styles stripped",
  });

  const jsdom = timeExtract(() => extractJsdomText(html));
  rows.push({
    task,
    framework: "jsdom-text",
    latencyMs: jsdom.ms,
    outputTokens: jsdom.tokens,
    foundAnswer: containsNeedle(jsdom.text, needles),
    notes: "DOM textContent",
  });

  const read = timeExtract(() => extractReadability(html, url));
  rows.push({
    task,
    framework: "readability",
    latencyMs: read.ms,
    outputTokens: read.tokens,
    foundAnswer: containsNeedle(read.text, needles),
    notes: read.text ? "article extract" : "no article detected",
  });

  const fp = await runFrameparse(mcp, frameparseCalls);
  rows.push({
    task,
    framework: "frameparse-mcp",
    latencyMs: fp.ms,
    outputTokens: fp.tokens,
    foundAnswer: containsNeedle(fp.text, needles),
    notes: "progressive MCP tools",
  });

  return rows;
}

function summarize(rows: TaskResult[]) {
  const byFw = new Map<Framework, TaskResult[]>();
  for (const row of rows) {
    const list = byFw.get(row.framework) ?? [];
    list.push(row);
    byFw.set(row.framework, list);
  }

  return [...byFw.entries()].map(([framework, list]) => {
    const tokens = list.reduce((s, r) => s + r.outputTokens, 0);
    const ms = list.reduce((s, r) => s + r.latencyMs, 0);
    const hits = list.filter((r) => r.foundAnswer).length;
    const rawTokens = list
      .map((r) => rows.find((x) => x.task === r.task && x.framework === "raw-html")!.outputTokens)
      .reduce((s, n) => s + n, 0);
    return {
      framework,
      tasks: list.length,
      answerHits: `${hits}/${list.length}`,
      totalOutputTokens: tokens,
      vsRaw: `${(rawTokens / Math.max(1, tokens)).toFixed(1)}x fewer than raw`,
      totalLatencyMs: Number(ms.toFixed(2)),
    };
  });
}

async function main() {
  const largeHtml = buildSyntheticSpa(200, 1200, 60000);
  const mcp = new FrameParseMcpServer();
  const all: TaskResult[] = [];

  console.log("=== SCRAPER FRAMEWORKS vs FRAMEPARSE (same fixtures + agent tasks) ===\n");

  all.push(
    ...(await compareTask({
      task: "E-Commerce: find price $1,499",
      html: ecommerceHtml,
      url: "https://novastore.example.com/products/ultrabook-pro-14",
      needles: ["1,499"],
      mcp,
      frameparseCalls: [
        { name: "frame_open", args: { html: ecommerceHtml, url: "https://novastore.example.com", sessionId: "cmp_ecom" } },
        { name: "frame_query", args: { sessionId: "cmp_ecom", query: "1,499 price" } },
      ],
    })),
  );

  all.push(
    ...(await compareTask({
      task: "E-Commerce: locate Add to Cart control",
      html: ecommerceHtml,
      url: "https://novastore.example.com/products/ultrabook-pro-14",
      needles: ["add to cart"],
      mcp,
      frameparseCalls: [
        { name: "frame_plan", args: { sessionId: "cmp_ecom", goal: "add to cart" } },
      ],
    })),
  );

  all.push(
    ...(await compareTask({
      task: "Large SPA (~200 cards): find Workstation #142",
      html: largeHtml,
      url: "https://catalog.example.com",
      needles: ["142"],
      mcp,
      frameparseCalls: [
        { name: "frame_open", args: { html: largeHtml, url: "https://catalog.example.com", sessionId: "cmp_large" } },
        { name: "frame_query", args: { sessionId: "cmp_large", query: "Workstation 142", limit: 4 } },
      ],
    })),
  );

  // Diff task: baselines re-dump after-state; FrameParse emits delta only.
  {
    const task = "SaaS Dashboard: observe post-login change";
    const needles = ["Signed in successfully"];

    const raw = timeExtract(() => dashboardAfterHtml);
    all.push({
      task,
      framework: "raw-html",
      latencyMs: raw.ms,
      outputTokens: raw.tokens,
      foundAnswer: containsNeedle(raw.text, needles),
      notes: "full after-state dump",
    });

    for (const [framework, extract] of [
      ["cheerio-text", () => extractCheerioText(dashboardAfterHtml)],
      ["jsdom-text", () => extractJsdomText(dashboardAfterHtml)],
      ["readability", () => extractReadability(dashboardAfterHtml, "https://acme.example.com/settings")],
    ] as const) {
      const out = timeExtract(extract);
      all.push({
        task,
        framework,
        latencyMs: out.ms,
        outputTokens: out.tokens,
        foundAnswer: containsNeedle(out.text, needles),
        notes: "full after-state extract",
      });
    }

    await runFrameparse(mcp, [
      { name: "frame_open", args: { html: dashboardHtml, url: "https://acme.example.com/settings", sessionId: "cmp_dash" } },
    ]);
    const fp = await runFrameparse(mcp, [
      { name: "frame_diff", args: { sessionId: "cmp_dash", html: dashboardAfterHtml } },
    ]);
    all.push({
      task,
      framework: "frameparse-mcp",
      latencyMs: fp.ms,
      outputTokens: fp.tokens,
      foundAnswer: containsNeedle(fp.text, needles) || /signed in|\+text|alert/i.test(fp.text),
      notes: "delta-only frame_diff",
    });
  }

  console.log("--- Per-task results ---");
  console.table(
    all.map((r) => ({
      task: r.task,
      framework: r.framework,
      outputTokens: r.outputTokens,
      latencyMs: r.latencyMs,
      foundAnswer: r.foundAnswer,
      notes: r.notes,
    })),
  );

  console.log("\n--- Framework totals (lower tokens = better for agents) ---");
  console.table(summarize(all));

  const fpTotal = all.filter((r) => r.framework === "frameparse-mcp").reduce((s, r) => s + r.outputTokens, 0);
  const rawTotal = all.filter((r) => r.framework === "raw-html").reduce((s, r) => s + r.outputTokens, 0);
  const cheerTotal = all.filter((r) => r.framework === "cheerio-text").reduce((s, r) => s + r.outputTokens, 0);
  console.log(
    `\nVerdict: FrameParse emitted ${fpTotal} tokens across tasks vs raw ${rawTotal} (${(rawTotal / Math.max(1, fpTotal)).toFixed(1)}x) and cheerio ${cheerTotal} (${(cheerTotal / Math.max(1, fpTotal)).toFixed(1)}x).`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
