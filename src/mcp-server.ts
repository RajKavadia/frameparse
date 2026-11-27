import readline from "node:readline";
import { LIVE_DOM_EXTRACTOR_SCRIPT } from "./browser-adapter.js";
import { SessionStore } from "./session-store.js";
import { executeFrameChainTool } from "./tool-chain.js";
import { MCP_TOOL_DEFINITIONS, executeFrameTool, toMcpToolContent } from "./tools.js";
import type { FrameLayer } from "./types.js";

const MCP_PROTOCOL_VERSION = "2025-03-26";
const SERVER_INFO = {
  name: "frameparse-mcp",
  version: "0.3.0",
};

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const MCP_TOOLS = MCP_TOOL_DEFINITIONS as unknown as Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}>;

const MCP_PROMPTS = [
  {
    name: "browse_efficiently",
    description: "Token-minimal 4-layer agentic browsing protocol using FrameParse MCP tools.",
    arguments: [
      { name: "url", description: "Target webpage URL", required: true },
      { name: "goal", description: "User goal on the webpage", required: true },
    ],
  },
];

export class FrameParseMcpServer {
  public readonly store: SessionStore;

  constructor(store?: SessionStore) {
    this.store = store ?? new SessionStore();
  }

  async handleMessage(msg: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const id = msg.id ?? null;
    const isNotification = msg.id === undefined;

    try {
      switch (msg.method) {
        case "initialize": {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: {
                tools: { listChanged: false },
                resources: { subscribe: false, listChanged: false },
                prompts: { listChanged: false },
              },
              serverInfo: SERVER_INFO,
              instructions:
                "FrameParse MCP minimizes token usage via 4 progressive deterministic frames (Structure -> Text -> Interactables -> Actions). Always start with frame_open (Frame 1 only), then use frame_query or region-scoped frame_read(maxTokens), plan with frame_plan, and re-observe with frame_diff.",
            },
          };
        }

        case "notifications/initialized":
        case "notifications/cancelled":
          return null;

        case "ping":
          return { jsonrpc: "2.0", id, result: {} };

        case "tools/list":
          return { jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } };

        case "tools/call": {
          const params = msg.params ?? {};
          const name = String(params.name ?? "");
          const args = (params.arguments ?? {}) as Record<string, unknown>;
          const result = await this.callTool(name, args);
          return { jsonrpc: "2.0", id, result };
        }

        case "resources/list": {
          const sessions = this.store.list();
          const resources = [
            {
              uri: "frameparse://browser-extractor.js",
              name: "Live Browser DOM Extractor Script (SPAs, Shadow DOM, iframes, JS clickables)",
              mimeType: "application/javascript",
            },
            {
              uri: "frameparse://sessions",
              name: "Active FrameParse Sessions & Token Savings",
              mimeType: "application/json",
            },
            ...sessions.flatMap((s) =>
              ([1, 2, 3, 4] as const).map((layer) => ({
                uri: `frameparse://session/${s.sessionId}/frame/${layer}`,
                name: `${s.sessionId} (${s.title}) — Frame ${layer}`,
                mimeType: "text/plain",
              })),
            ),
          ];
          return { jsonrpc: "2.0", id, result: { resources } };
        }

        case "resources/read": {
          const uri = String(msg.params?.uri ?? "");
          if (uri === "frameparse://browser-extractor.js") {
            return {
              jsonrpc: "2.0",
              id,
              result: {
                contents: [
                  {
                    uri,
                    mimeType: "application/javascript",
                    text: LIVE_DOM_EXTRACTOR_SCRIPT,
                  },
                ],
              },
            };
          }
          if (uri === "frameparse://sessions") {
            return {
              jsonrpc: "2.0",
              id,
              result: {
                contents: [
                  {
                    uri,
                    mimeType: "application/json",
                    text: JSON.stringify(this.store.list(), null, 2),
                  },
                ],
              },
            };
          }
          const match = /^frameparse:\/\/session\/([^/]+)\/frame\/([1-4])$/.exec(uri);
          if (!match) {
            throw new Error(`Unknown resource URI: ${uri}`);
          }
          const [, sessionId, layerStr] = match;
          const read = this.store.readLayer(sessionId, {
            layer: Number.parseInt(layerStr, 10) as FrameLayer,
            maxTokens: 2000,
          });
          return {
            jsonrpc: "2.0",
            id,
            result: {
              contents: [{ uri, mimeType: "text/plain", text: `${read.header}\n${read.body}` }],
            },
          };
        }

        case "prompts/list":
          return { jsonrpc: "2.0", id, result: { prompts: MCP_PROMPTS } };

        case "prompts/get": {
          const name = String(msg.params?.name ?? "");
          if (name !== "browse_efficiently") {
            throw new Error(`Unknown prompt: ${name}`);
          }
          const args = (msg.params?.arguments ?? {}) as Record<string, string>;
          return {
            jsonrpc: "2.0",
            id,
            result: {
              description: "4-layer token-minimal browsing workflow",
              messages: [
                {
                  role: "user",
                  content: {
                    type: "text",
                    text: [
                      `Goal: ${args.goal || "(goal)"} on ${args.url || "(url)"}.`,
                      `Follow the FrameParse 4-layer protocol:`,
                      `1. Call frame_open({ url }) to get Frame 1 (Structure) + sessionId in ~150 tokens.`,
                      `2. Use frame_query for targeted lookup OR frame_read({ sessionId, layer: 2, regions: [...] }) to read only relevant landmarks.`,
                      `3. Call frame_plan({ sessionId, goal }) to get deterministic Frame 4 workflows & steps. Check effect tier before executing (confirm if destructive).`,
                      `4. After acting, call frame_diff({ sessionId, ... }) instead of re-reading the full page.`,
                    ].join("\n"),
                  },
                },
              ],
            },
          };
        }

        default:
          if (isNotification) return null;
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Method not found: ${msg.method}` },
          };
      }
    } catch (err) {
      if (isNotification) return null;
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  /** Shared tool dispatcher for MCP and direct in-process callers */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
    if (name === "frame_chain") {
      const result = await executeFrameChainTool(this.store, args);
      return toMcpToolContent(result);
    }
    const result = await executeFrameTool(this.store, name, args);
    return toMcpToolContent(result);
  }
}

/**
 * Starts the FrameParse MCP Server over stdio (newline-delimited JSON-RPC 2.0).
 * Compatible with Cursor, Claude Desktop, Windsurf, Cline, and any MCP client.
 */
export function startMcpStdioServer(store?: SessionStore): void {
  const mcp = new FrameParseMcpServer(store);
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const msg = JSON.parse(trimmed) as JsonRpcRequest;
      const response = await mcp.handleMessage(msg);
      if (response) {
        process.stdout.write(`${JSON.stringify(response)}\n`);
      }
    } catch (err) {
      const errResp: JsonRpcResponse = {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32700,
          message: `Parse error: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
      process.stdout.write(`${JSON.stringify(errResp)}\n`);
    }
  });
}
