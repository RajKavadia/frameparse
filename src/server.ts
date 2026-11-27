import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatFrame1ForAI,
  formatFrame2ForAI,
  formatFrame3ForAI,
  formatFrame4ForAI,
} from "./formatter.js";
import { planAction } from "./frame4-actions.js";
import { FrameParseMcpServer, type JsonRpcRequest } from "./mcp-server.js";
import { parsePageFrames } from "./pipeline.js";
import { SessionStore } from "./session-store.js";
import { executeFrameChainTool, executeToolChain, type ToolChainRequest } from "./tool-chain.js";
import { executeFrameTool } from "./tools.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");
const visualizerHtmlPath = path.join(projectRoot, "visualizer", "index.html");
const fixturesDir = path.join(projectRoot, "tests", "fixtures");

export interface BuiltInFixture {
  id: string;
  label: string;
  url: string;
  file: string;
}

const BUILTIN_FIXTURES: BuiltInFixture[] = [
  {
    id: "ecommerce",
    label: "NovaStore — E-Commerce Product Page",
    url: "https://novastore.example.com/products/ultrabook-pro-14",
    file: "ecommerce.html",
  },
  {
    id: "dashboard",
    label: "Acme Cloud — SaaS Workspace Settings",
    url: "https://acme.example.com/settings",
    file: "dashboard.html",
  },
  {
    id: "dashboard-after",
    label: "Acme Cloud — Post-Login State",
    url: "https://acme.example.com/settings",
    file: "dashboard-after.html",
  },
];

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  const MAX_BYTES = 5 * 1024 * 1024;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_BYTES) {
      throw new Error("Request body exceeds 5MB limit");
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

export function createVisualizerServer(sharedStore?: SessionStore): http.Server {
  const store = sharedStore ?? new SessionStore();
  const mcpServer = new FrameParseMcpServer(store);

  return http.createServer(async (req, res) => {
    try {
      const method = req.method || "GET";
      const reqUrl = new URL(req.url || "/", "http://127.0.0.1");

      // Streamable HTTP MCP JSON-RPC endpoint
      if (method === "POST" && reqUrl.pathname === "/mcp") {
        const body = await readJsonBody(req);
        const rpcResp = await mcpServer.handleMessage(body as unknown as JsonRpcRequest);
        if (!rpcResp) {
          res.writeHead(202);
          res.end();
          return;
        }
        sendJson(res, 200, rpcResp);
        return;
      }

      // Direct in-process tool chain (no MCP JSON-RPC envelope)
      if (method === "POST" && reqUrl.pathname === "/api/chain") {
        const body = await readJsonBody(req);
        const singleTool = typeof body.tool === "string" ? body.tool : undefined;
        if (singleTool && singleTool !== "frame_chain") {
          const singleArgs =
            body.arguments && typeof body.arguments === "object"
              ? (body.arguments as Record<string, unknown>)
              : {};
          const result = await executeFrameTool(store, singleTool, singleArgs);
          sendJson(res, result.isError ? 400 : 200, { ok: !result.isError, ...result });
          return;
        }

        const chainRequest: ToolChainRequest = {
          steps: Array.isArray(body.steps) ? (body.steps as ToolChainRequest["steps"]) : undefined,
          preset: typeof body.preset === "string" ? (body.preset as ToolChainRequest["preset"]) : undefined,
          presetArgs:
            body.presetArgs && typeof body.presetArgs === "object"
              ? (body.presetArgs as Record<string, unknown>)
              : undefined,
          compact: body.compact !== false,
          json: Boolean(body.json),
        };

        if (chainRequest.json) {
          const chainToolResult = await executeFrameChainTool(
            store,
            chainRequest as unknown as Record<string, unknown>,
          );
          let parsed: unknown = chainToolResult.text;
          try {
            parsed = JSON.parse(chainToolResult.text);
          } catch {
            // keep text
          }
          sendJson(res, chainToolResult.isError ? 400 : 200, {
            ok: !chainToolResult.isError,
            result: parsed,
            meta: chainToolResult.meta,
          });
          return;
        }

        const chain = await executeToolChain(store, chainRequest);
        if (chainRequest.compact !== false) {
          sendJson(res, chain.ok ? 200 : 400, {
            ok: chain.ok,
            sessionId: chain.sessionId,
            totalTokens: chain.totalTokens,
            totalMs: chain.totalMs,
            compactText: chain.compactText,
            steps: chain.steps.map((s) => ({
              index: s.index,
              tool: s.tool,
              ok: s.ok,
              tokens: s.tokens,
              durationMs: s.durationMs,
            })),
          });
          return;
        }
        sendJson(res, chain.ok ? 200 : 400, chain);
        return;
      }

      if (method === "GET" && reqUrl.pathname === "/api/sessions") {
        sendJson(res, 200, { sessions: store.list() });
        return;
      }

      if (method === "GET" && (reqUrl.pathname === "/" || reqUrl.pathname === "/index.html")) {
        const html = await readFile(visualizerHtmlPath, "utf8");
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-length": Buffer.byteLength(html),
          "cache-control": "no-store",
        });
        res.end(html);
        return;
      }

      if (method === "GET" && reqUrl.pathname === "/api/fixtures") {
        sendJson(res, 200, {
          fixtures: BUILTIN_FIXTURES.map(({ id, label, url }) => ({ id, label, url })),
        });
        return;
      }

      if (method === "POST" && reqUrl.pathname === "/api/parse") {
        const body = await readJsonBody(req);
        const fixtureId = typeof body.fixture === "string" ? body.fixture : undefined;
        const inputUrl = typeof body.url === "string" ? body.url.trim() : undefined;
        const inputHtml = typeof body.html === "string" ? body.html : undefined;
        const goal = typeof body.goal === "string" ? body.goal.trim() : undefined;
        const includeHidden = Boolean(body.includeHidden);

        let html = "";
        let resolvedUrl = inputUrl;

        if (fixtureId) {
          const match = BUILTIN_FIXTURES.find((f) => f.id === fixtureId);
          if (!match) {
            sendJson(res, 404, { error: `Unknown fixture: ${fixtureId}` });
            return;
          }
          html = await readFile(path.join(fixturesDir, match.file), "utf8");
          resolvedUrl = resolvedUrl || match.url;
        } else if (inputHtml && inputHtml.trim().length > 0) {
          html = inputHtml;
        } else if (inputUrl && /^https?:\/\//i.test(inputUrl)) {
          const response = await fetch(inputUrl, {
            headers: {
              "user-agent": "frameparse-visualizer/0.1 (+https://github.com/frameparse)",
              accept: "text/html,application/xhtml+xml,*/*;q=0.8",
            },
            signal: AbortSignal.timeout(15000),
          });
          if (!response.ok) {
            sendJson(res, 502, { error: `Failed to fetch URL (HTTP ${response.status})` });
            return;
          }
          html = await response.text();
          resolvedUrl = response.url || inputUrl;
        } else {
          sendJson(res, 400, { error: "Provide one of: url, html, or fixture" });
          return;
        }

        const parsed = parsePageFrames(html, {
          url: resolvedUrl,
          maxLayer: 4,
          includeHidden,
        });

        const planned = goal && parsed.frame4 ? planAction(parsed.frame4, goal, { limit: 6 }) : [];

        sendJson(res, 200, {
          parsed,
          planned,
          aiText: {
            frame1: formatFrame1ForAI(parsed.frame1),
            frame2: parsed.frame2 ? formatFrame2ForAI(parsed.frame2) : "",
            frame3: parsed.frame3 ? formatFrame3ForAI(parsed.frame3) : "",
            frame4: parsed.frame4 ? formatFrame4ForAI(parsed.frame4) : "",
          },
        });
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      sendJson(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

export async function startVisualizerServer(port = 4173, host = "127.0.0.1"): Promise<{
  server: http.Server;
  url: string;
}> {
  const server = createVisualizerServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  const url = `http://${host}:${actualPort}`;
  return { server, url };
}
