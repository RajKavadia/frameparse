/**
 * Popular browser-automation frameworks vs FrameParse
 * on identical local pages + agent tasks.
 *
 * Frameworks:
 *   - playwright-html     : page.content() dumped to the agent
 *   - playwright-a11y     : accessibility snapshot (role tree) dumped to the agent
 *   - puppeteer-html      : page.content() dump
 *   - puppeteer-a11y      : Accessibility.getFullAXTree via CDP
 *   - frameparse-frames   : live CDP snapshot → Frame 1 + query/plan (progressive)
 *
 * Metrics (AI-agent relevant):
 *   - observeTokens  : tokens the model would consume from the observation
 *   - observeMs      : time to produce that observation
 *   - actMs          : time to perform a simple action (fill/click) when applicable
 *   - foundAnswer    : observation contains the task needle
 *   - actOk          : action succeeded
 */
import { createServer, type Server } from "node:http";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { chromium as pwChromium, type Page as PwPage } from "playwright";
import puppeteer, { type Page as PpPage } from "puppeteer";
import {
  CdpBrowserDriver,
  estimateTokens,
  executeAct,
  formatFrame1ForAI,
  formatFrame3ForAI,
  parseLiveSnapshotFrames,
  FrameParseMcpServer,
} from "../src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");
const fixturesDir = path.join(root, "tests", "fixtures");
const outDir = path.join(root, ".cursor", "tmp");

const ecommerceHtml = readFileSync(path.join(fixturesDir, "ecommerce.html"), "utf8");
const dashboardHtml = readFileSync(path.join(fixturesDir, "dashboard.html"), "utf8");

type Framework =
  | "playwright-html"
  | "playwright-a11y"
  | "puppeteer-html"
  | "puppeteer-a11y"
  | "frameparse-frames";

interface Row {
  task: string;
  page: string;
  framework: Framework;
  observeMs: number;
  observeTokens: number;
  actMs: number | null;
  foundAnswer: boolean;
  actOk: boolean | null;
  notes: string;
}

function buildLargeSpa(n = 120): string {
  const cards = Array.from({ length: n }, (_, i) => `
    <article class="card" data-sku="SKU-${i + 1}">
      <h3>Developer Workstation #${i + 1}</h3>
      <p>Modular workstation with 64GB memory.</p>
      <div class="price">$${1299 + (i % 20) * 50}.00</div>
      <a href="/products/${i + 1}">View Product ${i + 1}</a>
      <button type="button" data-testid="buy-${i + 1}">Add to Cart</button>
    </article>`).join("\n");
  return `<!doctype html><html><head><title>Catalog ${n}</title>
  <style>${".x{display:flex}".repeat(800)}</style>
  <script>window.__STATE__="${"y".repeat(20000)}"</script>
  </head><body>
  <header><form role="search" action="/search"><label>Search</label>
  <input id="q" name="q" type="search" placeholder="Search..." />
  <button type="submit">Search</button></form></header>
  <main aria-label="Catalog">${cards}</main>
  </body></html>`;
}

async function serveFixtures(pages: Record<string, string>): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    const key = (req.url || "/").replace(/^\//, "") || "index";
    const html = pages[key] || pages["ecommerce"] || "<h1>missing</h1>";
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  const base = await new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
  return { server, base };
}

function axTreeToText(nodes: any[]): string {
  const byId = new Map<string, any>();
  for (const n of nodes) byId.set(String(n.nodeId ?? n.id), n);
  const lines: string[] = [];
  const walk = (n: any, depth: number) => {
    const role = n.role?.value || n.role || "";
    const name = n.name?.value || n.name || "";
    const val = n.value?.value || n.value || "";
    if (role || name) lines.push(`${"  ".repeat(depth)}${role}${name ? `: ${name}` : ""}${val ? ` = ${val}` : ""}`);
    const kids = n.childIds || n.children || [];
    for (const c of kids) {
      const child = typeof c === "object" ? c : byId.get(String(c));
      if (child) walk(child, depth + 1);
    }
  };
  const roots = nodes.filter((n) => !n.parentId);
  for (const r of roots.slice(0, 5)) walk(r, 0);
  if (!lines.length) {
    for (const n of nodes.slice(0, 400)) {
      const role = n.role?.value || n.role || "";
      const name = n.name?.value || n.name || "";
      if (role || name) lines.push(`${role}: ${name}`);
    }
  }
  return lines.join("\n");
}

async function pwA11yText(page: PwPage): Promise<string> {
  // Prefer Playwright aria snapshot; fall back to CDP AX tree
  try {
    return await page.locator("body").ariaSnapshot();
  } catch {
    const session = await page.context().newCDPSession(page);
    const { nodes } = (await session.send("Accessibility.getFullAXTree")) as { nodes: any[] };
    return axTreeToText(nodes);
  }
}

async function ppA11yText(page: PpPage): Promise<string> {
  const client = await page.createCDPSession();
  const { nodes } = (await client.send("Accessibility.getFullAXTree")) as { nodes: any[] };
  return axTreeToText(nodes);
}

function containsNeedle(text: string, needles: string[]): boolean {
  const lower = text.toLowerCase();
  return needles.every((n) => lower.includes(n.toLowerCase()));
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const largeHtml = buildLargeSpa(120);
  const pages = {
    ecommerce: ecommerceHtml,
    dashboard: dashboardHtml,
    large: largeHtml,
  };
  const { server, base } = await serveFixtures(pages);

  const tasks: Array<{
    name: string;
    path: string;
    needles: string[];
    act?: { kind: "fill-click-search" | "click-add-cart" | "click-login"; value?: string };
  }> = [
    {
      name: "Ecom: observe price $1,499",
      path: "ecommerce",
      needles: ["1,499"],
    },
    {
      name: "Ecom: fill search + click Search",
      path: "ecommerce",
      needles: ["search"],
      act: { kind: "fill-click-search", value: "laptops" },
    },
    {
      name: "Ecom: click Add to Cart",
      path: "ecommerce",
      needles: ["add to cart"],
      act: { kind: "click-add-cart" },
    },
    {
      name: "Dashboard: find Sign In",
      path: "dashboard",
      needles: ["sign in"],
      act: { kind: "click-login" },
    },
    {
      name: "Large SPA: find Workstation #77",
      path: "large",
      needles: ["77"],
    },
  ];

  const rows: Row[] = [];

  const pw = await pwChromium.launch({ headless: true });
  const pp = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  // Shared Chrome for FrameParse CDP (dedicated debugging port)
  const fpPort = 9464;
  const fpUser = path.join(outDir, "fp-bench-chrome");
  mkdirSync(fpUser, { recursive: true });
  const { spawn } = await import("node:child_process");
  const chromePath =
    process.env.CHROME_PATH ||
    (process.platform === "win32"
      ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
      : "google-chrome");
  const chromeProc = spawn(
    chromePath,
    [
      `--remote-debugging-port=${fpPort}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${fpUser}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--headless=new",
      "about:blank",
    ],
    { stdio: "ignore", detached: true },
  );
  chromeProc.unref();

  const fpDriver = new CdpBrowserDriver();
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      await fpDriver.connect({ browserURL: `http://127.0.0.1:${fpPort}` });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  if (!fpDriver.status().connected) {
    throw new Error("FrameParse CDP Chrome failed to start");
  }

  const mcp = new FrameParseMcpServer();

  try {
    for (const task of tasks) {
      const url = `${base}/${task.path}`;

      // --- Playwright HTML ---
      {
        const ctx = await pw.newContext();
        const page = await ctx.newPage();
        await page.goto(url, { waitUntil: "domcontentloaded" });
        const t0 = performance.now();
        const html = await page.content();
        const observeMs = Number((performance.now() - t0).toFixed(2));
        const observeTokens = estimateTokens(html);
        let actMs: number | null = null;
        let actOk: boolean | null = null;
        if (task.act) {
          const a0 = performance.now();
          try {
            if (task.act.kind === "fill-click-search") {
              await page.fill("#search-input, #q, input[type=search]", task.act.value || "");
              await page.click('[data-testid="search-submit"], button[type=submit]');
              actOk = true;
            } else if (task.act.kind === "click-add-cart") {
              await page.click('[data-testid="add-to-cart"]');
              actOk = true;
            } else if (task.act.kind === "click-login") {
              await page.click('[data-testid="login-btn"]');
              actOk = true;
            }
          } catch {
            actOk = false;
          }
          actMs = Number((performance.now() - a0).toFixed(2));
        }
        rows.push({
          task: task.name,
          page: task.path,
          framework: "playwright-html",
          observeMs,
          observeTokens,
          actMs,
          foundAnswer: containsNeedle(html, task.needles),
          actOk,
          notes: "full HTML dump",
        });
        await ctx.close();
      }

      // --- Playwright a11y ---
      {
        const ctx = await pw.newContext();
        const page = await ctx.newPage();
        await page.goto(url, { waitUntil: "domcontentloaded" });
        const t0 = performance.now();
        const text = await pwA11yText(page);
        const observeMs = Number((performance.now() - t0).toFixed(2));
        const observeTokens = estimateTokens(text);
        let actMs: number | null = null;
        let actOk: boolean | null = null;
        if (task.act) {
          const a0 = performance.now();
          try {
            if (task.act.kind === "fill-click-search") {
              await page.fill("#search-input, #q, input[type=search]", task.act.value || "");
              await page.click('[data-testid="search-submit"], button[type=submit]');
              actOk = true;
            } else if (task.act.kind === "click-add-cart") {
              await page.click('[data-testid="add-to-cart"]');
              actOk = true;
            } else if (task.act.kind === "click-login") {
              await page.click('[data-testid="login-btn"]');
              actOk = true;
            }
          } catch {
            actOk = false;
          }
          actMs = Number((performance.now() - a0).toFixed(2));
        }
        rows.push({
          task: task.name,
          page: task.path,
          framework: "playwright-a11y",
          observeMs,
          observeTokens,
          actMs,
          foundAnswer: containsNeedle(text, task.needles),
          actOk,
          notes: "a11y/aria tree dump",
        });
        await ctx.close();
      }

      // --- Puppeteer HTML ---
      {
        const page = await pp.newPage();
        await page.goto(url, { waitUntil: "domcontentloaded" });
        const t0 = performance.now();
        const html = await page.content();
        const observeMs = Number((performance.now() - t0).toFixed(2));
        const observeTokens = estimateTokens(html);
        let actMs: number | null = null;
        let actOk: boolean | null = null;
        if (task.act) {
          const a0 = performance.now();
          try {
            if (task.act.kind === "fill-click-search") {
              await page.type("#search-input, #q, input[type=search]", task.act.value || "");
              await page.click('[data-testid="search-submit"], button[type=submit]');
              actOk = true;
            } else if (task.act.kind === "click-add-cart") {
              await page.click('[data-testid="add-to-cart"]');
              actOk = true;
            } else if (task.act.kind === "click-login") {
              await page.click('[data-testid="login-btn"]');
              actOk = true;
            }
          } catch {
            actOk = false;
          }
          actMs = Number((performance.now() - a0).toFixed(2));
        }
        rows.push({
          task: task.name,
          page: task.path,
          framework: "puppeteer-html",
          observeMs,
          observeTokens,
          actMs,
          foundAnswer: containsNeedle(html, task.needles),
          actOk,
          notes: "full HTML dump",
        });
        await page.close();
      }

      // --- Puppeteer a11y ---
      {
        const page = await pp.newPage();
        await page.goto(url, { waitUntil: "domcontentloaded" });
        const t0 = performance.now();
        const text = await ppA11yText(page);
        const observeMs = Number((performance.now() - t0).toFixed(2));
        const observeTokens = estimateTokens(text);
        let actMs: number | null = null;
        let actOk: boolean | null = null;
        if (task.act) {
          const a0 = performance.now();
          try {
            if (task.act.kind === "fill-click-search") {
              await page.type("#search-input, #q, input[type=search]", task.act.value || "");
              await page.click('[data-testid="search-submit"], button[type=submit]');
              actOk = true;
            } else if (task.act.kind === "click-add-cart") {
              await page.click('[data-testid="add-to-cart"]');
              actOk = true;
            } else if (task.act.kind === "click-login") {
              await page.click('[data-testid="login-btn"]');
              actOk = true;
            }
          } catch {
            actOk = false;
          }
          actMs = Number((performance.now() - a0).toFixed(2));
        }
        rows.push({
          task: task.name,
          page: task.path,
          framework: "puppeteer-a11y",
          observeMs,
          observeTokens,
          actMs,
          foundAnswer: containsNeedle(text, task.needles),
          actOk,
          notes: "CDP Accessibility.getFullAXTree",
        });
        await page.close();
      }

      // --- FrameParse progressive frames ---
      {
        await fpDriver.navigate(url);
        const t0 = performance.now();
        const snap = await fpDriver.extractSnapshot();
        const parsed = parseLiveSnapshotFrames(snap, { url: snap.url, maxLayer: 4 });
        // Progressive agent payload: Frame1 + targeted query (not full dump)
        const f1 = formatFrame1ForAI(parsed.frame1);
        let extra = "";
        if (task.needles[0]) {
          // emulate frame_query density via MCP for fairness on same HTML path too
          await mcp.handleMessage({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "frame_open",
              arguments: { html: await (await fpDriver.contentHtml()).html, url, sessionId: `b_${task.path}` },
            },
          });
          const q = await mcp.handleMessage({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: {
              name: "frame_query",
              arguments: { sessionId: `b_${task.path}`, query: task.needles.join(" "), limit: 6 },
            },
          });
          extra = (q?.result as { content: Array<{ text: string }> }).content[0].text;
        }
        const payload = `${f1}\n\n${extra}`;
        const observeMs = Number((performance.now() - t0).toFixed(2));
        const observeTokens = estimateTokens(payload);
        let actMs: number | null = null;
        let actOk: boolean | null = null;
        if (task.act) {
          const a0 = performance.now();
          try {
            if (task.act.kind === "fill-click-search") {
              const input = parsed.frame3!.elements.find(
                (e) => e.inputType === "search" || e.fieldName === "q" || /search/i.test(e.name),
              );
              const btn = parsed.frame3!.elements.find(
                (e) => e.kind === "button" && /search/i.test(e.name),
              );
              await executeAct({
                driver: fpDriver,
                parsed,
                ref: input!.id,
                params: { value: task.act.value || "" },
                reobserve: false,
              });
              const afterSnap = await fpDriver.extractSnapshot();
              const after = parseLiveSnapshotFrames(afterSnap, { url: afterSnap.url, maxLayer: 4 });
              await executeAct({ driver: fpDriver, parsed: after, ref: btn!.id, reobserve: false });
              actOk = true;
            } else if (task.act.kind === "click-add-cart") {
              const btn = parsed.frame3!.elements.find((e) => /add to cart/i.test(e.name));
              await executeAct({ driver: fpDriver, parsed, ref: btn!.id, reobserve: false });
              actOk = true;
            } else if (task.act.kind === "click-login") {
              const btn = parsed.frame3!.elements.find((e) => /sign in/i.test(e.name) && e.kind === "button");
              await executeAct({ driver: fpDriver, parsed, ref: btn!.id, reobserve: false });
              actOk = true;
            }
          } catch {
            actOk = false;
          }
          actMs = Number((performance.now() - a0).toFixed(2));
        }
        rows.push({
          task: task.name,
          page: task.path,
          framework: "frameparse-frames",
          observeMs,
          observeTokens,
          actMs,
          foundAnswer: containsNeedle(payload + "\n" + formatFrame3ForAI(parsed.frame3!), task.needles),
          actOk,
          notes: "Frame1 + query (+ act via i#)",
        });
      }
    }
  } finally {
    await pw.close().catch(() => undefined);
    await pp.close().catch(() => undefined);
    await fpDriver.disconnect().catch(() => undefined);
    await new Promise<void>((r) => server.close(() => r()));
  }

  // Summaries
  const frameworks: Framework[] = [
    "playwright-html",
    "playwright-a11y",
    "puppeteer-html",
    "puppeteer-a11y",
    "frameparse-frames",
  ];
  const summary = frameworks.map((fw) => {
    const list = rows.filter((r) => r.framework === fw);
    const obsTok = list.reduce((s, r) => s + r.observeTokens, 0);
    const obsMs = list.reduce((s, r) => s + r.observeMs, 0);
    const acts = list.filter((r) => r.actOk !== null);
    const actOk = acts.filter((r) => r.actOk).length;
    const hits = list.filter((r) => r.foundAnswer).length;
    const rawBaseline = rows.filter((r) => r.framework === "playwright-html").reduce((s, r) => s + r.observeTokens, 0);
    return {
      framework: fw,
      tasks: list.length,
      answerHits: `${hits}/${list.length}`,
      actSuccess: acts.length ? `${actOk}/${acts.length}` : "n/a",
      totalObserveTokens: obsTok,
      vsPlaywrightHtml: `${(rawBaseline / Math.max(1, obsTok)).toFixed(1)}x`,
      totalObserveMs: Number(obsMs.toFixed(1)),
      avgObserveMs: Number((obsMs / list.length).toFixed(1)),
    };
  });

  console.log("=== AUTOMATION FRAMEWORKS vs FRAMEPARSE (agent observation + act) ===\n");
  console.log("--- Per-task ---");
  console.table(
    rows.map((r) => ({
      task: r.task,
      framework: r.framework,
      observeTokens: r.observeTokens,
      observeMs: r.observeMs,
      foundAnswer: r.foundAnswer,
      actMs: r.actMs,
      actOk: r.actOk,
      notes: r.notes,
    })),
  );
  console.log("\n--- Totals (lower observe tokens = better for AI agents) ---");
  console.table(summary);

  const outPath = path.join(outDir, "automation-bench.json");
  writeFileSync(outPath, JSON.stringify({ rows, summary, base, at: new Date().toISOString() }, null, 2));
  console.log(`\nWrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
