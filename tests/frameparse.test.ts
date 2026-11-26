import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ActionEffectCache,
  FrameParseMcpServer,
  FrameSession,
  LIVE_DOM_EXTRACTOR_SCRIPT,
  diffFrames,
  formatDiffForAI,
  formatFrame1ForAI,
  formatFramesForAI,
  parseLiveSnapshotFrames,
  parsePageFrames,
  planAction,
  startVisualizerServer,
} from "../src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(__dirname, "../../tests/fixtures");

const ecommerceHtml = readFileSync(path.join(fixturesDir, "ecommerce.html"), "utf8");
const dashboardHtml = readFileSync(path.join(fixturesDir, "dashboard.html"), "utf8");
const dashboardAfterHtml = readFileSync(path.join(fixturesDir, "dashboard-after.html"), "utf8");

test("Frame 1: extracts semantic landmarks, metadata, outline, and strips noise", () => {
  const parsed = parsePageFrames(ecommerceHtml, {
    url: "https://novastore.example.com/products/ultrabook-pro-14",
    maxLayer: 1,
  });

  assert.equal(parsed.frame1.meta.title, "NovaStore — UltraBook Pro 14");
  assert.equal(parsed.frame1.meta.lang, "en");
  assert.match(parsed.frame1.meta.description ?? "", /UltraBook Pro 14/);
  assert.equal(parsed.frame1.meta.canonical, "https://novastore.example.com/products/ultrabook-pro-14");
  assert.equal(parsed.frame1.meta.structureHash.length, 8);

  const roles = parsed.frame1.landmarks.map((l) => l.role);
  assert.ok(roles.includes("header"));
  assert.ok(roles.includes("nav"));
  assert.ok(roles.includes("main"));
  assert.ok(roles.includes("article"));
  assert.ok(roles.includes("form"));
  assert.ok(roles.includes("aside"));
  assert.ok(roles.includes("footer"));

  assert.equal(parsed.frame2, undefined);
  assert.equal(parsed.frame3, undefined);
  assert.equal(parsed.frame4, undefined);
});

test("Frame 2: extracts clean text, table rows, alerts, and excludes hidden/script text", () => {
  const parsed = parsePageFrames(ecommerceHtml, {
    url: "https://novastore.example.com/products/ultrabook-pro-14",
    maxLayer: 2,
  });

  assert.ok(parsed.frame2);
  const allText = parsed.frame2.blocks.map((b) => b.text).join("\n");

  assert.match(allText, /UltraBook Pro 14/);
  assert.match(allText, /\$1,499\.00/);
  assert.match(allText, /In stock — ships within 24 hours/);
  assert.match(allText, /Weight \| 1\.24 kg/);
  assert.match(allText, /© 2026 NovaStore Inc\./);

  // Script, CSS, and hidden content must never leak into Frame 2
  assert.doesNotMatch(allText, /__INITIAL_STATE__/);
  assert.doesNotMatch(allText, /Secret hidden banner/);
  assert.doesNotMatch(allText, /Hidden via inline style/);

  const alertBlock = parsed.frame2.blocks.find((b) => b.kind === "alert");
  assert.ok(alertBlock);
  assert.match(alertBlock.text, /In stock/);
});

test("Frame 3: builds interactable registry with names, states, options, form links, and selectors", () => {
  const parsed = parsePageFrames(ecommerceHtml, {
    url: "https://novastore.example.com/products/ultrabook-pro-14",
    maxLayer: 3,
  });

  assert.ok(parsed.frame3);
  const els = parsed.frame3.elements;

  // Hidden SKU input must be excluded
  assert.equal(els.find((e) => e.fieldName === "sku"), undefined);

  // Search input resolved via <label for="search-input">
  const searchInput = els.find((e) => e.fieldName === "q");
  assert.ok(searchInput);
  assert.equal(searchInput.name, "Search catalog");
  assert.equal(searchInput.inputType, "search");
  assert.equal(searchInput.state.required, true);
  assert.ok(searchInput.formId);

  // Memory select with options
  const ramSelect = els.find((e) => e.fieldName === "ram");
  assert.ok(ramSelect);
  assert.equal(ramSelect.kind, "select");
  assert.equal(ramSelect.options?.length, 3);
  assert.equal(ramSelect.value, "16gb");

  // Add to cart button uses data-testid as primary selector
  const addToCart = els.find((e) => e.name === "Add to Cart");
  assert.ok(addToCart);
  assert.equal(addToCart.selector, '[data-testid="add-to-cart"]');

  // Spec sheet link resolves full URL
  const specLink = els.find((e) => e.name === "Download Spec Sheet");
  assert.ok(specLink);
  assert.equal(specLink.href, "https://docs.novastore.example.com/specs.pdf");
});

test("Frame 4: infers deterministic actions, form workflows, side effects, and zero-AI planner", () => {
  const ecom = parsePageFrames(ecommerceHtml, {
    url: "https://novastore.example.com/products/ultrabook-pro-14",
  });
  assert.ok(ecom.frame4);

  // Workflows synthesized for search form and purchase form
  assert.equal(ecom.frame4.workflows.length, 2);

  const searchWorkflow = ecom.frame4.workflows.find((w) => w.category === "search");
  assert.ok(searchWorkflow);
  assert.equal(searchWorkflow.destination?.method, "GET");
  assert.equal(searchWorkflow.steps.length, 3); // fill q, select category, click submit

  const commerceWorkflow = ecom.frame4.workflows.find((w) => w.category === "commerce");
  assert.ok(commerceWorkflow);
  assert.equal(commerceWorkflow.effect, "mutate");
  assert.equal(commerceWorkflow.destination?.method, "POST");

  // Download link recognized deterministically
  const downloadAct = ecom.frame4.actions.find((a) => a.verb === "download");
  assert.ok(downloadAct);
  assert.equal(downloadAct.destination?.isDownload, true);

  // Zero-AI planner matches search and buy intents
  const searchPlan = planAction(ecom.frame4, "search for laptops");
  assert.ok(searchPlan.length > 0);
  assert.equal(searchPlan[0].action.id, searchWorkflow.id);

  const buyPlan = planAction(ecom.frame4, "add to cart purchase");
  assert.ok(buyPlan.length > 0);
  assert.equal(buyPlan[0].action.id, commerceWorkflow.id);

  // Dashboard destructive & auth classification
  const dash = parsePageFrames(dashboardHtml, { url: "https://acme.example.com/settings" });
  assert.ok(dash.frame4);

  const loginWorkflow = dash.frame4.workflows.find((w) => w.category === "auth");
  assert.ok(loginWorkflow);
  assert.equal(loginWorkflow.effect, "mutate");
  assert.equal(loginWorkflow.preconditions.length, 2); // email + password required

  const deleteAct = dash.frame4.actions.find((a) => a.effect === "destructive");
  assert.ok(deleteAct);
  assert.equal(deleteAct.category, "crud_delete");

  // Planner respects allowDestructive: false
  const safePlan = planAction(dash.frame4, "delete workspace", { allowDestructive: false });
  assert.equal(safePlan.some((m) => m.action.effect === "destructive"), false);

  // Disabled button flagged in preconditions
  const archiveAct = dash.frame4.actions.find((a) => a.summary.includes("Archive Workspace"));
  assert.ok(archiveAct);
  assert.ok(archiveAct.preconditions.some((p) => p.includes("disabled")));
});

test("Progressive FrameSession & region scoping reduces tokens dramatically", () => {
  const session = new FrameSession(ecommerceHtml, {
    url: "https://novastore.example.com/products/ultrabook-pro-14",
  });

  const mainLandmark = session.frame1.landmarks.find((l) => l.role === "main");
  assert.ok(mainLandmark);

  const fullText = session.getText();
  const mainOnlyText = session.getText([mainLandmark.id]);

  assert.ok(mainOnlyText.totalBlocks > 0);
  assert.ok(mainOnlyText.totalBlocks < fullText.totalBlocks);
  assert.ok(mainOnlyText.blocks.every((b) => !b.text.includes("NovaStore Inc.")));

  const mainActions = session.getActions([mainLandmark.id]);
  assert.equal(mainActions.workflows.length, 1); // only purchase form, not header search form
});

test("Frame diffing detects added alerts, removed forms, and enabled buttons", () => {
  const before = parsePageFrames(dashboardHtml, { url: "https://acme.example.com/settings" });
  const after = parsePageFrames(dashboardAfterHtml, { url: "https://acme.example.com/settings" });
  const diff = diffFrames(before, after);

  assert.equal(diff.structureChanged, true);
  assert.ok(diff.addedTextBlocks.some((b) => b.text.includes("Signed in successfully")));
  assert.ok(diff.removedInteractableIds.length >= 4); // login form + inputs removed

  const archiveChange = diff.changedInteractables.find((c) => c.name === "Archive Workspace");
  assert.ok(archiveChange);
  assert.deepEqual(archiveChange.changes.disabled, { before: true, after: false });

  const formattedDiff = formatDiffForAI(diff);
  assert.match(formattedDiff, /Signed in successfully/);
});

test("Performance & compression benchmark on large synthetic HTML (~180KB)", () => {
  const cards = Array.from({ length: 200 }, (_, i) => `
    <article class="card shadow-lg rounded-xl p-4 bg-white">
      <h3>Product Item #${i + 1}</h3>
      <p>High-performance developer hardware with modular expansion ports and silent cooling.</p>
      <a href="/products/${i + 1}" data-testid="view-${i + 1}">View Product ${i + 1}</a>
      <button type="button" data-testid="buy-${i + 1}">Add to Cart</button>
    </article>
  `).join("\n");

  const largeHtml = `<!DOCTYPE html><html><head><title>Catalog</title><style>${".x{color:red}".repeat(2000)}</style><script>${"var a=1;".repeat(4000)}</script></head><body><main>${cards}</main></body></html>`;

  const parsed = parsePageFrames(largeHtml, { url: "https://shop.example.com/catalog" });
  const aiOutput = formatFramesForAI(parsed);

  assert.ok(parsed.timingsMs.total < 200, `Expected <200ms, got ${parsed.timingsMs.total}ms`);
  const frame1Compression = parsed.metrics.estimatedRawTokens / parsed.metrics.frame1Tokens;
  assert.ok(frame1Compression > 8, `Expected Frame 1 compression >8x, got ${frame1Compression.toFixed(2)}x`);
  assert.ok(parsed.metrics.compressionRatio > 1.0, `Expected full 4-frame compression >1.0x, got ${parsed.metrics.compressionRatio}x`);
  assert.ok(aiOutput.includes("# FRAME 1: STRUCTURE"));
  assert.ok(aiOutput.includes("# FRAME 4: ACTIONS"));
});

test("3D Visualizer server serves HTML UI, fixtures, and /api/parse with zero-AI planner", async () => {
  const { server, url } = await startVisualizerServer(0, "127.0.0.1");
  try {
    const htmlRes = await fetch(`${url}/`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.match(html, /FrameParse 3D/);
    assert.match(html, /Frame 1 — Structure/);
    assert.match(html, /Frame 4 — Actions/);

    const fixRes = await fetch(`${url}/api/fixtures`);
    assert.equal(fixRes.status, 200);
    const fixJson = (await fixRes.json()) as { fixtures: Array<{ id: string }> };
    assert.ok(fixJson.fixtures.some((f) => f.id === "ecommerce"));

    const parseRes = await fetch(`${url}/api/parse`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fixture: "ecommerce", goal: "search for laptops" }),
    });
    assert.equal(parseRes.status, 200);
    const parseJson = (await parseRes.json()) as {
      parsed: { frame1: { landmarks: unknown[] }; frame4: { workflows: unknown[] } };
      planned: Array<{ action: { id: string; category: string } }>;
      aiText: { frame1: string; frame4: string };
    };
    assert.ok(parseJson.parsed.frame1.landmarks.length > 0);
    assert.equal(parseJson.parsed.frame4.workflows.length, 2);
    assert.equal(parseJson.planned[0].action.category, "search");
    assert.match(parseJson.aiText.frame1, /# FRAME 1: STRUCTURE/);

    const rawRes = await fetch(`${url}/api/parse`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        html: "<main><h1>Hello</h1><a href='/docs'>Read Docs</a></main>",
        url: "https://example.com",
      }),
    });
    assert.equal(rawRes.status, 200);
    const rawJson = (await rawRes.json()) as {
      parsed: { frame3: { elements: Array<{ href?: string }> } };
    };
    assert.equal(rawJson.parsed.frame3.elements[0].href, "https://example.com/docs");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("MCP Server (JSON-RPC 2.0): progressive open, query, budgeted read, plan, inspect, diff, and HTTP /mcp", async () => {
  const mcp = new FrameParseMcpServer();

  // 1. Initialize + tools/list
  const init = await mcp.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize" });
  assert.ok(init?.result);
  const toolsResp = await mcp.handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const tools = (toolsResp?.result as { tools: Array<{ name: string }> }).tools;
  assert.equal(tools.length, 7);
  assert.ok(tools.some((t) => t.name === "frame_open"));
  assert.ok(tools.some((t) => t.name === "frame_query"));
  assert.ok(tools.some((t) => t.name === "frame_diff"));

  // 2. frame_open returns ONLY Frame 1 + sessionId
  const openResp = await mcp.handleMessage({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "frame_open", arguments: { fixture: "ecommerce", sessionId: "shop1" } },
  });
  const openText = (openResp?.result as { content: Array<{ text: string }> }).content[0].text;
  assert.match(openText, /sessionId: shop1/);
  assert.match(openText, /# FRAME 1: STRUCTURE/);
  assert.doesNotMatch(openText, /# FRAME 2: TEXT/);

  // 3. frame_query locates price & warranty in tiny token payload
  const queryResp = await mcp.handleMessage({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "frame_query", arguments: { sessionId: "shop1", query: "warranty" } },
  });
  const queryText = (queryResp?.result as { content: Array<{ text: string }> }).content[0].text;
  assert.match(queryText, /extended warranty/i);

  // 4. frame_read enforces strict maxTokens budget + pagination
  const readResp = await mcp.handleMessage({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "frame_read", arguments: { sessionId: "shop1", layer: 2, maxTokens: 45, offset: 0 } },
  });
  const readText = (readResp?.result as { content: Array<{ text: string }> }).content[0].text;
  assert.match(readText, /\[truncated:/);
  assert.match(readText, /offset=/);

  // 5. frame_plan finds commerce workflow & frame_inspect shows full vertical lineage
  const planResp = await mcp.handleMessage({
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: { name: "frame_plan", arguments: { sessionId: "shop1", goal: "add to cart" } },
  });
  const planText = (planResp?.result as { content: Array<{ text: string }> }).content[0].text;
  assert.match(planText, /w2 .*\[commerce\|mutate\]/);

  const inspectResp = await mcp.handleMessage({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "frame_inspect", arguments: { sessionId: "shop1", ref: "w2" } },
  });
  const inspectText = (inspectResp?.result as { content: Array<{ text: string }> }).content[0].text;
  assert.match(inspectText, /F1 structures:/);
  assert.match(inspectText, /F3 interactables/);
  assert.match(inspectText, /Add to Cart/);

  // 6. frame_diff over Streamable HTTP /mcp
  const { server, url } = await startVisualizerServer(0, "127.0.0.1");
  try {
    const httpOpen = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "frame_open", arguments: { fixture: "dashboard", sessionId: "dash1" } },
      }),
    });
    assert.equal(httpOpen.status, 200);

    const httpDiff = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: { name: "frame_diff", arguments: { sessionId: "dash1", fixture: "dashboard-after" } },
      }),
    });
    assert.equal(httpDiff.status, 200);
    const diffJson = (await httpDiff.json()) as {
      result: { content: Array<{ text: string }> };
    };
    assert.match(diffJson.result.content[0].text, /Signed in successfully/);
    assert.match(diffJson.result.content[0].text, /Archive Workspace/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Gaps 1, 2, 4: Live DOM Snapshot handles SPAs, div-soup clickables, Shadow DOM, iframes, and real CSS visibility", () => {
  const parsed = parseLiveSnapshotFrames({
    url: "https://spa.example.com/app",
    title: "Live SPA",
    root: {
      type: "element",
      tag: "html",
      children: [
        {
          type: "element",
          tag: "body",
          children: [
            {
              type: "element",
              tag: "main",
              children: [
                {
                  type: "element",
                  tag: "div",
                  attrs: {
                    id: "react-save",
                    "data-fp-clickable": "true",
                    "data-fp-click-source": "react-prop",
                  },
                  children: [{ type: "text", value: "Save Draft" }],
                },
                {
                  type: "element",
                  tag: "div",
                  attrs: { "data-fp-hidden": "true" },
                  children: [{ type: "text", value: "Hidden Modal Content" }],
                },
                {
                  type: "element",
                  tag: "x-widget",
                  attrs: { "data-fp-shadow-host": "true" },
                  children: [
                    {
                      type: "element",
                      tag: "button",
                      attrs: { "data-testid": "shadow-btn" },
                      children: [{ type: "text", value: "Shadow Action" }],
                    },
                  ],
                },
                {
                  type: "element",
                  tag: "iframe",
                  attrs: { "data-fp-iframe-inlined": "true" },
                  children: [
                    {
                      type: "element",
                      tag: "a",
                      attrs: { href: "/embed/details" },
                      children: [{ type: "text", value: "Open Embed Details" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  });

  const allText = (parsed.frame2?.blocks ?? []).map((b) => b.text).join("\n");
  assert.doesNotMatch(allText, /Hidden Modal Content/);

  const names = (parsed.frame3?.elements ?? []).map((e) => e.name);
  assert.ok(names.includes("Save Draft"), "Div-soup React clickable should be in Frame 3");
  assert.ok(names.includes("Shadow Action"), "Shadow DOM button should be in Frame 3");
  assert.ok(names.includes("Open Embed Details"), "Inlined iframe link should be in Frame 3");

  const declShadow = parsePageFrames(
    `<main><my-card><template shadowrootmode="open"><button>Confirm Inside Shadow</button></template></my-card></main>`,
  );
  assert.ok(declShadow.frame3?.elements.some((e) => e.name === "Confirm Inside Shadow"));
  assert.ok(LIVE_DOM_EXTRACTOR_SCRIPT.includes("shadowRoot"));
});

test("Gap 3: Frame 1 folds repeated sibling cards into compact pattern summary", () => {
  const cards = Array.from(
    { length: 120 },
    (_, i) => `<article><h3>Item #${i + 1}</h3><p>Fast hardware.</p><button>Buy</button></article>`,
  ).join("");
  const html = `<!DOCTYPE html><html><head><title>Store</title></head><body><main>${cards}</main></body></html>`;
  const parsed = parsePageFrames(html);

  assert.ok(parsed.frame1.foldedGroups && parsed.frame1.foldedGroups.length === 1);
  assert.equal(parsed.frame1.foldedGroups[0].count, 120);

  const wire = formatFrame1ForAI(parsed.frame1);
  assert.match(wire, /117 more repeated article <article> items folded/);
  assert.ok(parsed.metrics.frame1Tokens < 250, `Expected folded Frame 1 <250 tokens, got ${parsed.metrics.frame1Tokens}`);
});

test("Gap 5: Icon-only proximity heuristics & site-level ActionEffectCache learning", async () => {
  const iconHtml = `<!DOCTYPE html><html><body><main>
    <button id="mystery-trash"><svg class="lucide icon-trash"></svg></button>
    <button id="mystery-btn"><svg class="icon-xmark"></svg></button>
    <button id="custom-trigger">Run Job</button>
  </main></body></html>`;

  const parsed = parsePageFrames(iconHtml, { url: "https://app.example.com/jobs" });
  const trashEl = parsed.frame3?.elements.find((e) => e.selector === "#mystery-trash");
  assert.ok(trashEl);
  assert.match(trashEl.name, /Delete \(icon: trash\)/);

  const trashAct = parsed.frame4?.actions.find((a) => a.targetId === trashEl.id);
  assert.ok(trashAct);
  assert.equal(trashAct.effect, "destructive");

  const closeEl = parsed.frame3?.elements.find((e) => e.selector === "#mystery-btn");
  assert.ok(closeEl);
  assert.match(closeEl.name, /Close \(icon: xmark\)/);

  const mcp = new FrameParseMcpServer();
  await mcp.handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "frame_open", arguments: { html: iconHtml, url: "https://app.example.com/jobs", sessionId: "j1" } },
  });

  const afterHtml = `<!DOCTYPE html><html><body><main>
    <div role="alert">Background job queued (#409)</div>
    <button id="custom-trigger">Run Job</button>
  </main></body></html>`;

  const diffResp = await mcp.handleMessage({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "frame_diff",
      arguments: { sessionId: "j1", html: afterHtml, executedActionId: "a3" },
    },
  });
  const diffText = (diffResp?.result as { content: Array<{ text: string }> }).content[0].text;
  assert.match(diffText, /cached outcome learned: alert: "Background job queued \(#409\)"/);

  await mcp.handleMessage({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "frame_open", arguments: { html: iconHtml, url: "https://app.example.com/jobs", sessionId: "j2" } },
  });
  const readF4 = await mcp.handleMessage({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "frame_read", arguments: { sessionId: "j2", layer: 4 } },
  });
  const f4Text = (readF4?.result as { content: Array<{ text: string }> }).content[0].text;
  assert.match(f4Text, /\[learned: alert: "Background job queued \(#409\)"\]/);
  assert.ok(mcp.store.actionCache instanceof ActionEffectCache);
  assert.equal(mcp.store.actionCache.size(), 1);
});
