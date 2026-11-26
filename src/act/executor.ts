import { formatDiffForAI, estimateTokens } from "../formatter.js";
import { diffFrames } from "../diff.js";
import { parseLiveSnapshotFrames } from "../pipeline.js";
import type { ExecutionStep, LiveDomSnapshot, ParsedPageFrames } from "../types.js";
import type { BrowserDriver } from "./cdp-driver.js";
import { resolveAct, resolveScroll, type ActParams, type ResolvedAct } from "./resolve.js";

export interface ActExecutionResult {
  resolved: ResolvedAct;
  stepResults: Array<Record<string, unknown>>;
  snapshot?: LiveDomSnapshot;
  parsedAfter?: ParsedPageFrames;
  diffText?: string;
  diffTokens?: number;
}

function stepToCommand(step: ExecutionStep): Record<string, unknown> {
  const cmd: Record<string, unknown> = {
    op: step.op,
    selector: step.selector,
    value: step.value,
    url: step.url,
    dx: step.dx,
    dy: step.dy,
    x: step.x,
    y: step.y,
    key: step.key ?? (step.op === "press" ? step.value : undefined),
    timeoutMs: step.timeoutMs,
    ensureInView: true,
  };
  if (step.op === "scroll_to" && (step.value === "top" || step.value === "bottom")) {
    cmd.target = step.value;
  }
  return cmd;
}

export async function executeSteps(
  driver: BrowserDriver,
  steps: ExecutionStep[],
): Promise<Array<Record<string, unknown>>> {
  const results: Array<Record<string, unknown>> = [];
  for (const step of steps) {
    if (step.op === "wait" && step.timeoutMs) {
      await new Promise((r) => setTimeout(r, step.timeoutMs));
      results.push({ ok: true, op: "wait", waitedMs: step.timeoutMs });
      continue;
    }
    const result = await driver.runCommand(stepToCommand(step));
    results.push(result);
    if (result.ok === false) {
      throw new Error(
        `Actuation failed at ${step.op}(${step.ref}): ${result.error || "unknown"} selector=${step.selector}`,
      );
    }
    // Small settle delay after mutate navigations
    if (step.op === "click" || step.op === "submit" || step.op === "navigate") {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  return results;
}

export async function executeAct(input: {
  driver: BrowserDriver;
  parsed: ParsedPageFrames;
  ref?: string;
  goal?: string;
  steps?: ExecutionStep[];
  params?: ActParams;
  allowDestructive?: boolean;
  reobserve?: boolean;
}): Promise<ActExecutionResult> {
  const resolved = resolveAct({
    parsed: input.parsed,
    ref: input.ref,
    goal: input.goal,
    steps: input.steps,
    params: input.params,
    allowDestructive: input.allowDestructive,
  });

  // Auto scroll-into-view is handled in page runtime; execute steps
  const stepResults = await executeSteps(input.driver, resolved.steps);

  const out: ActExecutionResult = { resolved, stepResults };
  if (input.reobserve !== false) {
    const snapshot = await input.driver.extractSnapshot();
    const parsedAfter = parseLiveSnapshotFrames(snapshot, {
      url: snapshot.url,
      maxLayer: 4,
    });
    const diff = diffFrames(input.parsed, parsedAfter);
    const diffText = formatDiffForAI(diff);
    out.snapshot = snapshot;
    out.parsedAfter = parsedAfter;
    out.diffText = diffText;
    out.diffTokens = estimateTokens(diffText);
  }
  return out;
}

export async function executeScroll(input: {
  driver: BrowserDriver;
  parsed: ParsedPageFrames;
  op: "into_view" | "by" | "to";
  ref?: string;
  dx?: number;
  dy?: number;
  x?: number;
  y?: number;
  target?: "top" | "bottom";
  reobserve?: boolean;
}): Promise<ActExecutionResult> {
  const step = resolveScroll(input);
  return executeAct({
    driver: input.driver,
    parsed: input.parsed,
    steps: [step],
    reobserve: input.reobserve,
  });
}
