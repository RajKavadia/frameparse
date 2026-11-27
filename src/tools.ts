import { formatFrame1ForAI } from "./formatter.js";
import type { SessionStore } from "./session-store.js";
import type { FrameLayer, LiveDomSnapshot } from "./types.js";

export const FRAME_TOOL_NAMES = [
  "frame_open",
  "frame_read",
  "frame_query",
  "frame_plan",
  "frame_inspect",
  "frame_diff",
  "frame_sessions",
  "frame_chain",
] as const;

export type FrameToolName = (typeof FRAME_TOOL_NAMES)[number];

export interface FrameToolResult {
  text: string;
  isError?: boolean;
  meta?: {
    sessionId?: string;
    topRef?: string;
    topActionId?: string;
    structureId?: string;
  };
}

export const MCP_TOOL_DEFINITIONS = [
  {
    name: "frame_open",
    description:
      "Parse a webpage (URL, raw HTML, live browser DOM snapshot from frameparse://browser-extractor.js, or built-in fixture) deterministically with zero AI, cache it in a session, and return ONLY Frame 1 (Structure, with repeated cards folded) + token compression telemetry (~120-250 tokens instead of 10k+ raw HTML). Always call this first before reading deeper layers.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        html: { type: "string" },
        snapshot: { type: "object" },
        fixture: { type: "string", enum: ["ecommerce", "dashboard", "dashboard-after"] },
        sessionId: { type: "string" },
        includeHidden: { type: "boolean" },
      },
    },
  },
  {
    name: "frame_read",
    description: "Read one frame layer (1-4) from a cached session with optional region scope and maxTokens budget.",
    inputSchema: {
      type: "object",
      required: ["sessionId", "layer"],
      properties: {
        sessionId: { type: "string" },
        layer: { type: "integer", enum: [1, 2, 3, 4] },
        regions: { type: "array", items: { type: "string" } },
        kinds: { type: "array", items: { type: "string" } },
        effects: { type: "array", items: { type: "string" } },
        maxTokens: { type: "integer" },
        offset: { type: "integer" },
      },
    },
  },
  {
    name: "frame_query",
    description: "Zero-AI cross-layer search across Frames 1-4 in a session.",
    inputSchema: {
      type: "object",
      required: ["sessionId", "query"],
      properties: {
        sessionId: { type: "string" },
        query: { type: "string" },
        layers: { type: "array", items: { type: "integer" } },
        limit: { type: "integer" },
      },
    },
  },
  {
    name: "frame_plan",
    description: "Zero-AI goal-to-action planner on Frame 4 workflows and atomic actions.",
    inputSchema: {
      type: "object",
      required: ["sessionId", "goal"],
      properties: {
        sessionId: { type: "string" },
        goal: { type: "string" },
        regions: { type: "array", items: { type: "string" } },
        allowDestructive: { type: "boolean" },
        limit: { type: "integer" },
      },
    },
  },
  {
    name: "frame_inspect",
    description: "Vertical cross-layer lineage X-ray for any ref (s#, t#, i#, w#, a#).",
    inputSchema: {
      type: "object",
      required: ["sessionId", "ref"],
      properties: { sessionId: { type: "string" }, ref: { type: "string" } },
    },
  },
  {
    name: "frame_diff",
    description: "Compact delta between cached session and new page state; optional executedActionId for learning.",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      properties: {
        sessionId: { type: "string" },
        url: { type: "string" },
        html: { type: "string" },
        snapshot: { type: "object" },
        fixture: { type: "string" },
        executedActionId: { type: "string" },
        updateSession: { type: "boolean" },
      },
    },
  },
  {
    name: "frame_sessions",
    description: "List or close cached sessions with token savings telemetry.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "close"] },
        sessionId: { type: "string" },
      },
    },
  },
  {
    name: "frame_chain",
    description:
      "Direct multi-step tool call chain in ONE invocation (no per-tool MCP round-trips). Run an ordered list of FrameParse tools with $sessionId, $prev.ref, $prev.actionId, and $steps.<alias>.* variable substitution. Supports named presets: orient_and_plan, query_then_inspect, plan_and_inspect, action_and_observe.",
    inputSchema: {
      type: "object",
      properties: {
        preset: {
          type: "string",
          enum: ["orient_and_plan", "query_then_inspect", "plan_and_inspect", "action_and_observe"],
        },
        presetArgs: { type: "object", description: "Arguments passed into the preset builder." },
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
        compact: {
          type: "boolean",
          description: "Merge step outputs into one compact text block (default: true).",
        },
        json: { type: "boolean", description: "Return structured JSON instead of compact text." },
      },
    },
  },
] as const;

/**
 * Executes a single FrameParse MCP tool directly against a SessionStore (zero JSON-RPC).
 */
export async function executeFrameTool(
  store: SessionStore,
  name: string,
  args: Record<string, unknown>,
): Promise<FrameToolResult> {
  try {
    if (name === "frame_open") {
      const session = await store.open({
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

      store.recordEmission(session, out);
      return {
        text: out,
        meta: { sessionId: session.id },
      };
    }

    if (name === "frame_read") {
      const sessionId = String(args.sessionId ?? "");
      const layer = Number(args.layer) as FrameLayer;
      if (![1, 2, 3, 4].includes(layer)) {
        throw new Error("layer must be 1, 2, 3, or 4");
      }
      const read = store.readLayer(sessionId, {
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
        text: `${read.header}\n${read.body}${footer}`,
        meta: { sessionId },
      };
    }

    if (name === "frame_query") {
      const sessionId = String(args.sessionId ?? "");
      const query = String(args.query ?? "");
      const layers = Array.isArray(args.layers)
        ? (args.layers.map(Number).filter((n) => [1, 2, 3, 4].includes(n)) as FrameLayer[])
        : undefined;
      const limit = typeof args.limit === "number" ? args.limit : 8;
      const matches = store.query(sessionId, query, { layers, limit });
      const session = store.get(sessionId);

      const lines = [`# QUERY "${query}" (${matches.length} matches in ${sessionId})`];
      for (const m of matches) {
        lines.push(
          `- L${m.layer} ${m.id} @${m.structureId} (${m.score.toFixed(1)}): ${m.summary}${m.extra ? ` | ${m.extra}` : ""}`,
        );
      }
      if (matches.length === 0) lines.push("(no matches — try broader keywords or frame_read)");
      const text = lines.join("\n");
      store.recordEmission(session, text);
      const top = matches[0];
      return {
        text,
        meta: {
          sessionId,
          topRef: top?.id,
          structureId: top?.structureId,
        },
      };
    }

    if (name === "frame_plan") {
      const sessionId = String(args.sessionId ?? "");
      const goal = String(args.goal ?? "");
      const matches = store.plan(sessionId, goal, {
        regions: Array.isArray(args.regions) ? args.regions.map(String) : undefined,
        allowDestructive: typeof args.allowDestructive === "boolean" ? args.allowDestructive : true,
        limit: typeof args.limit === "number" ? args.limit : 5,
      });
      const session = store.get(sessionId);

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
      store.recordEmission(session, text);
      const top = matches[0]?.action;
      return {
        text,
        meta: {
          sessionId,
          topActionId: top?.id,
          topRef: top?.id,
          structureId: top?.structureId,
        },
      };
    }

    if (name === "frame_inspect") {
      const sessionId = String(args.sessionId ?? "");
      const ref = String(args.ref ?? "");
      const lineage = store.inspect(sessionId, ref);
      const session = store.get(sessionId);

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
      store.recordEmission(session, text);
      return { text, meta: { sessionId, topRef: ref, structureId: lineage.structures.at(-1)?.id } };
    }

    if (name === "frame_diff") {
      const sessionId = String(args.sessionId ?? "");
      const { formatted, tokens, learnedOutcome } = await store.diffAndUpdate(sessionId, {
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
        text: `${formatted}${learnedNote}\n[diff emitted ~${tokens}tok]`,
        meta: { sessionId },
      };
    }

    if (name === "frame_sessions") {
      const action = typeof args.action === "string" ? args.action : "list";
      if (action === "close") {
        const sid = String(args.sessionId ?? "");
        const closed = store.close(sid);
        return { text: closed ? `Closed session ${sid}` : `Session ${sid} not found` };
      }
      const list = store.list();
      return { text: JSON.stringify({ activeSessions: list }, null, 2) };
    }

    return { isError: true, text: `Unknown tool: ${name}` };
  } catch (err) {
    return {
      isError: true,
      text: `Error in ${name}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function toMcpToolContent(result: FrameToolResult): {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
} {
  return {
    content: [{ type: "text", text: result.text }],
    ...(result.isError ? { isError: true } : {}),
  };
}