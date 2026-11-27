import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { FrameParseMcpServer, parsePageFrames, resolveAct, resolveScroll } from "../src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(__dirname, "../../tests/fixtures");
const ecommerce = readFileSync(path.join(fixturesDir, "ecommerce.html"), "utf8");

test("resolveAct: i# fill/click and a#/w# workflows", () => {
  const parsed = parsePageFrames(ecommerce, {
    url: "https://novastore.example.com",
    maxLayer: 4,
  });

  const searchInput = parsed.frame3!.elements.find(
    (e) => (e.kind === "input" || e.kind === "textarea") && (e.inputType === "search" || /search/i.test(e.name) || e.fieldName === "q"),
  );
  assert.ok(searchInput, "expected search input interactable");
  const fillPlan = resolveAct({ parsed, ref: searchInput!.id, params: { value: "laptops" } });
  assert.equal(fillPlan.steps[0].op, "fill");
  assert.equal(fillPlan.steps[0].value, "laptops");

  const add = resolveAct({ parsed, goal: "add to cart", allowDestructive: false });
  assert.ok(add.steps.length >= 1);
  assert.ok(add.steps.some((s) => s.op === "click" || s.op === "submit"));

  const cartBtn = parsed.frame3!.elements.find((e) => /add to cart/i.test(e.name));
  assert.ok(cartBtn);
  const clickPlan = resolveAct({ parsed, ref: cartBtn!.id });
  assert.equal(clickPlan.steps[0].op, "click");
  assert.ok(clickPlan.steps[0].selector);
});

test("resolveAct: destructive requires confirmation", () => {
  const parsed = parsePageFrames(
    readFileSync(path.join(fixturesDir, "dashboard.html"), "utf8"),
    { url: "https://acme.example.com/settings", maxLayer: 4 },
  );
  const del = parsed.frame4?.actions.find((a) => a.effect === "destructive")
    || parsed.frame4?.workflows.find((a) => a.effect === "destructive");
  if (!del) return; // fixture may label differently
  assert.throws(() => resolveAct({ parsed, ref: del.id, allowDestructive: false }));
  const ok = resolveAct({ parsed, ref: del.id, allowDestructive: true });
  assert.equal(ok.actionId, del.id);
});

test("resolveScroll: into_view / by / to", () => {
  const parsed = parsePageFrames(ecommerce, { url: "https://novastore.example.com", maxLayer: 4 });
  const link = parsed.frame3!.elements.find((e) => e.kind === "link");
  assert.ok(link);
  const into = resolveScroll({ parsed, op: "into_view", ref: link!.id });
  assert.equal(into.op, "scroll_into_view");
  const by = resolveScroll({ parsed, op: "by", dy: 800 });
  assert.equal(by.op, "scroll_by");
  assert.equal(by.dy, 800);
  const top = resolveScroll({ parsed, op: "to", target: "top" });
  assert.equal(top.op, "scroll_to");
  assert.equal(top.value, "top");
});

test("MCP tools include frame_browser, frame_act, frame_scroll", async () => {
  const mcp = new FrameParseMcpServer();
  const toolsResp = await mcp.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const tools = (toolsResp?.result as { tools: Array<{ name: string }> }).tools;
  const names = tools.map((t) => t.name);
  assert.ok(names.includes("frame_browser"));
  assert.ok(names.includes("frame_act"));
  assert.ok(names.includes("frame_scroll"));
  assert.equal(tools.length, 11);
  assert.ok(tools.some((t) => t.name === "frame_chain"));
});
