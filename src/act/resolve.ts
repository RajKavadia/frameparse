import { planAction } from "../frame4-actions.js";
import type {
  ActionEffect,
  ActionSpec,
  ExecutionStep,
  InteractableElement,
  ParsedPageFrames,
} from "../types.js";

export interface ActParams {
  [key: string]: string | number | boolean | undefined;
}

export interface ResolvedAct {
  actionId?: string;
  effect: ActionEffect;
  summary: string;
  steps: ExecutionStep[];
}

function allActions(parsed: ParsedPageFrames): ActionSpec[] {
  if (!parsed.frame4) return [];
  return [...parsed.frame4.workflows, ...parsed.frame4.actions];
}

function findInteractable(parsed: ParsedPageFrames, ref: string): InteractableElement | undefined {
  return parsed.frame3?.elements.find((e) => e.id === ref);
}

function interactableToSteps(el: InteractableElement, params?: ActParams): ExecutionStep[] {
  const value =
    params?.value ??
    params?.[el.fieldName || ""] ??
    params?.[el.name] ??
    params?.text ??
    params?.q;

  switch (el.kind) {
    case "input":
    case "textarea":
      return [
        {
          op: "fill",
          ref: el.id,
          selector: el.selector,
          value: value != null ? String(value) : el.value ?? "",
          param: el.fieldName,
        },
      ];
    case "select":
      return [
        {
          op: "select",
          ref: el.id,
          selector: el.selector,
          value: value != null ? String(value) : undefined,
          param: el.fieldName,
        },
      ];
    case "checkbox":
    case "radio":
      return [
        {
          op: "toggle",
          ref: el.id,
          selector: el.selector,
          value: value != null ? String(value) : undefined,
        },
      ];
    case "form":
      return [{ op: "submit", ref: el.id, selector: el.selector }];
    default:
      return [
        {
          op: "click",
          ref: el.id,
          selector: el.selector,
          url: el.href,
        },
      ];
  }
}

function applyParams(steps: ExecutionStep[], params?: ActParams): ExecutionStep[] {
  if (!params) return steps;
  return steps.map((step) => {
    if (step.op === "fill" || step.op === "type" || step.op === "select" || step.op === "toggle") {
      const fromParam =
        (step.param && params[step.param] != null ? params[step.param] : undefined) ??
        params.value ??
        params.text ??
        params.q;
      if (fromParam != null) return { ...step, value: String(fromParam) };
    }
    if (step.op === "press" && (params.key != null || params.value != null)) {
      return { ...step, key: String(params.key ?? params.value) };
    }
    if (step.op === "navigate" && params.url != null) {
      return { ...step, url: String(params.url) };
    }
    return step;
  });
}

/**
 * Resolve a frame ref (i#/a#/w#), goal, or explicit steps into an executable plan.
 */
export function resolveAct(input: {
  parsed: ParsedPageFrames;
  ref?: string;
  goal?: string;
  steps?: ExecutionStep[];
  params?: ActParams;
  allowDestructive?: boolean;
}): ResolvedAct {
  const { parsed, params, allowDestructive = false } = input;

  if (input.steps?.length) {
    return {
      effect: "mutate",
      summary: `custom ${input.steps.length} step(s)`,
      steps: applyParams(input.steps, params),
    };
  }

  if (input.ref) {
    const ref = input.ref.trim();
    const actions = allActions(parsed);
    const action = actions.find((a) => a.id === ref);
    if (action) {
      if (action.effect === "destructive" && !allowDestructive) {
        throw new Error(
          `Ref ${ref} is destructive (${action.summary}). Pass confirmDestructive/allowDestructive: true after user confirmation.`,
        );
      }
      return {
        actionId: action.id,
        effect: action.effect,
        summary: action.summary,
        steps: applyParams(action.steps, params),
      };
    }

    const el = findInteractable(parsed, ref);
    if (el) {
      return {
        effect: el.kind === "link" ? "navigate" : "mutate",
        summary: `${el.kind} "${el.name}"`,
        steps: applyParams(interactableToSteps(el, params), params),
      };
    }

    // Structure landmark → scroll into view of first interactable in region, else scroll_to via selector if any
    const landmark = parsed.frame1.landmarks.find((l) => l.id === ref);
    if (landmark) {
      const child = parsed.frame3?.elements.find((e) => e.structureId === ref);
      if (child) {
        return {
          effect: "read",
          summary: `scroll region ${ref} via ${child.id}`,
          steps: [{ op: "scroll_into_view", ref: child.id, selector: child.selector }],
        };
      }
      throw new Error(`Structure ${ref} has no interactable to scroll into view`);
    }

    throw new Error(`Unknown ref "${ref}". Use i# / a# / w# / s# from FrameParse.`);
  }

  if (input.goal) {
    if (!parsed.frame4) throw new Error("Frame 4 missing — cannot plan goal");
    const matches = planAction(parsed.frame4, input.goal, {
      allowDestructive,
      limit: 1,
    });
    if (!matches.length) throw new Error(`No Frame 4 action matched goal: ${input.goal}`);
    const top = matches[0].action;
    if (top.effect === "destructive" && !allowDestructive) {
      throw new Error(
        `Top plan ${top.id} is destructive (${top.summary}). Pass confirmDestructive: true after user confirmation.`,
      );
    }
    return {
      actionId: top.id,
      effect: top.effect,
      summary: top.summary,
      steps: applyParams(top.steps, params),
    };
  }

  throw new Error("Provide ref (i#/a#/w#), goal, or steps");
}

export function resolveScroll(input: {
  parsed: ParsedPageFrames;
  op: "into_view" | "by" | "to";
  ref?: string;
  dx?: number;
  dy?: number;
  x?: number;
  y?: number;
  target?: "top" | "bottom";
}): ExecutionStep {
  if (input.op === "into_view") {
    if (!input.ref) throw new Error("scroll into_view requires ref");
    const resolved = resolveAct({ parsed: input.parsed, ref: input.ref });
    const sel =
      resolved.steps.find((s) => s.selector)?.selector ||
      findInteractable(input.parsed, input.ref)?.selector;
    if (!sel) throw new Error(`No selector for ref ${input.ref}`);
    return { op: "scroll_into_view", ref: input.ref, selector: sel };
  }
  if (input.op === "by") {
    return {
      op: "scroll_by",
      ref: input.ref || "page",
      selector: input.ref ? findInteractable(input.parsed, input.ref)?.selector || "" : "",
      dx: input.dx ?? 0,
      dy: input.dy ?? 0,
    };
  }
  // to
  if (input.target === "top" || input.target === "bottom") {
    return {
      op: "scroll_to",
      ref: "page",
      selector: "",
      value: input.target,
    };
  }
  if (input.ref) {
    const el = findInteractable(input.parsed, input.ref);
    if (!el) throw new Error(`Unknown ref for scroll_to: ${input.ref}`);
    return { op: "scroll_to", ref: input.ref, selector: el.selector, dx: input.dx, dy: input.dy };
  }
  return {
    op: "scroll_to",
    ref: "page",
    selector: "",
    x: input.x ?? 0,
    y: input.y ?? 0,
  };
}
