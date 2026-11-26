#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { diffFrames } from "./diff.js";
import {
  formatDiffForAI,
  formatFrame1ForAI,
  formatFrame2ForAI,
  formatFrame3ForAI,
  formatFrame4ForAI,
  formatFramesForAI,
} from "./formatter.js";
import { planAction } from "./frame4-actions.js";
import { startMcpStdioServer } from "./mcp-server.js";
import { parsePageFrames } from "./pipeline.js";
import { startVisualizerServer } from "./server.js";
import type { FrameLayer } from "./types.js";

interface CliArgs {
  source?: string;
  diffWith?: string;
  layer: "1" | "2" | "3" | "4" | "all";
  regions: string[];
  format: "ai" | "json";
  url?: string;
  planQuery?: string;
  stats: boolean;
  includeHidden: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    layer: "all",
    regions: [],
    format: "ai",
    stats: false,
    includeHidden: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "-h" || token === "--help") {
      args.help = true;
    } else if (token === "--layer" || token === "-l") {
      const val = argv[++i];
      if (val === "1" || val === "2" || val === "3" || val === "4" || val === "all") {
        args.layer = val;
      } else {
        throw new Error(`Invalid --layer value: ${val}. Expected 1, 2, 3, 4, or all.`);
      }
    } else if (token === "--region" || token === "-r") {
      const val = argv[++i];
      if (val) args.regions.push(...val.split(",").map((s) => s.trim()).filter(Boolean));
    } else if (token === "--format" || token === "-f") {
      const val = argv[++i];
      if (val === "ai" || val === "json") args.format = val;
      else throw new Error(`Invalid --format value: ${val}. Expected ai or json.`);
    } else if (token === "--url" || token === "-u") {
      args.url = argv[++i];
    } else if (token === "--plan" || token === "-p") {
      args.planQuery = argv[++i];
    } else if (token === "--diff") {
      args.diffWith = argv[++i];
    } else if (token === "--stats") {
      args.stats = true;
    } else if (token === "--include-hidden") {
      args.includeHidden = true;
    } else if (!token.startsWith("-") && !args.source) {
      args.source = token;
    }
  }

  return args;
}

function printHelp(): void {
  console.log(`frameparse — Zero-AI 4-Layer Webpage Frame Parser for AI Agents

Usage:
  frameparse <file-or-url> [options]
  frameparse serve [--port 4173] [--host 127.0.0.1]
  cat page.html | frameparse [options]

Options:
  -l, --layer <1|2|3|4|all>   Which frame to output (default: all)
                              1 = Structure, 2 = Text, 3 = Interactables, 4 = Actions
  -r, --region <s1,s3>        Scope Frame 2/3/4 to specific Frame 1 structure IDs
  -f, --format <ai|json>      Output format (default: ai)
  -u, --url <base-url>        Base URL for resolving relative links & form actions
  -p, --plan "<goal>"         Zero-AI deterministic action planner for a goal
      --diff <after-file>     Compute frame diff between <source> and <after-file>
      --stats                 Print parse timings and token compression stats
      --include-hidden        Include hidden / aria-hidden elements
  -h, --help                  Show this help message
`);
}

async function loadHtml(source?: string): Promise<{ html: string; inferredUrl?: string }> {
  if (!source || source === "-") {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return { html: Buffer.concat(chunks).toString("utf8") };
  }
  if (/^https?:\/\//i.test(source)) {
    const res = await fetch(source, {
      headers: { "user-agent": "frameparse/0.1 (+https://github.com/frameparse)" },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching ${source}`);
    }
    return { html: await res.text(), inferredUrl: res.url || source };
  }
  return { html: await readFile(source, "utf8") };
}

async function main(): Promise<void> {
  const rawArgv = process.argv.slice(2);
  if (rawArgv[0] === "mcp") {
    startMcpStdioServer();
    return;
  }

  if (rawArgv[0] === "serve") {
    let port = 4173;
    let host = "127.0.0.1";
    for (let i = 1; i < rawArgv.length; i++) {
      if (rawArgv[i] === "--port" || rawArgv[i] === "-p") {
        port = Number.parseInt(rawArgv[++i] || "4173", 10);
      } else if (rawArgv[i] === "--host") {
        host = rawArgv[++i] || "127.0.0.1";
      }
    }
    const { url } = await startVisualizerServer(port, host);
    console.log(`FrameParse 3D Visualizer & HTTP MCP running at ${url} (MCP: ${url}/mcp)`);
    return;
  }

  const args = parseArgs(rawArgv);
  if (args.help) {
    printHelp();
    return;
  }

  const { html, inferredUrl } = await loadHtml(args.source);
  const url = args.url ?? inferredUrl;

  if (args.diffWith) {
    const { html: afterHtml } = await loadHtml(args.diffWith);
    const before = parsePageFrames(html, { url, includeHidden: args.includeHidden });
    const after = parsePageFrames(afterHtml, { url, includeHidden: args.includeHidden });
    const diff = diffFrames(before, after);
    if (args.format === "json") {
      console.log(JSON.stringify(diff, null, 2));
    } else {
      console.log(formatDiffForAI(diff));
    }
    return;
  }

  const maxLayer: FrameLayer =
    args.planQuery || args.layer === "all" || args.layer === "4"
      ? 4
      : (Number.parseInt(args.layer, 10) as FrameLayer);

  const parsed = parsePageFrames(html, {
    url,
    maxLayer,
    structureIds: args.regions.length ? args.regions : undefined,
    includeHidden: args.includeHidden,
  });

  if (args.planQuery && parsed.frame4) {
    const matches = planAction(parsed.frame4, args.planQuery);
    if (args.format === "json") {
      console.log(JSON.stringify(matches, null, 2));
    } else {
      console.log(`# ZERO-AI ACTION PLAN FOR: "${args.planQuery}"`);
      if (matches.length === 0) {
        console.log("(no matching actions found)");
      } else {
        for (const m of matches) {
          const steps = m.action.steps
            .map((s) => `${s.op}(${s.ref}:${s.selector}${s.param ? ` <- ${s.param}` : ""})`)
            .join(" -> ");
          console.log(
            `- [${m.score.toFixed(2)}] ${m.action.id} [${m.action.category}|${m.action.effect}] ${m.action.summary}`,
          );
          console.log(`    steps: ${steps}`);
        }
      }
    }
    return;
  }

  if (args.format === "json") {
    const payload =
      args.layer === "1"
        ? parsed.frame1
        : args.layer === "2"
          ? parsed.frame2
          : args.layer === "3"
            ? parsed.frame3
            : args.layer === "4"
              ? parsed.frame4
              : parsed;
    console.log(JSON.stringify(payload, null, 2));
  } else {
    if (args.layer === "1") console.log(formatFrame1ForAI(parsed.frame1));
    else if (args.layer === "2" && parsed.frame2) console.log(formatFrame2ForAI(parsed.frame2));
    else if (args.layer === "3" && parsed.frame3) console.log(formatFrame3ForAI(parsed.frame3));
    else if (args.layer === "4" && parsed.frame4) console.log(formatFrame4ForAI(parsed.frame4));
    else console.log(formatFramesForAI(parsed));
  }

  if (args.stats) {
    console.error(
      `\n[frameparse stats] total=${parsed.timingsMs.total}ms (html=${parsed.timingsMs.htmlParse}ms, f1=${parsed.timingsMs.frame1}ms, f2=${parsed.timingsMs.frame2}ms, f3=${parsed.timingsMs.frame3}ms, f4=${parsed.timingsMs.frame4}ms) | raw=${parsed.metrics.estimatedRawTokens}tok -> frames=${parsed.metrics.totalFrameTokens}tok (${parsed.metrics.compressionRatio}x compression)`,
    );
  }
}

main().catch((err) => {
  console.error(`frameparse error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
