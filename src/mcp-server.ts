import readline from "node:readline";
import { executeAct, executeScroll, getSharedDriver } from "./act/index.js";
import { LIVE_DOM_EXTRACTOR_SCRIPT } from "./browser-adapter.js";
import { formatFrame1ForAI } from "./formatter.js";
import { executeFrameChainTool } from "./tool-chain.js";
import { SessionStore } from "./session-store.js";
import { toMcpToolContent } from "./tools.js";
import type { FrameLayer, LiveDomSnapshot } from "./types.js";

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

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const MCP_TOOLS: McpToolDef[] = [
  {
    name: "frame_open",
    description:
      "Parse a webpage (URL, raw HTML, live browser DOM snapshot from frameparse://browser-extractor.js, or built-in fixture) deterministically with zero AI, cache it in a session, and return ONLY Frame 1 (Structure, with repeated cards folded) + token compression telemetry (~120-250 tokens instead of 10k+ raw HTML). Always call this first before reading deeper layers.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Live webpage URL (http/https) to fetch and parse." },
        html: { type: "string", description: "Raw HTML string to parse directly." },
        snapshot: {
          type: "object",
          description:
            "Live post-hydration browser DOM snapshot captured via frameparse://browser-extractor.js (supports SPAs, auth sessions, Shadow DOM, iframes, real CSS visibility, and JS/cursor:pointer clickables).",
        },
        fixture: {
          type: "string",
          enum: ["ecommerce", "dashboard", "dashboard-after"],
          description: "Optional built-in sample webpage fixture for testing.",
        },
        sessionId: { type: "string", description: "Optional custom session ID to reuse or overwrite." },
        includeHidden: { type: "boolean", description: "Include hidden/aria-hidden elements (default: false)." },
      },
    },
  },
  {
    name: "frame_read",
    description:
      "Progressively read a single frame layer (1=Structure, 2=Text, 3=Interactables, 4=Actions) from a cached session, optionally scoped to specific Frame 1 region IDs (e.g. ['s4']) and capped by a strict maxTokens budget with pagination.",
    inputSchema: {
      type: "object",
      required: ["sessionId", "layer"],
      properties: {
        sessionId: { type: "string", description: "Session ID returned by frame_open." },
        layer: {
          type: "integer",
          enum: [1, 2, 3, 4],
          description: "1=Structure, 2=Text, 3=Interactables, 4=Actions.",
        },
        regions: {
          type: "array",
          items: { type: "string" },
          description: "Optional Frame 1 landmark IDs (e.g. ['s4']) to scope reading and skip nav/footer noise.",
        },
        kinds: {
          type: "array",
          items: { type: "string" },
          description: "Optional filter for Frame 2 block kinds or Frame 3 interactable kinds.",
        },
        effects: {
          type: "array",
          items: { type: "string", enum: ["read", "navigate", "mutate", "destructive"] },
          description: "Optional filter for Frame 4 action side-effect tiers.",
        },
        maxTokens: {
          type: "integer",
          description: "Hard token budget for this response (default: 900). Use offset to paginate if truncated.",
        },
        offset: { type: "integer", description: "Line offset for pagination (default: 0)." },
      },
    },
  },
  {
    name: "frame_query",
    description:
      "High-density zero-AI search across Frames 1-4 inside a cached page session. Returns only the matching text blocks, controls, and actions (~80-180 tokens) so the agent finds prices, labels, or buttons without reading the whole page.",
    inputSchema: {
      type: "object",
      required: ["sessionId", "query"],
      properties: {
        sessionId: { type: "string", description: "Session ID returned by frame_open." },
        query: { type: "string", description: "Keywords or phrase to locate (e.g. 'price', 'battery', 'warranty', 'login')." },
        layers: {
          type: "array",
          items: { type: "integer", enum: [1, 2, 3, 4] },
          description: "Which layers to search (default: [2, 3, 4]).",
        },
        limit: { type: "integer", description: "Maximum ranked matches to return (default: 8)." },
      },
    },
  },
  {
    name: "frame_plan",
    description:
      "Zero-AI deterministic action planner on Frame 4. Given a natural-language goal (e.g. 'search for laptops', 'add to cart', 'sign in'), returns ranked composite workflows & atomic actions with safety effect tiers, preconditions, parameters, and executable browser steps.",
    inputSchema: {
      type: "object",
      required: ["sessionId", "goal"],
      properties: {
        sessionId: { type: "string", description: "Session ID returned by frame_open." },
        goal: { type: "string", description: "What the agent wants to accomplish on the page." },
        regions: {
          type: "array",
          items: { type: "string" },
          description: "Optional Frame 1 landmark IDs to restrict candidate actions.",
        },
        allowDestructive: {
          type: "boolean",
          description: "Whether to include destructive actions like delete/revoke (default: true; always confirm destructive actions with the user).",
        },
        limit: { type: "integer", description: "Max ranked action plans to return (default: 5)." },
      },
    },
  },
  {
    name: "frame_inspect",
    description:
      "Inspect the complete vertical cross-layer lineage (Frame 1 Structure <-> Frame 2 Text <-> Frame 3 Interactables <-> Frame 4 Actions) for any single ref ID (s#, t#, i#, w#, or a#).",
    inputSchema: {
      type: "object",
      required: ["sessionId", "ref"],
      properties: {
        sessionId: { type: "string", description: "Session ID returned by frame_open." },
        ref: { type: "string", description: "Any frame reference ID such as s4, t2, i11, w1, or a3." },
      },
    },
  },
  {
    name: "frame_diff",
    description:
      "Compute a compact delta between the cached page session and a new page state (URL, HTML, or live browser DOM snapshot after clicking/submitting). Pass executedActionId (e.g. 'a5' or 'w1') to automatically learn and cache that control's real-world outcome on this origin for future Frame 4 parses.",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      properties: {
        sessionId: { type: "string", description: "Existing session ID to diff against." },
        url: { type: "string", description: "New URL to fetch after the action." },
        html: { type: "string", description: "New raw HTML after the action." },
        snapshot: { type: "object", description: "New live browser DOM snapshot after the action." },
        fixture: {
          type: "string",
          enum: ["ecommerce", "dashboard", "dashboard-after"],
          description: "Optional built-in fixture for after-state testing.",
        },
        executedActionId: {
          type: "string",
          description: "Optional Frame 4 action/workflow ID (e.g. 'a5', 'w1') that caused this transition; records its observed effect into the site-level ActionEffectCache.",
        },
        updateSession: {
          type: "boolean",
          description: "Update the cached session to the new state (default: true).",
        },
      },
    },
  },
  {
    name: "frame_sessions",
    description:
      "List active cached webpage sessions with cumulative token savings telemetry (raw HTML tokens avoided vs compact frame tokens emitted), or close a session.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "close"], description: "Default: list." },
        sessionId: { type: "string", description: "Required when action is 'close'." },
      },
    },
  },
  {
    name: "frame_browser",
    description:
      "Connect FrameParse's built-in CDP actuator to Chrome (no DevTools uid required). Actions: status | connect | launch | disconnect | navigate. Prefer connect to an existing debugging port (http://127.0.0.1:9222).",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["status", "connect", "launch", "disconnect", "navigate", "open"],
          description: "Default: status. action=open navigates (optional url), extracts live DOM snapshot, and frame_open's it into a session.",
        },
        browserURL: {
          type: "string",
          description: "Chrome remote debugging HTTP endpoint, e.g. http://127.0.0.1:9222",
        },
        wsEndpoint: { type: "string", description: "Direct CDP WebSocket endpoint." },
        url: { type: "string", description: "URL for action=navigate or action=open." },
        sessionId: { type: "string", description: "Optional session id for action=open." },
        headless: { type: "boolean", description: "For action=launch (default true)." },
        executablePath: { type: "string", description: "Chrome binary for action=launch." },
      },
    },
  },
  {
    name: "frame_act",
    description:
      "Execute interaction(s) from FrameParse frames via CDP — click/fill/select/toggle/submit/navigate/hover/focus/type/press — using i# / a# / w# refs or a goal. Does NOT use DevTools a11y uids. Auto scroll-into-view before target ops. Re-extracts snapshot + returns frame_diff by default.",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      properties: {
        sessionId: { type: "string" },
        ref: {
          type: "string",
          description: "Frame ref to act on: i12 (interactable), a3/w1 (Frame 4 action/workflow), or s4 (scroll region).",
        },
        goal: {
          type: "string",
          description: "If ref omitted, run the top Frame 4 plan for this goal.",
        },
        params: {
          type: "object",
          description: "Values for fill/select/toggle/press (e.g. { q: \"laptops\", value: \"...\", key: \"Enter\" }).",
          additionalProperties: true,
        },
        confirmDestructive: {
          type: "boolean",
          description: "Required true to execute destructive Frame 4 actions.",
        },
        reobserve: {
          type: "boolean",
          description: "Re-extract live DOM and return frame_diff (default true).",
        },
      },
    },
  },
  {
    name: "frame_chain",
    description:
      "Direct multi-step tool call chain in ONE invocation. Presets: orient_and_plan, query_then_inspect, plan_and_inspect, action_and_observe. Variables: $sessionId, $prev.ref, $steps.<alias>.*.",
    inputSchema: {
      type: "object",
      properties: {
        preset: {
          type: "string",
          enum: ["orient_and_plan", "query_then_inspect", "plan_and_inspect", "action_and_observe"],
        },
        presetArgs: { type: "object" },
        steps: {
          type: "array",
          items: {
            type: "object",
            required: ["tool"],
            properties: {
              tool: { type: "string" },
              args: { type: "object" },
              as: { type: "string" },
              stopOnError: { type: "boolean" },
            },
          },
        },
        compact: { type: "boolean" },
        json: { type: "boolean" },
      },
    },
  },
  {
    name: "frame_scroll",
    description:
      "Scroll using FrameParse refs: into_view(ref), by(dx,dy), or to(top|bottom|x,y). Uses CDP actuator; reobserves by default.",
    inputSchema: {
      type: "object",
      required: ["sessionId", "op"],
      properties: {
        sessionId: { type: "string" },
        op: { type: "string", enum: ["into_view", "by", "to"] },
        ref: { type: "string", description: "i# / a# / s# for into_view or element scroll container." },
        dx: { type: "number" },
        dy: { type: "number" },
        x: { type: "number" },
        y: { type: "number" },
        target: { type: "string", enum: ["top", "bottom"], description: "For op=to without x/y." },
        reobserve: { type: "boolean", description: "Default true." },
      },
    },
  },
];

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

  private async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
    try {
      if (name === "frame_chain") {
        const result = await executeFrameChainTool(this.store, args);
        return toMcpToolContent(result);
      }

      if (name === "frame_open") {
        const session = await this.store.open({
          url: typeof args.url === "string" ? args.url : undefined,
          html: typeof args.html === "string" ? args.html : undefined,
          snapshot:
            args.snapshot && typeof args.snapshot === "object"
              ? (args.snapshot as LiveDomSnapshot)
              : undefined,
          fixture: typeof args.fixture === "string" ? args.fixture : undefined,
          sessionId: typeof args.sessionId === "string" ? args.sessionId : undefined,
          includeHidden: Boolean(args.includeHidden),
        });

        const { parsed } = session;
        const f1Text = formatFrame1ForAI(parsed.frame1);
        const keyRegions = parsed.frame1.landmarks
          .filter((l) => ["main", "article", "form", "search", "table"].includes(l.role))
          .map((l) => `${l.id}[${l.role}:"${l.label}"]`)
          .slice(0, 8)
          .join(", ");

        const out = [
          `sessionId: ${session.id} | parseMs: ${parsed.timingsMs.total}ms | rawHtml: ${parsed.metrics.estimatedRawTokens}tok -> frame1: ${parsed.metrics.frame1Tokens}tok (${(parsed.metrics.estimatedRawTokens / Math.max(1, parsed.metrics.frame1Tokens)).toFixed(1)}x smaller)`,
          `totals: ${parsed.frame1.landmarks.length} landmarks, ${parsed.frame2?.totalBlocks ?? 0} text blocks, ${parsed.frame3?.totalInteractables ?? 0} interactables, ${parsed.frame4?.totalWorkflows ?? 0} workflows, ${parsed.frame4?.totalActions ?? 0} actions`,
          keyRegions ? `suggested_regions: ${keyRegions}` : "",
          "",
          f1Text,
          "",
          `next: use frame_query(sessionId="${session.id}", query=...), frame_read(sessionId="${session.id}", layer=2|3|4, regions=[...]), or frame_plan(sessionId="${session.id}", goal=...).`,
        ]
          .filter((line) => line !== undefined)
          .join("\n");

        this.store.recordEmission(session, out);
        return { content: [{ type: "text", text: out }] };
      }

      if (name === "frame_read") {
        const sessionId = String(args.sessionId ?? "");
        const layer = Number(args.layer) as FrameLayer;
        if (![1, 2, 3, 4].includes(layer)) {
          throw new Error("layer must be 1, 2, 3, or 4");
        }
        const read = this.store.readLayer(sessionId, {
          layer,
          regions: Array.isArray(args.regions) ? args.regions.map(String) : undefined,
          kinds: Array.isArray(args.kinds) ? args.kinds.map(String) : undefined,
          effects: Array.isArray(args.effects) ? args.effects.map(String) : undefined,
          maxTokens: typeof args.maxTokens === "number" ? args.maxTokens : 900,
          offset: typeof args.offset === "number" ? args.offset : 0,
        });

        const footer = read.truncated
          ? `\n[truncated: returned ${read.returned}/${read.total} lines (~${read.tokens}tok). Pass offset=${read.nextOffset} for more.]`
          : `\n[complete: ${read.returned}/${read.total} lines (~${read.tokens}tok)]`;

        return {
          content: [{ type: "text", text: `${read.header}\n${read.body}${footer}` }],
        };
      }

      if (name === "frame_query") {
        const sessionId = String(args.sessionId ?? "");
        const query = String(args.query ?? "");
        const layers = Array.isArray(args.layers)
          ? (args.layers.map(Number).filter((n) => [1, 2, 3, 4].includes(n)) as FrameLayer[])
          : undefined;
        const limit = typeof args.limit === "number" ? args.limit : 8;
        const matches = this.store.query(sessionId, query, { layers, limit });
        const session = this.store.get(sessionId);

        const lines = [`# QUERY "${query}" (${matches.length} matches in ${sessionId})`];
        for (const m of matches) {
          lines.push(
            `- L${m.layer} ${m.id} @${m.structureId} (${m.score.toFixed(1)}): ${m.summary}${m.extra ? ` | ${m.extra}` : ""}`,
          );
        }
        if (matches.length === 0) lines.push("(no matches — try broader keywords or frame_read)");
        const text = lines.join("\n");
        this.store.recordEmission(session, text);
        return { content: [{ type: "text", text }] };
      }

      if (name === "frame_plan") {
        const sessionId = String(args.sessionId ?? "");
        const goal = String(args.goal ?? "");
        const matches = this.store.plan(sessionId, goal, {
          regions: Array.isArray(args.regions) ? args.regions.map(String) : undefined,
          allowDestructive: typeof args.allowDestructive === "boolean" ? args.allowDestructive : true,
          limit: typeof args.limit === "number" ? args.limit : 5,
        });
        const session = this.store.get(sessionId);

        const lines = [`# ZERO-AI ACTION PLAN: "${goal}" (${sessionId})`];
        if (matches.length === 0) {
          lines.push("(no matching actions found)");
        } else {
          for (const m of matches) {
            const a = m.action;
            const steps = a.steps
              .map((s) => `${s.op}(${s.ref}:${s.selector}${s.param ? ` <- ${s.param}` : ""})`)
              .join(" -> ");
            const pre = a.preconditions.length ? `\n    preconditions: ${a.preconditions.join("; ")}` : "";
            const warn = a.effect === "destructive" ? " [CONFIRM WITH USER]" : "";
            lines.push(
              `- [${m.score.toFixed(2)}] ${a.id} @${a.structureId} [${a.category}|${a.effect}]${warn} ${a.summary}\n    steps: ${steps}${pre}`,
            );
          }
        }
        const text = lines.join("\n");
        this.store.recordEmission(session, text);
        return { content: [{ type: "text", text }] };
      }

      if (name === "frame_inspect") {
        const sessionId = String(args.sessionId ?? "");
        const ref = String(args.ref ?? "");
        const lineage = this.store.inspect(sessionId, ref);
        const session = this.store.get(sessionId);

        const lines: string[] = [`# LINEAGE FOR ${lineage.ref} (Layer ${lineage.layer}, ${sessionId})`];
        lines.push(
          `F1 structures: ${lineage.structures.map((s) => `${s.id}[${s.role}:"${s.label}"]`).join(" > ") || "-"}`,
        );
        lines.push(
          `F2 texts (${lineage.texts.length}):`,
          ...lineage.texts.slice(0, 8).map((t) => `  - ${t.id} [${t.kind}] ${t.text}`),
        );
        lines.push(
          `F3 interactables (${lineage.interactables.length}):`,
          ...lineage.interactables.slice(0, 10).map((i) => `  - ${i.id} [${i.kind}] "${i.name}" -> ${i.selector}`),
        );
        lines.push(
          `F4 actions (${lineage.actions.length}):`,
          ...lineage.actions.slice(0, 8).map(
            (a) =>
              `  - ${a.id} [${a.category}|${a.effect}] ${a.summary} | steps: ${a.steps.map((s) => `${s.op}(${s.ref})`).join(" -> ")}`,
          ),
        );

        const text = lines.join("\n");
        this.store.recordEmission(session, text);
        return { content: [{ type: "text", text }] };
      }

      if (name === "frame_diff") {
        const sessionId = String(args.sessionId ?? "");
        const { formatted, tokens, learnedOutcome } = await this.store.diffAndUpdate(sessionId, {
          url: typeof args.url === "string" ? args.url : undefined,
          html: typeof args.html === "string" ? args.html : undefined,
          snapshot:
            args.snapshot && typeof args.snapshot === "object"
              ? (args.snapshot as LiveDomSnapshot)
              : undefined,
          fixture: typeof args.fixture === "string" ? args.fixture : undefined,
          executedActionId: typeof args.executedActionId === "string" ? args.executedActionId : undefined,
          updateSession: typeof args.updateSession === "boolean" ? args.updateSession : true,
        });
        const learnedNote = learnedOutcome ? `\n[cached outcome learned: ${learnedOutcome}]` : "";
        return {
          content: [{ type: "text", text: `${formatted}${learnedNote}\n[diff emitted ~${tokens}tok]` }],
        };
      }

      if (name === "frame_sessions") {
        const action = typeof args.action === "string" ? args.action : "list";
        if (action === "close") {
          const sid = String(args.sessionId ?? "");
          const closed = this.store.close(sid);
          return {
            content: [{ type: "text", text: closed ? `Closed session ${sid}` : `Session ${sid} not found` }],
          };
        }
        const list = this.store.list();
        return {
          content: [{ type: "text", text: JSON.stringify({ activeSessions: list }, null, 2) }],
        };
      }

      if (name === "frame_browser") {
        const driver = getSharedDriver();
        const action = typeof args.action === "string" ? args.action : "status";
        if (action === "status") {
          return { content: [{ type: "text", text: JSON.stringify(driver.status(), null, 2) }] };
        }
        if (action === "disconnect") {
          await driver.disconnect();
          return { content: [{ type: "text", text: "Disconnected CDP browser driver." }] };
        }
        if (action === "connect") {
          await driver.connect({
            browserURL: typeof args.browserURL === "string" ? args.browserURL : process.env.FRAMEPARSE_CDP_URL || "http://127.0.0.1:9222",
            wsEndpoint: typeof args.wsEndpoint === "string" ? args.wsEndpoint : undefined,
          });
          return { content: [{ type: "text", text: JSON.stringify({ ok: true, ...driver.status() }, null, 2) }] };
        }
        if (action === "launch") {
          await driver.launch({
            headless: typeof args.headless === "boolean" ? args.headless : true,
            executablePath: typeof args.executablePath === "string" ? args.executablePath : undefined,
          });
          return { content: [{ type: "text", text: JSON.stringify({ ok: true, ...driver.status() }, null, 2) }] };
        }
        if (action === "navigate") {
          const url = String(args.url ?? "");
          if (!url) throw new Error("url required for navigate");
          if (!driver.status().connected) {
            await driver.connect({
              browserURL: typeof args.browserURL === "string" ? args.browserURL : process.env.FRAMEPARSE_CDP_URL || "http://127.0.0.1:9222",
            });
          }
          await driver.navigate(url);
          return { content: [{ type: "text", text: JSON.stringify({ ok: true, ...driver.status() }, null, 2) }] };
        }
        if (action === "open") {
          if (!driver.status().connected) {
            await driver.connect({
              browserURL: typeof args.browserURL === "string" ? args.browserURL : process.env.FRAMEPARSE_CDP_URL || "http://127.0.0.1:9222",
            });
          }
          if (typeof args.url === "string" && args.url) {
            await driver.navigate(args.url);
          }
          const snapshot = await driver.extractSnapshot();
          const session = await this.store.open({
            snapshot,
            url: snapshot.url,
            sessionId: typeof args.sessionId === "string" ? args.sessionId : undefined,
          });
          const f1Text = formatFrame1ForAI(session.parsed.frame1);
          const out = [
            `sessionId: ${session.id} | LIVE CDP snapshot | raw≈${session.parsed.metrics.estimatedRawTokens}tok -> frame1=${session.parsed.metrics.frame1Tokens}tok`,
            `totals: ${session.parsed.frame1.landmarks.length} landmarks, ${session.parsed.frame2?.totalBlocks ?? 0} text, ${session.parsed.frame3?.totalInteractables ?? 0} interactables, ${session.parsed.frame4?.totalActions ?? 0} actions`,
            `browser: ${snapshot.url}`,
            "",
            f1Text,
            "",
            `next: frame_act({ sessionId: "${session.id}", ref: "i#" | goal }) or frame_scroll(...)`,
          ].join("\n");
          this.store.recordEmission(session, out);
          return { content: [{ type: "text", text: out }] };
        }
        throw new Error(`Unknown frame_browser action: ${action}`);
      }

      if (name === "frame_act") {
        const sessionId = String(args.sessionId ?? "");
        const session = this.store.get(sessionId);
        const driver = getSharedDriver();
        if (!driver.status().connected) {
          throw new Error('Browser not connected. Call frame_browser({ action: "connect" | "launch" }) first.');
        }
        const params =
          args.params && typeof args.params === "object"
            ? (args.params as Record<string, string | number | boolean | undefined>)
            : undefined;
        const result = await executeAct({
          driver,
          parsed: session.parsed,
          ref: typeof args.ref === "string" ? args.ref : undefined,
          goal: typeof args.goal === "string" ? args.goal : undefined,
          params,
          allowDestructive: Boolean(args.confirmDestructive),
          reobserve: typeof args.reobserve === "boolean" ? args.reobserve : true,
        });

        if (result.parsedAfter && result.snapshot) {
          await this.store.diffAndUpdate(sessionId, {
            snapshot: result.snapshot,
            executedActionId: result.resolved.actionId,
            updateSession: true,
          });
        }

        const lines = [
          `# FRAME ACT ${result.resolved.actionId || ""} [${result.resolved.effect}] ${result.resolved.summary}`,
          `steps: ${result.resolved.steps.map((s) => `${s.op}(${s.ref})`).join(" -> ")}`,
          `results: ${result.stepResults.map((r) => (r.ok ? "ok" : `fail:${r.error}`)).join(", ")}`,
          result.diffText ? `\n${result.diffText}\n[diff ~${result.diffTokens}tok]` : "",
        ];
        const text = lines.filter(Boolean).join("\n");
        this.store.recordEmission(session, text);
        return { content: [{ type: "text", text }] };
      }

      if (name === "frame_scroll") {
        const sessionId = String(args.sessionId ?? "");
        const session = this.store.get(sessionId);
        const driver = getSharedDriver();
        if (!driver.status().connected) {
          throw new Error('Browser not connected. Call frame_browser({ action: "connect" | "launch" }) first.');
        }
        const op = String(args.op ?? "") as "into_view" | "by" | "to";
        if (!["into_view", "by", "to"].includes(op)) throw new Error("op must be into_view | by | to");
        const result = await executeScroll({
          driver,
          parsed: session.parsed,
          op,
          ref: typeof args.ref === "string" ? args.ref : undefined,
          dx: typeof args.dx === "number" ? args.dx : undefined,
          dy: typeof args.dy === "number" ? args.dy : undefined,
          x: typeof args.x === "number" ? args.x : undefined,
          y: typeof args.y === "number" ? args.y : undefined,
          target: args.target === "top" || args.target === "bottom" ? args.target : undefined,
          reobserve: typeof args.reobserve === "boolean" ? args.reobserve : true,
        });
        if (result.parsedAfter && result.snapshot) {
          await this.store.diffAndUpdate(sessionId, {
            snapshot: result.snapshot,
            updateSession: true,
          });
        }
        const text = [
          `# FRAME SCROLL ${op} ${args.ref || ""}`,
          `results: ${JSON.stringify(result.stepResults)}`,
          result.diffText ? `\n${result.diffText}` : "",
        ].join("\n");
        this.store.recordEmission(session, text);
        return { content: [{ type: "text", text }] };
      }

      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error in ${name}: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
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
