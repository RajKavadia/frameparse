import { performance } from "node:perf_hooks";
import { estimateTokens } from "./formatter.js";
import type { SessionStore } from "./session-store.js";
import { type FrameToolName, executeFrameTool, type FrameToolResult } from "./tools.js";

export type ChainToolName = Exclude<FrameToolName, "frame_chain">;

export interface ToolChainStep {
  tool: ChainToolName;
  args?: Record<string, unknown>;
  /** Alias for $steps.<as>.* references in later steps */
  as?: string;
  stopOnError?: boolean;
}

export interface ToolChainRequest {
  steps?: ToolChainStep[];
  preset?: ChainPresetName;
  presetArgs?: Record<string, unknown>;
  /** Default true: one compact merged text for LLM context */
  compact?: boolean;
  /** Return structured JSON (steps[], totals) instead of compact text */
  json?: boolean;
}

export type ChainPresetName =
  | "orient_and_plan"
  | "query_then_inspect"
  | "plan_and_inspect"
  | "action_and_observe";

export interface ToolChainStepResult {
  index: number;
  tool: string;
  as?: string;
  ok: boolean;
  text: string;
  tokens: number;
  durationMs: number;
  sessionId?: string;
  topRef?: string;
  topActionId?: string;
  structureId?: string;
  error?: string;
}

export interface ToolChainResult {
  ok: boolean;
  sessionId: string | null;
  steps: ToolChainStepResult[];
  totalTokens: number;
  totalMs: number;
  compactText: string;
}

interface ChainContext {
  sessionId: string | null;
  prev: FrameToolResult["meta"];
  named: Record<string, (NonNullable<FrameToolResult["meta"]> & { text?: string }) | undefined>;
}

function extractSessionIdFromText(text: string): string | null {
  const m = /^sessionId:\s*([^\s|]+)/m.exec(text);
  return m ? m[1] : null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function resolveValue(value: unknown, ctx: ChainContext): unknown {
  if (typeof value !== "string") return value;
  if (value === "$sessionId") return ctx.sessionId;

  if (value === "$prev.ref") return ctx.prev?.topRef ?? ctx.prev?.topActionId;
  if (value === "$prev.actionId") return ctx.prev?.topActionId;
  if (value === "$prev.structureId") return ctx.prev?.structureId;

  const stepRef = /^\$steps\.([a-zA-Z0-9_-]+)\.ref$/.exec(value);
  if (stepRef) {
    const meta = ctx.named[stepRef[1]];
    return meta?.topRef ?? meta?.topActionId;
  }

  const stepSession = /^\$steps\.([a-zA-Z0-9_-]+)\.sessionId$/.exec(value);
  if (stepSession) return ctx.named[stepSession[1]]?.sessionId ?? ctx.sessionId;

  const stepAction = /^\$steps\.([a-zA-Z0-9_-]+)\.actionId$/.exec(value);
  if (stepAction) return ctx.named[stepAction[1]]?.topActionId;

  return value;
}

function resolveArgs(args: Record<string, unknown> | undefined, ctx: ChainContext): Record<string, unknown> {
  if (!args) return {};
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(args)) {
    if (Array.isArray(val)) {
      out[key] = val.map((item) => resolveValue(item, ctx));
    } else if (isPlainObject(val)) {
      out[key] = resolveArgs(val, ctx);
    } else {
      out[key] = resolveValue(val, ctx);
    }
  }
  return out;
}

export function buildChainPreset(
  preset: ChainPresetName,
  presetArgs: Record<string, unknown> = {},
): ToolChainStep[] {
  switch (preset) {
    case "orient_and_plan":
      return [
        {
          tool: "frame_open",
          as: "open",
          args: {
            url: presetArgs.url,
            html: presetArgs.html,
            fixture: presetArgs.fixture,
            snapshot: presetArgs.snapshot,
            sessionId: presetArgs.sessionId,
            includeHidden: presetArgs.includeHidden,
          },
        },
        {
          tool: "frame_plan",
          as: "plan",
          args: {
            sessionId: "$sessionId",
            goal: presetArgs.goal ?? "",
            regions: presetArgs.regions,
            allowDestructive: presetArgs.allowDestructive,
            limit: presetArgs.limit ?? 3,
          },
        },
      ];
    case "query_then_inspect":
      return [
        {
          tool: "frame_open",
          as: "open",
          args: {
            url: presetArgs.url,
            html: presetArgs.html,
            fixture: presetArgs.fixture,
            snapshot: presetArgs.snapshot,
          },
        },
        {
          tool: "frame_query",
          as: "query",
          args: {
            sessionId: "$sessionId",
            query: presetArgs.query ?? "",
            limit: presetArgs.limit ?? 5,
          },
        },
        {
          tool: "frame_inspect",
          as: "inspect",
          args: {
            sessionId: "$sessionId",
            ref: "$prev.ref",
          },
        },
      ];
    case "plan_and_inspect":
      return [
        {
          tool: "frame_open",
          as: "open",
          args: {
            url: presetArgs.url,
            html: presetArgs.html,
            fixture: presetArgs.fixture,
            snapshot: presetArgs.snapshot,
          },
        },
        {
          tool: "frame_plan",
          as: "plan",
          args: {
            sessionId: "$sessionId",
            goal: presetArgs.goal ?? "",
            limit: 2,
          },
        },
        {
          tool: "frame_inspect",
          as: "inspect",
          args: {
            sessionId: "$sessionId",
            ref: "$prev.actionId",
          },
        },
      ];
    case "action_and_observe":
      return [
        {
          tool: "frame_open",
          as: "before",
          args: {
            url: presetArgs.url,
            html: presetArgs.html,
            fixture: presetArgs.fixture,
            snapshot: presetArgs.snapshot,
          },
        },
        {
          tool: "frame_plan",
          as: "plan",
          args: {
            sessionId: "$sessionId",
            goal: presetArgs.goal ?? "",
            limit: 1,
          },
        },
        {
          tool: "frame_diff",
          as: "diff",
          args: {
            sessionId: "$sessionId",
            url: presetArgs.afterUrl,
            html: presetArgs.afterHtml,
            fixture: presetArgs.afterFixture,
            snapshot: presetArgs.afterSnapshot,
            executedActionId: "$steps.plan.actionId",
            updateSession: presetArgs.updateSession ?? true,
          },
        },
      ];
    default:
      throw new Error(`Unknown chain preset: ${preset}`);
  }
}

export function formatChainCompact(result: ToolChainResult): string {
  const lines = [
    `# FRAME CHAIN (${result.steps.length} steps, ${result.totalTokens}tok, ${result.totalMs.toFixed(1)}ms)`,
    `sessionId: ${result.sessionId ?? "-"}`,
    "",
  ];
  for (const step of result.steps) {
    const tag = step.ok ? "ok" : "ERR";
    lines.push(
      `--- step ${step.index + 1}: ${step.tool}${step.as ? ` (${step.as})` : ""} [${tag}, ${step.tokens}tok, ${step.durationMs}ms] ---`,
    );
    if (!step.ok && step.error) {
      lines.push(step.error);
    } else {
      const preview =
        step.text.length > 2200 ? `${step.text.slice(0, 2200)}\n...[truncated in chain compact view]` : step.text;
      lines.push(preview);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

/** Direct multi-step tool call chain (in-process, shared session). */
export async function executeToolChain(
  store: SessionStore,
  request: ToolChainRequest,
): Promise<ToolChainResult> {
  const t0 = performance.now();
  let steps: ToolChainStep[] = request.steps ?? [];
  if (request.preset) {
    steps = buildChainPreset(request.preset, request.presetArgs ?? {});
  }
  if (steps.length === 0) {
    throw new Error("frame_chain requires `steps` array or a `preset`.");
  }

  const ctx: ChainContext = { sessionId: null, prev: undefined, named: {} };
  const results: ToolChainStepResult[] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepT0 = performance.now();
    const resolvedArgs = resolveArgs(step.args, ctx);
    const toolResult = await executeFrameTool(store, step.tool, resolvedArgs);
    const durationMs = Number((performance.now() - stepT0).toFixed(2));
    const tokens = estimateTokens(toolResult.text);

    const sessionId =
      toolResult.meta?.sessionId ??
      (typeof resolvedArgs.sessionId === "string" ? resolvedArgs.sessionId : null) ??
      extractSessionIdFromText(toolResult.text) ??
      ctx.sessionId;

    if (sessionId) ctx.sessionId = sessionId;
    ctx.prev = toolResult.meta;
    if (step.as) {
      ctx.named[step.as] = { ...toolResult.meta, text: toolResult.text };
    }

    const stepResult: ToolChainStepResult = {
      index: i,
      tool: step.tool,
      as: step.as,
      ok: !toolResult.isError,
      text: toolResult.text,
      tokens,
      durationMs,
      sessionId: sessionId ?? undefined,
      topRef: toolResult.meta?.topRef,
      topActionId: toolResult.meta?.topActionId,
      structureId: toolResult.meta?.structureId,
      error: toolResult.isError ? toolResult.text : undefined,
    };
    results.push(stepResult);

    if (toolResult.isError && step.stopOnError !== false) {
      break;
    }
  }

  const totalMs = Number((performance.now() - t0).toFixed(2));
  const totalTokens = results.reduce((acc, r) => acc + r.tokens, 0);
  const chainResult: ToolChainResult = {
    ok: results.every((r) => r.ok),
    sessionId: ctx.sessionId,
    steps: results,
    totalTokens,
    totalMs,
    compactText: "",
  };
  chainResult.compactText = formatChainCompact(chainResult);
  return chainResult;
}

export function toolChainToFrameToolResult(
  chain: ToolChainResult,
  options: { json?: boolean } = {},
): FrameToolResult {
  if (options.json) {
    return {
      text: JSON.stringify(chain, null, 2),
      meta: { sessionId: chain.sessionId ?? undefined },
      ...(chain.ok ? {} : { isError: true }),
    };
  }
  return {
    text: chain.compactText,
    meta: { sessionId: chain.sessionId ?? undefined },
    ...(chain.ok ? {} : { isError: true }),
  };
}

export async function executeFrameChainTool(
  store: SessionStore,
  args: Record<string, unknown>,
): Promise<FrameToolResult> {
  const chain = await executeToolChain(store, {
    steps: Array.isArray(args.steps) ? (args.steps as ToolChainStep[]) : undefined,
    preset: typeof args.preset === "string" ? (args.preset as ChainPresetName) : undefined,
    presetArgs: isPlainObject(args.presetArgs) ? args.presetArgs : undefined,
    compact: args.compact !== false,
    json: Boolean(args.json),
  });
  return toolChainToFrameToolResult(chain, { json: Boolean(args.json) });
}