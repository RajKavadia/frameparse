import {
  buildSelectors,
  getInnerText,
  isHiddenElement,
  normalizeSpace,
  resolveUrl,
} from "./html-parser.js";
import type {
  DomDocument,
  DomElement,
  DomNode,
  InteractableElement,
  InteractableFrame,
  InteractableKind,
  InteractableState,
  SelectOption,
  StructureNode,
} from "./types.js";

const INTERACTIVE_ARIA_ROLES: Record<string, InteractableKind> = {
  link: "link",
  button: "button",
  textbox: "input",
  searchbox: "input",
  combobox: "select",
  listbox: "select",
  checkbox: "checkbox",
  radio: "radio",
  switch: "switch",
  tab: "tab",
  menuitem: "menuitem",
  menuitemcheckbox: "checkbox",
  menuitemradio: "radio",
};

export interface Frame3Options {
  url?: string;
  allowedStructureIds?: Set<string>;
  includeHidden?: boolean;
}

/**
 * Frame 3: Interactables
 * Builds a canonical registry of every interactive control (`i1`, `i2`, ...)
 * with accessible names, roles, states, form grouping, options, and deterministic selectors.
 */
export function buildInteractableFrame(
  doc: DomDocument,
  idMap: Map<string, DomElement>,
  landmarkMap: Map<string, StructureNode>,
  options: Frame3Options = {},
): InteractableFrame {
  const includeHidden = options.includeHidden ?? false;
  const allowed = options.allowedStructureIds;
  const labelForMap = buildLabelForMap(doc, includeHidden);

  const elements: InteractableElement[] = [];
  let seq = 1;

  const walk = (node: DomNode, currentFormId?: string): void => {
    if (node.type === "document") {
      for (const child of node.children) walk(child, currentFormId);
      return;
    }
    if (node.type !== "element") return;
    if (node.tag === "head") return;

    const hidden = isHiddenElement(node);
    if (!includeHidden && hidden) return;

    const detected = detectInteractable(node);
    let nextFormId = currentFormId;

    if (detected) {
      const id = `i${seq++}`;
      node.interactableId = id;

      const structureId = node.structureId ?? "s0";
      const name = resolveAccessibleName(node, idMap, labelForMap, includeHidden);
      const { primary, fallbacks } = buildSelectors(node);
      const state = extractState(node, hidden);

      const item: InteractableElement = {
        id,
        structureId,
        kind: detected.kind,
        role: detected.role,
        tag: node.tag,
        name,
        state,
        selector: primary,
        fallbackSelectors: fallbacks,
      };

      if (node.attrs.name) item.fieldName = node.attrs.name;
      if (node.attrs.placeholder) item.placeholder = normalizeSpace(node.attrs.placeholder);

      if (node.tag === "input") {
        item.inputType = (node.attrs.type || "text").toLowerCase();
        if (node.attrs.value !== undefined) item.value = node.attrs.value;
      } else if (node.tag === "textarea") {
        item.inputType = "textarea";
        const inner = getInnerText(node, includeHidden);
        if (inner) item.value = inner;
      } else if (node.tag === "select") {
        const opts = extractSelectOptions(node, includeHidden);
        item.options = opts;
        const selectedOpt = opts.find((o) => o.selected);
        if (selectedOpt) item.value = selectedOpt.value;
      } else if (node.tag === "a" && node.attrs.href) {
        item.href = resolveUrl(node.attrs.href, options.url);
      } else if (node.tag === "form") {
        item.formAction = resolveUrl(node.attrs.action, options.url) ?? options.url ?? "";
        item.formMethod = (node.attrs.method || "GET").toUpperCase();
        nextFormId = id;
      }

      if (currentFormId && node.tag !== "form") {
        item.formId = currentFormId;
      }

      const constraints = extractConstraints(node);
      if (constraints) item.constraints = constraints;

      // Update Frame 1 landmark stats
      const landmark = landmarkMap.get(structureId);
      if (landmark) {
        landmark.stats.interactables += 1;
        if (item.kind === "form") landmark.stats.forms += 1;
        else if (item.kind === "link") landmark.stats.links += 1;
        else if (item.kind === "button" || item.kind === "tab" || item.kind === "menuitem") {
          landmark.stats.buttons += 1;
        } else {
          landmark.stats.inputs += 1;
        }
      }

      if (!allowed || allowed.has(structureId)) {
        elements.push(item);
      }
    }

    // Do not descend into <select> children (already extracted as options)
    if (node.tag === "select") return;

    for (const child of node.children) {
      walk(child, nextFormId);
    }
  };

  walk(doc, undefined);

  return {
    layer: 3,
    name: "interactables",
    totalInteractables: elements.length,
    elements,
  };
}

function detectInteractable(el: DomElement): { kind: InteractableKind; role: string } | null {
  const ariaRole = (el.attrs.role || "").trim().toLowerCase();

  if (el.tag === "form") {
    return { kind: "form", role: ariaRole || "form" };
  }
  if (el.tag === "a" && "href" in el.attrs) {
    return { kind: "link", role: ariaRole || "link" };
  }
  if (el.tag === "button") {
    return { kind: "button", role: ariaRole || "button" };
  }
  if (el.tag === "textarea") {
    return { kind: "textarea", role: ariaRole || "textbox" };
  }
  if (el.tag === "select") {
    return { kind: "select", role: ariaRole || "combobox" };
  }
  if (el.tag === "summary") {
    return { kind: "summary", role: ariaRole || "button" };
  }
  if (el.tag === "input") {
    const type = (el.attrs.type || "text").toLowerCase();
    if (type === "hidden") return null;
    if (type === "submit" || type === "button" || type === "reset" || type === "image") {
      return { kind: "button", role: ariaRole || "button" };
    }
    if (type === "checkbox") {
      const kind = ariaRole === "switch" ? "switch" : "checkbox";
      return { kind, role: ariaRole || "checkbox" };
    }
    if (type === "radio") {
      return { kind: "radio", role: ariaRole || "radio" };
    }
    return { kind: "input", role: ariaRole || (type === "search" ? "searchbox" : "textbox") };
  }

  if (ariaRole && INTERACTIVE_ARIA_ROLES[ariaRole]) {
    return { kind: INTERACTIVE_ARIA_ROLES[ariaRole], role: ariaRole };
  }

  // Clickable non-semantic elements (Gap 2: div-soup JS listeners, cursor:pointer, React onClick, contenteditable)
  if (el.attrs["data-fp-clickable"] === "true") {
    const src = el.attrs["data-fp-click-source"];
    if (src === "contenteditable") return { kind: "textarea", role: ariaRole || "textbox" };
    return { kind: "button", role: ariaRole || "button" };
  }
  if (el.attrs.contenteditable === "true" || el.attrs.contenteditable === "") {
    return { kind: "textarea", role: ariaRole || "textbox" };
  }
  if ("onclick" in el.attrs || el.attrs.tabindex === "0") {
    return { kind: "button", role: ariaRole || "button" };
  }

  return null;
}

function buildLabelForMap(doc: DomDocument, includeHidden: boolean): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (node: DomNode) => {
    if (node.type === "element") {
      if (node.tag === "label" && node.attrs.for) {
        const text = getInnerText(node, includeHidden);
        if (text) map.set(node.attrs.for, text);
      }
      for (const child of node.children) walk(child);
    } else if (node.type === "document") {
      for (const child of node.children) walk(child);
    }
  };
  walk(doc);
  return map;
}

function findEnclosingLabelText(el: DomElement, includeHidden: boolean): string {
  let parent = el.parent;
  while (parent && parent.type === "element") {
    if (parent.tag === "label") {
      return getInnerText(parent, includeHidden);
    }
    parent = parent.parent;
  }
  return "";
}

function resolveAccessibleName(
  el: DomElement,
  idMap: Map<string, DomElement>,
  labelForMap: Map<string, string>,
  includeHidden: boolean,
): string {
  if (el.attrs["aria-label"]) {
    return normalizeSpace(el.attrs["aria-label"]);
  }
  if (el.attrs["aria-labelledby"]) {
    const parts = el.attrs["aria-labelledby"]
      .split(/\s+/)
      .map((id) => idMap.get(id))
      .filter((ref): ref is DomElement => Boolean(ref))
      .map((ref) => getInnerText(ref, includeHidden))
      .filter(Boolean);
    if (parts.length > 0) return normalizeSpace(parts.join(" "));
  }
  if (el.attrs.id && labelForMap.has(el.attrs.id)) {
    return labelForMap.get(el.attrs.id)!;
  }
  if (el.tag === "input" || el.tag === "select" || el.tag === "textarea") {
    const enclosing = findEnclosingLabelText(el, includeHidden);
    if (enclosing) return enclosing;
    if (el.attrs.placeholder) return normalizeSpace(el.attrs.placeholder);
    if (el.attrs.title) return normalizeSpace(el.attrs.title);
    if (el.attrs.value && ["submit", "button", "reset"].includes((el.attrs.type || "").toLowerCase())) {
      return normalizeSpace(el.attrs.value);
    }
    if (el.attrs.name) return el.attrs.name.replace(/[-_]+/g, " ").trim();
    return el.attrs.type || el.tag;
  }
  if (el.tag === "form") {
    if (el.attrs.name) return normalizeSpace(el.attrs.name);
    if (el.attrs.id) return el.attrs.id.replace(/[-_]+/g, " ").trim();
    if (el.attrs.action) return `Form (${el.attrs.action})`;
    return "Form";
  }

  const inner = getInnerText(el, includeHidden);
  if (inner) return inner.slice(0, 120);
  if (el.attrs.title) return normalizeSpace(el.attrs.title);
  if (el.attrs.alt) return normalizeSpace(el.attrs.alt);
  if (el.attrs["aria-describedby"]) {
    const descParts = el.attrs["aria-describedby"]
      .split(/\s+/)
      .map((id) => idMap.get(id))
      .filter((ref): ref is DomElement => Boolean(ref))
      .map((ref) => getInnerText(ref, includeHidden))
      .filter(Boolean);
    if (descParts.length > 0) return normalizeSpace(descParts.join(" ")).slice(0, 120);
  }
  // Gap 5A: Icon-only button / SVG title / class-name / data-testid proximity heuristics
  const iconName = inferIconOrProximityName(el);
  if (iconName) return iconName;
  if (el.attrs.href) return el.attrs.href;
  return el.tag;
}

const ICON_SEMANTIC_PATTERNS: Array<[RegExp, string]> = [
  [/\b(trash|delete|remove|bin|destroy|erase)\b/i, "Delete"],
  [/\b(close|dismiss|cancel|times|xmark)\b/i, "Close"],
  [/\b(search|magnify|find|lookup)\b/i, "Search"],
  [/\b(cart|bag|basket|checkout)\b/i, "Cart"],
  [/\b(edit|pencil|pen|modify)\b/i, "Edit"],
  [/\b(download|export)\b/i, "Download"],
  [/\b(upload|import)\b/i, "Upload"],
  [/\b(settings|gear|cog|config)\b/i, "Settings"],
  [/\b(filter|funnel|sort)\b/i, "Filter"],
  [/\b(menu|hamburger|bars|more|dots|ellipsis)\b/i, "Menu"],
  [/\b(logout|signout|exit)\b/i, "Sign Out"],
  [/\b(login|signin|user|profile|account)\b/i, "Account"],
  [/\b(plus|add|create|new)\b/i, "Add"],
  [/\b(share|copy|link)\b/i, "Share"],
  [/\b(heart|like|favorite|star|bookmark)\b/i, "Favorite"],
  [/\b(refresh|reload|sync)\b/i, "Refresh"],
  [/\b(next|chevron-right|arrow-right)\b/i, "Next"],
  [/\b(prev|previous|chevron-left|arrow-left|back)\b/i, "Previous"],
];

function inferIconOrProximityName(el: DomElement): string | null {
  const clues: string[] = [];
  if (el.attrs["data-testid"]) clues.push(el.attrs["data-testid"]);
  if (el.attrs["data-icon"]) clues.push(el.attrs["data-icon"]);
  if (el.attrs.id) clues.push(el.attrs.id);
  if (el.attrs.class) clues.push(el.attrs.class);

  // Inspect child <svg>, <i>, <span> for <title>, data-icon, class, aria-label, or .sr-only text
  const walk = (node: DomNode) => {
    if (node.type !== "element") return;
    if (node.tag === "title") {
      const t = getInnerText(node, true);
      if (t) clues.unshift(t);
    }
    if (node.attrs["data-icon"]) clues.push(node.attrs["data-icon"]);
    if (node.attrs["aria-label"]) clues.unshift(node.attrs["aria-label"]);
    if (node.attrs.class) {
      if (/\b(sr-only|visually-hidden|tooltip)\b/i.test(node.attrs.class)) {
        const t = getInnerText(node, true);
        if (t) clues.unshift(t);
      }
      clues.push(node.attrs.class);
    }
    for (const c of node.children) walk(c);
  };
  for (const c of el.children) walk(c);

  const combined = clues.join(" ").replace(/[-_]+/g, " ");
  for (const [re, label] of ICON_SEMANTIC_PATTERNS) {
    const match = re.exec(combined);
    if (match) {
      return `${label} (icon: ${match[1].toLowerCase()})`;
    }
  }
  return null;
}

function extractSelectOptions(selectEl: DomElement, includeHidden: boolean): SelectOption[] {
  const options: SelectOption[] = [];
  const walk = (node: DomNode) => {
    if (node.type !== "element") return;
    if (node.tag === "option") {
      const label = getInnerText(node, includeHidden);
      const value = node.attrs.value !== undefined ? node.attrs.value : label;
      options.push({
        value,
        label: label || value,
        selected: "selected" in node.attrs,
        disabled: "disabled" in node.attrs ? true : undefined,
      });
      return;
    }
    for (const child of node.children) walk(child);
  };
  for (const child of selectEl.children) walk(child);
  return options;
}

function extractState(el: DomElement, hidden: boolean): InteractableState {
  const state: InteractableState = {
    disabled: "disabled" in el.attrs || el.attrs["aria-disabled"] === "true",
    required: "required" in el.attrs || el.attrs["aria-required"] === "true",
    hidden,
  };

  if (
    el.tag === "input" &&
    ["checkbox", "radio"].includes((el.attrs.type || "").toLowerCase())
  ) {
    state.checked = "checked" in el.attrs || el.attrs["aria-checked"] === "true";
  } else if (el.attrs["aria-checked"] !== undefined) {
    state.checked = el.attrs["aria-checked"] === "true";
  }

  if (el.attrs["aria-expanded"] !== undefined) {
    state.expanded = el.attrs["aria-expanded"] === "true";
  }
  if ("readonly" in el.attrs || el.attrs["aria-readonly"] === "true") {
    state.readonly = true;
  }
  if (el.attrs["aria-invalid"] === "true") {
    state.invalid = true;
  }

  return state;
}

function extractConstraints(el: DomElement): InteractableElement["constraints"] | undefined {
  const c: NonNullable<InteractableElement["constraints"]> = {};
  let hasAny = false;

  if (el.attrs.minlength) {
    const n = Number.parseInt(el.attrs.minlength, 10);
    if (Number.isFinite(n)) {
      c.minLength = n;
      hasAny = true;
    }
  }
  if (el.attrs.maxlength) {
    const n = Number.parseInt(el.attrs.maxlength, 10);
    if (Number.isFinite(n)) {
      c.maxLength = n;
      hasAny = true;
    }
  }
  if (el.attrs.min) {
    c.min = el.attrs.min;
    hasAny = true;
  }
  if (el.attrs.max) {
    c.max = el.attrs.max;
    hasAny = true;
  }
  if (el.attrs.pattern) {
    c.pattern = el.attrs.pattern;
    hasAny = true;
  }
  if (el.attrs.accept) {
    c.accept = el.attrs.accept;
    hasAny = true;
  }
  if ("multiple" in el.attrs) {
    c.multiple = true;
    hasAny = true;
  }

  return hasAny ? c : undefined;
}
