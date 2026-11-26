import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { FrameParseMcpServer, estimateTokens, parsePageFrames } from "../src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");
const fixturesDir = path.join(projectRoot, "tests", "fixtures");

const dashboardHtml = readFileSync(path.join(fixturesDir, "dashboard.html"), "utf8");
const dashboardAfterHtml = readFileSync(path.join(fixturesDir, "dashboard-after.html"), "utf8");
const ecommerceHtml = readFileSync(path.join(fixturesDir, "ecommerce.html"), "utf8");

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
  <meta name="description" content="Benchmark SPA page with ${cardCount} product cards and realistic inline CSS/JS noise." />
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

function stats(samples: number[]): { median: number; p95: number; mean: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return {
    median: Number(median.toFixed(2)),
    p95: Number(p95.toFixed(2)),
    mean: Number(mean.toFixed(2)),
  };
}

function benchmarkParser(name: string, html: string, iterations: number) {
  // Warmup
  parsePageFrames(html, { url: "https://bench.example.com", maxLayer: 4 });

  const f1Times: number[] = [];
  const fullTimes: number[] = [];
  let lastParsed = parsePageFrames(html, { url: "https://bench.example.com", maxLayer: 4 });

  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    parsePageFrames(html, { url: "https://bench.example.com", maxLayer: 1 });
    f1Times.push(performance.now() - t0);

    const t1 = performance.now();
    lastParsed = parsePageFrames(html, { url: "https://bench.example.com", maxLayer: 4 });
    fullTimes.push(performance.now() - t1);
  }

  const kb = Buffer.byteLength(html, "utf8") / 1024;
  const f1Stats = stats(f1Times);
  const fullStats = stats(fullTimes);
  const throughputMBs = Number(((kb / 1024) / (fullStats.median / 1000)).toFixed(1));

  return {
    name,
    sizeKB: Number(kb.toFixed(1)),
    rawTokens: lastParsed.metrics.estimatedRawTokens,
    f1Tokens: lastParsed.metrics.frame1Tokens,
    f1Compression: `${(lastParsed.metrics.estimatedRawTokens / Math.max(1, lastParsed.metrics.frame1Tokens)).toFixed(1)}x`,
    f1MedianMs: f1Stats.median,
    fullMedianMs: fullStats.median,
    fullP95Ms: fullStats.p95,
    throughputMBs,
  };
}

async function benchmarkAgenticTokenTasks(largeHtml: string) {
  const mcp = new FrameParseMcpServer();
  const callText = async (name: string, args: Record<string, unknown>) => {
    const t0 = performance.now();
    const resp = await mcp.handleMessage({
      jsonrpc: "2.0",
      id: Math.random(),
      method: "tools/call",
      params: { name, arguments: args },
    });
    const ms = Number((performance.now() - t0).toFixed(2));
    const text = (resp?.result as { content: Array<{ text: string }> }).content[0].text;
    return { text, tokens: estimateTokens(text), ms };
  };

  // Task 1: E-Commerce — find product price
  const ecomRawTok = estimateTokens(ecommerceHtml);
  const t1Open = await callText("frame_open", { html: ecommerceHtml, url: "https://novastore.example.com", sessionId: "b_ecom" });
  const t1Query = await callText("frame_query", { sessionId: "b_ecom", query: "1,499 price" });
  const t1Total = t1Open.tokens + t1Query.tokens;

  // Task 2: E-Commerce — plan "add to cart" (reusing cached session!)
  const t2Plan = await callText("frame_plan", { sessionId: "b_ecom", goal: "add to cart" });

  // Task 3: Large 200-card SPA (~190KB) — orient + find Product 142
  const largeRawTok = estimateTokens(largeHtml);
  const t3Open = await callText("frame_open", { html: largeHtml, url: "https://catalog.example.com", sessionId: "b_large" });
  const t3Query = await callText("frame_query", { sessionId: "b_large", query: "Workstation 142", limit: 4 });
  const t3Total = t3Open.tokens + t3Query.tokens;

  // Task 4: SaaS Dashboard — post-login state observation via frame_diff
  const dashAfterRawTok = estimateTokens(dashboardAfterHtml);
  await callText("frame_open", { html: dashboardHtml, url: "https://acme.example.com/settings", sessionId: "b_dash" });
  const t4Diff = await callText("frame_diff", { sessionId: "b_dash", html: dashboardAfterHtml });

  return [
    {
      task: "E-Commerce: Open + Find Price",
      rawHtmlTokens: ecomRawTok,
      mcpTokens: t1Total,
      savingsPct: `${(((ecomRawTok - t1Total) / ecomRawTok) * 100).toFixed(1)}%`,
      multiplier: `${(ecomRawTok / t1Total).toFixed(1)}x`,
      latencyMs: Number((t1Open.ms + t1Query.ms).toFixed(2)),
    },
    {
      task: "E-Commerce: Plan 'add to cart' (cached)",
      rawHtmlTokens: ecomRawTok,
      mcpTokens: t2Plan.tokens,
      savingsPct: `${(((ecomRawTok - t2Plan.tokens) / ecomRawTok) * 100).toFixed(1)}%`,
      multiplier: `${(ecomRawTok / t2Plan.tokens).toFixed(1)}x`,
      latencyMs: t2Plan.ms,
    },
    {
      task: "Large SPA (~190KB): Open + Query #142",
      rawHtmlTokens: largeRawTok,
      mcpTokens: t3Total,
      savingsPct: `${(((largeRawTok - t3Total) / largeRawTok) * 100).toFixed(1)}%`,
      multiplier: `${(largeRawTok / t3Total).toFixed(1)}x`,
      latencyMs: Number((t3Open.ms + t3Query.ms).toFixed(2)),
    },
    {
      task: "SaaS Dashboard: Post-Action frame_diff",
      rawHtmlTokens: dashAfterRawTok,
      mcpTokens: t4Diff.tokens,
      savingsPct: `${(((dashAfterRawTok - t4Diff.tokens) / dashAfterRawTok) * 100).toFixed(1)}%`,
      multiplier: `${(dashAfterRawTok / t4Diff.tokens).toFixed(1)}x`,
      latencyMs: t4Diff.ms,
    },
  ];
}

async function benchmarkStdioMcp() {
  const cliPath = path.join(projectRoot, "dist", "src", "cli.js");
  const child = spawn(process.execPath, [cliPath, "mcp"], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  const rl = readline.createInterface({ input: child.stdout });
  const pending = new Map<number, (val: unknown) => void>();
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const msg = JSON.parse(trimmed) as { id?: number };
    if (typeof msg.id === "number" && pending.has(msg.id)) {
      const resolve = pending.get(msg.id)!;
      pending.delete(msg.id);
      resolve(msg);
    }
  });

  let reqId = 1;
  const rpc = async (method: string, params?: Record<string, unknown>) => {
    const id = reqId++;
    const t0 = performance.now();
    const promise = new Promise<unknown>((resolve) => pending.set(id, resolve));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    await promise;
    return Number((performance.now() - t0).toFixed(2));
  };

  try {
    const results = [
      { call: "initialize", stdioMs: await rpc("initialize") },
      { call: "tools/list", stdioMs: await rpc("tools/list") },
      { call: "frame_open (ecommerce)", stdioMs: await rpc("tools/call", { name: "frame_open", arguments: { fixture: "ecommerce", sessionId: "s1" } }) },
      { call: "frame_query (warranty)", stdioMs: await rpc("tools/call", { name: "frame_query", arguments: { sessionId: "s1", query: "warranty" } }) },
      { call: "frame_read (layer 2, max 300tok)", stdioMs: await rpc("tools/call", { name: "frame_read", arguments: { sessionId: "s1", layer: 2, maxTokens: 300 } }) },
      { call: "frame_plan (search laptops)", stdioMs: await rpc("tools/call", { name: "frame_plan", arguments: { sessionId: "s1", goal: "search for laptops" } }) },
      { call: "frame_inspect (w1)", stdioMs: await rpc("tools/call", { name: "frame_inspect", arguments: { sessionId: "s1", ref: "w1" } }) },
      { call: "frame_open + frame_diff (dashboard)", stdioMs: (await rpc("tools/call", { name: "frame_open", arguments: { fixture: "dashboard", sessionId: "d1" } })) + (await rpc("tools/call", { name: "frame_diff", arguments: { sessionId: "d1", fixture: "dashboard-after" } })) },
      { call: "frame_sessions (list)", stdioMs: await rpc("tools/call", { name: "frame_sessions", arguments: { action: "list" } }) },
    ];
    return results;
  } finally {
    rl.close();
    child.kill();
  }
}

async function benchmarkHttpMcp(url = "http://127.0.0.1:4173/mcp") {
  const samples: number[] = [];
  const callHttp = async (method: string, params?: Record<string, unknown>) => {
    const t0 = performance.now();
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await res.json();
    return performance.now() - t0;
  };

  await callHttp("tools/call", { name: "frame_open", arguments: { fixture: "ecommerce", sessionId: "http_bench" } });
  for (let i = 0; i < 20; i++) {
    samples.push(
      await callHttp("tools/call", { name: "frame_plan", arguments: { sessionId: "http_bench", goal: "add to cart" } }),
    );
  }
  return stats(samples);
}

async function main() {
  const largeHtml = buildSyntheticSpa(200, 1200, 60000);
  const xlargeHtml = buildSyntheticSpa(800, 4000, 250000);

  console.log("=== 1. ZERO-AI PARSER LATENCY & THROUGHPUT ===");
  const parserRows = [
    benchmarkParser("Small (SaaS Dashboard)", dashboardHtml, 100),
    benchmarkParser("Medium (E-Commerce)", ecommerceHtml, 100),
    benchmarkParser("Large SPA (200 cards + JS/CSS)", largeHtml, 25),
    benchmarkParser("XLarge SPA (800 cards + JS/CSS)", xlargeHtml, 10),
  ];
  console.table(parserRows);

  console.log("\n=== 2. AGENTIC MCP TOKEN EFFICIENCY (RAW HTML vs FRAMEPARSE MCP) ===");
  const tokenRows = await benchmarkAgenticTokenTasks(largeHtml);
  console.table(tokenRows);

  console.log("\n=== 3. LIVE STDIO MCP ROUND-TRIP LATENCY (SPAWNED CHILD PROCESS) ===");
  const stdioRows = await benchmarkStdioMcp();
  console.table(stdioRows);

  console.log("\n=== 4. LIVE STREAMABLE HTTP MCP (/mcp, 20x frame_plan calls) ===");
  try {
    const httpStats = await benchmarkHttpMcp();
    console.table([{ endpoint: "http://127.0.0.1:4173/mcp", ...httpStats }]);
  } catch (err) {
    console.log(`HTTP MCP benchmark skipped (${err instanceof Error ? err.message : String(err)})`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
