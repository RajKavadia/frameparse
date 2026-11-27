#!/usr/bin/env node
/**
 * CDP → FrameParse filter
 *
 * Agent loop:
 *   1. Chrome DevTools MCP: navigate_page(url)
 *   2. evaluate_script(function=extractor from --print-extractor, filePath=snapshot.json)
 *   3. node scripts/cdp-frameparse-filter.mjs snapshot.json  → AI-facing frames
 *
 * Usage:
 *   node scripts/cdp-frameparse-filter.mjs --print-extractor
 *   node scripts/cdp-frameparse-filter.mjs <snapshot.json> [--layer 1|2|3|4|all] [--plan "goal"] [--out out.txt]
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const {
  LIVE_DOM_EXTRACTOR_SCRIPT,
  parseLiveSnapshotFrames,
  planAction,
  formatFrame1ForAI,
  formatFrame2ForAI,
  formatFrame3ForAI,
  formatFrame4ForAI,
  estimateTokens,
} = await import(pathToFileURL(path.join(root, "dist", "src", "index.js")).href);

/** Convert packaged IIFE into a function source for Chrome DevTools evaluate_script. */
function extractorFunctionSource() {
  const raw = LIVE_DOM_EXTRACTOR_SCRIPT.trim();
  if (raw.startsWith("(() => {") && raw.endsWith("})()")) {
    return `() => {${raw.slice("(() => {".length, -"})()".length)}}`;
  }
  return `() => (${raw})`;
}

function usage() {
  console.error(`Usage:
  node scripts/cdp-frameparse-filter.mjs --print-extractor
  node scripts/cdp-frameparse-filter.mjs <snapshot.json> [--layer 1|2|3|4|all] [--plan "goal"] [--out file.txt]`);
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length === 0) usage();

if (args[0] === "--print-extractor") {
  process.stdout.write(extractorFunctionSource());
  process.exit(0);
}

const snapshotPath = path.resolve(args[0]);
let layer = "1";
let planGoal;
let outPath;

for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a === "--layer") layer = args[++i];
  else if (a === "--plan") planGoal = args[++i];
  else if (a === "--out") outPath = args[++i];
  else usage();
}

const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
const maxLayer = layer === "all" ? 4 : Number(layer) || 1;
const parsed = parseLiveSnapshotFrames(snapshot, {
  url: snapshot.url,
  maxLayer,
});

const parts = [];
parts.push(`# FrameParse CDP filter`);
parts.push(`url: ${snapshot.url || "-"}`);
parts.push(`title: ${snapshot.title || parsed.frame1.meta.title || "-"}`);
parts.push(
  `tokens: raw≈${parsed.metrics.estimatedRawTokens} → frame1=${parsed.metrics.frame1Tokens} (${(
    parsed.metrics.estimatedRawTokens / Math.max(1, parsed.metrics.frame1Tokens)
  ).toFixed(1)}x) | totalFrames=${parsed.metrics.totalFrameTokens}`,
);
parts.push("");

if (maxLayer >= 1) parts.push(formatFrame1ForAI(parsed.frame1));
if (maxLayer >= 2 && parsed.frame2) {
  parts.push("");
  parts.push(formatFrame2ForAI(parsed.frame2));
}
if (maxLayer >= 3 && parsed.frame3) {
  parts.push("");
  parts.push(formatFrame3ForAI(parsed.frame3));
}
if (maxLayer >= 4 && parsed.frame4) {
  parts.push("");
  parts.push(formatFrame4ForAI(parsed.frame4));
}

if (planGoal) {
  // Ensure Frame 4 exists for planner
  const full = maxLayer >= 4 ? parsed : parseLiveSnapshotFrames(snapshot, { url: snapshot.url, maxLayer: 4 });
  const plans = planAction(full, planGoal, { allowDestructive: false, limit: 5 });
  parts.push("");
  parts.push(`## Zero-AI plan: ${planGoal}`);
  parts.push(JSON.stringify(plans, null, 2));
}

const body = parts.join("\n");
const finalOut = `${body}\n\n# filter_output_tokens≈${estimateTokens(body)}\n`;
if (outPath) writeFileSync(outPath, finalOut, "utf8");
process.stdout.write(finalOut);
