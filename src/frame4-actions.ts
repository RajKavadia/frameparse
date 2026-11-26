import type { ActionEffectCache } from "./action-cache.js";
import type {
  ActionCategory,
  ActionDestination,
  ActionEffect,
  ActionFrame,
  ActionParameter,
  ActionSpec,
  ActionVerb,
  ExecutionStep,
  InteractableElement,
  InteractableFrame,
  PlannedActionMatch,
} from "./types.js";

const DOWNLOAD_EXT_RE = /\.(pdf|zip|tar|gz|csv|json|xml|xlsx|xls|docx|doc|pptx|dmg|exe|apk|mp4|mp3)(\?.*)?$/i;

const DESTRUCTIVE_RE =
  /\b(delete|remove|destroy|revoke|terminate|purge|wipe|drop|erase|close account|deactivate|cancel subscription|unsubscribe)\b/i;
const COMMERCE_RE =
  /\b(add to cart|buy now|checkout|place order|pay now|complete purchase|purchase|subscribe|upgrade plan|cart|bag)\b/i;
const AUTH_RE =
  /\b(log ?in|sign ?in|sign ?up|register|create account|log ?out|sign ?out|forgot password|reset password|authenticate)\b/i;
const SEARCH_RE = /\b(search|find|lookup|query)\b/i;
const FILTER_RE = /\b(filter|sort|refine|clear filters|reset filters|apply filters)\b/i;
const PAGINATION_RE = /\b(next|prev|previous|load more|show more|page \d+|older|newer)\b/i;
const DISMISS_RE = /\b(close|dismiss|cancel|skip|got it|accept all|reject all|no thanks)\b/i;
const CREATE_SAVE_RE = /\b(create|new|add|save|submit|send|post|publish|update|apply|confirm|invite|export)\b/i;

/**
 * Frame 4: Actions
 * Deterministically infers what every interactable and form workflow is going
 * to do, its side-effect tier, preconditions, typed parameters, and executable steps.
 * Works 100% without AI.
 */
export function buildActionFrame(
  frame3: InteractableFrame,
  options: { url?: string; actionCache?: ActionEffectCache } = {},
): ActionFrame {
  const actions: ActionSpec[] = [];
  const workflows: ActionSpec[] = [];

  const byId = new Map<string, InteractableElement>();
  const formChildren = new Map<string, InteractableElement[]>();

  for (const el of frame3.elements) {
    byId.set(el.id, el);
    if (el.formId) {
      const list = formChildren.get(el.formId) ?? [];
      list.push(el);
      formChildren.set(el.formId, list);
    }
  }

  let actionSeq = 1;
  let workflowSeq = 1;

  for (const el of frame3.elements) {
    if (el.kind === "form") {
      const children = formChildren.get(el.id) ?? [];
      const workflow = buildFormWorkflow(`w${workflowSeq++}`, el, children, options.url);
      applyCachedOutcome(workflow, el.selector, options.url, options.actionCache);
      workflows.push(workflow);
      continue;
    }

    const parentForm = el.formId ? byId.get(el.formId) : undefined;
    const spec = buildElementAction(`a${actionSeq++}`, el, parentForm, options.url);
    applyCachedOutcome(spec, el.selector, options.url, options.actionCache);
    actions.push(spec);
  }

  return {
    layer: 4,
    name: "actions",
    totalActions: actions.length,
    totalWorkflows: workflows.length,
    actions,
    workflows,
  };
}

function applyCachedOutcome(
  spec: ActionSpec,
  selector: string,
  url: string | undefined,
  cache: ActionEffectCache | undefined,
): void {
  if (!cache) return;
  const cached = cache.get(url, selector);
  if (!cached) return;
  spec.cachedOutcome = cached;
  if (spec.effect === "read" && cached.observedEffect !== "read") {
    spec.effect = cached.observedEffect;
  }
  spec.summary = `${spec.summary} [learned: ${cached.summary}]`;
}

function buildElementAction(
  id: string,
  el: InteractableElement,
  parentForm: InteractableElement | undefined,
  baseUrl?: string,
): ActionSpec {
  const preconditions: string[] = [];
  if (el.state.disabled) {
    preconditions.push(`Element ${el.id} is currently disabled`);
  }
  if (el.state.readonly) {
    preconditions.push(`Element ${el.id} is read-only`);
  }

  // 1. Links
  if (el.kind === "link") {
    const href = el.href ?? "";
    const isAnchor = href.startsWith("#");
    const isDownload = DOWNLOAD_EXT_RE.test(href) || /\bdownload\b/i.test(el.name);
    const isExternal = isExternalUrl(href, baseUrl);
    const destination: ActionDestination = {
      url: href,
      isExternal,
      isAnchor,
      isDownload,
    };

    const verb: ActionVerb = isDownload ? "download" : "navigate";
    const category = classifyCategory(`${el.name} ${href}`, isDownload ? "download" : "navigation");
    const effect: ActionEffect = isDownload || isAnchor ? "read" : "navigate";

    let summary: string;
    if (isDownload) {
      summary = `Download resource "${el.name}" from ${href}`;
    } else if (isAnchor) {
      summary = `Jump to page section ${href} ("${el.name}")`;
    } else if (isExternal) {
      summary = `Navigate externally to ${href} ("${el.name}")`;
    } else {
      summary = `Navigate to ${href || "(current page)"} ("${el.name}")`;
    }

    return {
      id,
      targetId: el.id,
      structureId: el.structureId,
      verb,
      category,
      effect,
      isWorkflow: false,
      summary,
      preconditions,
      parameters: [],
      steps: [{ op: "click", ref: el.id, selector: el.selector, url: href || undefined }],
      destination,
    };
  }

  // 2. Text / typed inputs & textareas
  if (el.kind === "input" || el.kind === "textarea") {
    const paramName = el.fieldName || slugify(el.name) || el.id;
    const inputType = el.inputType || (el.kind === "textarea" ? "textarea" : "text");
    const category =
      inputType === "search"
        ? "search"
        : inputType === "password" || inputType === "email"
          ? classifyCategory(el.name, "auth")
          : classifyCategory(`${el.name} ${paramName}`, "general");

    const param: ActionParameter = {
      interactableId: el.id,
      name: paramName,
      label: el.name,
      type: inputType,
      required: el.state.required,
      currentValue: el.value,
      pattern: el.constraints?.pattern,
    };

    const reqTag = el.state.required ? " (required)" : "";
    const summary = `Fill ${inputType} field "${el.name}"${reqTag}`;

    return {
      id,
      targetId: el.id,
      structureId: el.structureId,
      verb: "fill",
      category,
      effect: "read",
      isWorkflow: false,
      summary,
      preconditions,
      parameters: [param],
      steps: [{ op: "fill", ref: el.id, selector: el.selector, param: paramName }],
    };
  }

  // 3. Select dropdowns
  if (el.kind === "select") {
    const paramName = el.fieldName || slugify(el.name) || el.id;
    const optionLabels = (el.options ?? []).filter((o) => !o.disabled).map((o) => o.label);
    const category = classifyCategory(`${el.name} ${paramName}`, "filter");
    const param: ActionParameter = {
      interactableId: el.id,
      name: paramName,
      label: el.name,
      type: "select",
      required: el.state.required,
      currentValue: el.value,
      options: optionLabels,
    };

    const preview = optionLabels.slice(0, 5).join(", ");
    const suffix = optionLabels.length > 5 ? `, +${optionLabels.length - 5} more` : "";
    const summary = `Select option for "${el.name}" [${preview}${suffix}]`;

    return {
      id,
      targetId: el.id,
      structureId: el.structureId,
      verb: "select",
      category,
      effect: "read",
      isWorkflow: false,
      summary,
      preconditions,
      parameters: [param],
      steps: [{ op: "select", ref: el.id, selector: el.selector, param: paramName }],
    };
  }

  // 4. Checkbox / Radio / Switch
  if (el.kind === "checkbox" || el.kind === "radio" || el.kind === "switch") {
    const stateDesc =
      el.state.checked === true
        ? "currently checked -> uncheck"
        : el.state.checked === false
          ? "currently unchecked -> check"
          : "toggle";
    const summary = `Toggle ${el.kind} "${el.name}" (${stateDesc})`;
    const category = classifyCategory(el.name, "filter");

    return {
      id,
      targetId: el.id,
      structureId: el.structureId,
      verb: "toggle",
      category,
      effect: "read",
      isWorkflow: false,
      summary,
      preconditions,
      parameters: [],
      steps: [{ op: "toggle", ref: el.id, selector: el.selector }],
    };
  }

  // 5. Summary / expandable disclosures
  if (el.kind === "summary" || el.state.expanded !== undefined) {
    const nextState = el.state.expanded ? "collapse" : "expand";
    const summary = `${capitalize(nextState)} section "${el.name}"`;
    return {
      id,
      targetId: el.id,
      structureId: el.structureId,
      verb: "expand",
      category: "general",
      effect: "read",
      isWorkflow: false,
      summary,
      preconditions,
      parameters: [],
      steps: [{ op: "click", ref: el.id, selector: el.selector }],
    };
  }

  // 6. Buttons, Tabs, Menuitems
  const isSubmitButton =
    Boolean(parentForm) &&
    (el.inputType === "submit" || (el.tag === "button" && el.inputType !== "button" && el.inputType !== "reset"));

  const signal = `${el.name} ${el.fieldName ?? ""} ${el.selector} ${parentForm?.formAction ?? ""}`;
  const category = classifyCategory(signal, isSubmitButton ? "form_submit" : "general");
  const effect = classifyEffect(signal, category, parentForm?.formMethod);
  const verb: ActionVerb = isSubmitButton ? "submit" : "click";

  let destination: ActionDestination | undefined;
  let summary: string;

  if (isSubmitButton && parentForm) {
    const method = parentForm.formMethod || "GET";
    const actionUrl = parentForm.formAction || baseUrl || "(current URL)";
    destination = {
      url: actionUrl,
      method,
      isExternal: isExternalUrl(actionUrl, baseUrl),
      isAnchor: false,
      isDownload: false,
    };
    summary = `Submit ${method} form "${parentForm.name}" via "${el.name}" to ${actionUrl}`;
  } else if (effect === "destructive") {
    summary = `Destructive action: click "${el.name}" (${el.kind})`;
  } else if (el.kind === "tab") {
    summary = `Switch to tab "${el.name}"`;
  } else if (el.kind === "menuitem") {
    summary = `Trigger menu action "${el.name}"`;
  } else {
    summary = `Click ${el.kind} "${el.name}" (${category})`;
  }

  return {
    id,
    targetId: el.id,
    structureId: el.structureId,
    verb,
    category,
    effect,
    isWorkflow: false,
    summary,
    preconditions,
    parameters: [],
    steps: [{ op: isSubmitButton ? "submit" : "click", ref: el.id, selector: el.selector }],
    destination,
  };
}

function buildFormWorkflow(
  id: string,
  form: InteractableElement,
  children: InteractableElement[],
  baseUrl?: string,
): ActionSpec {
  const inputs = children.filter(
    (c) =>
      c.kind === "input" ||
      c.kind === "textarea" ||
      c.kind === "select" ||
      c.kind === "checkbox" ||
      c.kind === "radio",
  );
  const submitBtn =
    children.find((c) => c.kind === "button" && c.inputType === "submit") ||
    children.find((c) => c.kind === "button" && c.inputType !== "reset" && c.inputType !== "button") ||
    children.find((c) => c.kind === "button");

  const parameters: ActionParameter[] = [];
  const steps: ExecutionStep[] = [];
  const preconditions: string[] = [];

  for (const input of inputs) {
    const paramName = input.fieldName || slugify(input.name) || input.id;
    const type =
      input.kind === "select"
        ? "select"
        : input.kind === "checkbox" || input.kind === "radio"
          ? input.kind
          : input.inputType || "text";

    parameters.push({
      interactableId: input.id,
      name: paramName,
      label: input.name,
      type,
      required: input.state.required,
      currentValue: input.value,
      options: input.options?.filter((o) => !o.disabled).map((o) => o.label),
      pattern: input.constraints?.pattern,
    });

    if (input.state.required) {
      preconditions.push(`Provide required "${input.name}" (${input.id})`);
    }

    if (input.kind === "select") {
      steps.push({ op: "select", ref: input.id, selector: input.selector, param: paramName });
    } else if (input.kind === "checkbox" || input.kind === "radio") {
      steps.push({ op: "toggle", ref: input.id, selector: input.selector, param: paramName });
    } else {
      steps.push({ op: "fill", ref: input.id, selector: input.selector, param: paramName });
    }
  }

  if (submitBtn) {
    steps.push({ op: "click", ref: submitBtn.id, selector: submitBtn.selector });
  } else {
    steps.push({ op: "submit", ref: form.id, selector: form.selector });
  }

  const method = form.formMethod || "GET";
  const actionUrl = form.formAction || baseUrl || "(current URL)";
  const signal = [
    form.name,
    form.formAction ?? "",
    submitBtn?.name ?? "",
    ...inputs.map((i) => `${i.name} ${i.inputType ?? ""} ${i.fieldName ?? ""}`),
  ].join(" ");

  const hasPassword = inputs.some((i) => i.inputType === "password");
  const hasSearch = inputs.some((i) => i.inputType === "search");
  const defaultCat: ActionCategory = hasPassword ? "auth" : hasSearch ? "search" : "form_submit";
  const category = classifyCategory(signal, defaultCat);
  const effect = classifyEffect(signal, category, method);

  const paramList = parameters
    .map((p) => `${p.name}${p.required ? "*" : ""}`)
    .join(", ");
  const summary = `Workflow (${category}): ${method} ${actionUrl}${paramList ? ` with [${paramList}]` : ""}${submitBtn ? ` -> click "${submitBtn.name}"` : ""}`;

  return {
    id,
    targetId: form.id,
    structureId: form.structureId,
    verb: "submit",
    category,
    effect,
    isWorkflow: true,
    summary,
    preconditions,
    parameters,
    steps,
    destination: {
      url: actionUrl,
      method,
      isExternal: isExternalUrl(actionUrl, baseUrl),
      isAnchor: false,
      isDownload: false,
    },
  };
}

function classifyCategory(signal: string, fallback: ActionCategory): ActionCategory {
  if (DESTRUCTIVE_RE.test(signal)) return "crud_delete";
  if (COMMERCE_RE.test(signal)) return "commerce";
  if (AUTH_RE.test(signal)) return "auth";
  if (SEARCH_RE.test(signal)) return "search";
  if (FILTER_RE.test(signal)) return "filter";
  if (PAGINATION_RE.test(signal)) return "pagination";
  if (DISMISS_RE.test(signal)) return "dismiss";
  if (CREATE_SAVE_RE.test(signal)) return fallback === "form_submit" ? "form_submit" : "crud_create";
  return fallback;
}

function classifyEffect(signal: string, category: ActionCategory, method?: string): ActionEffect {
  if (category === "crud_delete" || DESTRUCTIVE_RE.test(signal)) return "destructive";
  if (method && method.toUpperCase() === "DELETE") return "destructive";
  if (category === "search" || category === "filter") return "read";
  if (
    category === "commerce" ||
    category === "auth" ||
    category === "crud_create" ||
    category === "form_submit"
  ) {
    if (method && method.toUpperCase() === "GET" && category === "form_submit") return "navigate";
    return "mutate";
  }
  if (category === "navigation" || category === "pagination") return "navigate";
  return "read";
}

function isExternalUrl(url: string, baseUrl?: string): boolean {
  if (!url || !baseUrl) return false;
  if (url.startsWith("#") || url.startsWith("/")) return false;
  try {
    const a = new URL(url, baseUrl);
    const b = new URL(baseUrl);
    return a.origin !== b.origin;
  } catch {
    return false;
  }
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
}

function capitalize(str: string): string {
  return str.length ? str[0].toUpperCase() + str.slice(1) : str;
}

// ============================================================================
// ZERO-AI DETERMINISTIC ACTION PLANNER
// ============================================================================

const SYNONYM_GROUPS: string[][] = [
  ["login", "signin", "sign", "authenticate", "auth"],
  ["logout", "signout"],
  ["signup", "register", "join"],
  ["search", "find", "lookup", "query"],
  ["delete", "remove", "destroy", "erase", "revoke", "trash"],
  ["buy", "purchase", "checkout", "cart", "order"],
  ["next", "forward", "more"],
  ["prev", "previous", "back"],
  ["close", "dismiss", "cancel"],
  ["download", "export", "save"],
  ["filter", "sort", "refine"],
];

const SYNONYM_MAP = new Map<string, string[]>();
for (const group of SYNONYM_GROUPS) {
  for (const word of group) {
    SYNONYM_MAP.set(word, group);
  }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/**
 * Deterministically ranks Frame 4 actions & workflows against a natural-language
 * goal query using zero AI (pure lexical + synonym + verb/category matching).
 */
export function planAction(
  frame4: ActionFrame,
  goalQuery: string,
  options: { limit?: number; allowDestructive?: boolean } = {},
): PlannedActionMatch[] {
  const limit = options.limit ?? 5;
  const allowDestructive = options.allowDestructive ?? true;
  const queryTokens = tokenize(goalQuery);
  if (queryTokens.length === 0) return [];

  const expandedQuery = new Set<string>(queryTokens);
  for (const tok of queryTokens) {
    const syns = SYNONYM_MAP.get(tok);
    if (syns) {
      for (const s of syns) expandedQuery.add(s);
    }
  }

  const allCandidates = [...frame4.workflows, ...frame4.actions];
  const results: PlannedActionMatch[] = [];

  for (const action of allCandidates) {
    if (!allowDestructive && action.effect === "destructive") continue;

    const corpus = [
      action.summary,
      action.verb,
      action.category.replace("_", " "),
      action.destination?.url ?? "",
      ...action.parameters.map((p) => `${p.name} ${p.label} ${(p.options ?? []).join(" ")}`),
    ].join(" ");

    const docTokens = new Set(tokenize(corpus));
    let score = 0;
    const matchedTokens: string[] = [];

    for (const qTok of queryTokens) {
      if (docTokens.has(qTok)) {
        score += 3;
        matchedTokens.push(qTok);
      } else {
        const syns = SYNONYM_MAP.get(qTok);
        if (syns && syns.some((s) => docTokens.has(s))) {
          score += 2;
          matchedTokens.push(`${qTok}~`);
        } else {
          // Prefix match for stems (e.g. "pricing" vs "price", "searching" vs "search")
          for (const dTok of docTokens) {
            if (qTok.length >= 4 && dTok.length >= 4 && (dTok.startsWith(qTok.slice(0, 4)) || qTok.startsWith(dTok.slice(0, 4)))) {
              score += 1;
              matchedTokens.push(`${qTok}*`);
              break;
            }
          }
        }
      }
    }

    if (score === 0) continue;

    // Prefer composite workflows when they match (fewer round-trips for an AI agent)
    if (action.isWorkflow) score += 1.5;

    // Penalize disabled controls
    if (action.preconditions.some((p) => p.includes("currently disabled"))) {
      score *= 0.25;
    }

    const normalizedScore = Number((score / (queryTokens.length * 3 + 1.5)).toFixed(3));
    results.push({
      action,
      score: normalizedScore,
      matchedTokens,
      reason: `Matched [${matchedTokens.join(", ")}] on ${action.isWorkflow ? "workflow" : action.verb} (${action.category}, effect=${action.effect})`,
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
