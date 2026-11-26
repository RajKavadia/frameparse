import type { DomDocument, DomElement, DomNode, DomText } from "./types.js";

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const RAW_TEXT_TAGS = new Set(["script", "style", "noscript", "template"]);

const AUTO_CLOSE_PARENT: Record<string, Set<string>> = {
  li: new Set(["li"]),
  dt: new Set(["dt", "dd"]),
  dd: new Set(["dt", "dd"]),
  option: new Set(["option"]),
  optgroup: new Set(["optgroup", "option"]),
  tr: new Set(["tr"]),
  td: new Set(["td", "th"]),
  th: new Set(["td", "th"]),
  p: new Set([
    "address",
    "article",
    "aside",
    "blockquote",
    "details",
    "dialog",
    "div",
    "dl",
    "fieldset",
    "figcaption",
    "figure",
    "footer",
    "form",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "hr",
    "main",
    "nav",
    "ol",
    "p",
    "pre",
    "section",
    "table",
    "ul",
  ]),
};

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
  copy: "©",
  reg: "®",
  trade: "™",
  euro: "€",
  pound: "£",
  yen: "¥",
  bull: "•",
  middot: "·",
  times: "×",
  rarr: "→",
  larr: "←",
};

export function decodeHtmlEntities(input: string): string {
  if (!input.includes("&")) return input;
  return input.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, code: string) => {
    if (code.startsWith("#x") || code.startsWith("#X")) {
      const cp = Number.parseInt(code.slice(2), 16);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
    }
    if (code.startsWith("#")) {
      const cp = Number.parseInt(code.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
    }
    const named = NAMED_ENTITIES[code.toLowerCase()];
    return named !== undefined ? named : match;
  });
}

export function normalizeSpace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

export function fnv1aHash(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function resolveUrl(raw: string | undefined, baseUrl?: string): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (
    trimmed.startsWith("#") ||
    trimmed.startsWith("mailto:") ||
    trimmed.startsWith("tel:") ||
    trimmed.startsWith("javascript:")
  ) {
    return trimmed;
  }
  if (!baseUrl) return trimmed;
  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return trimmed;
  }
}

/**
 * Fast, zero-dependency HTML5 tokenizer + lightweight DOM tree builder.
 * Immediately skips <script>, <style>, <noscript>, <template> bodies so large
 * SPA payloads parse in sub-millisecond to low-millisecond time.
 */
export function parseHtml(html: string): DomDocument {
  let nodeCounter = 0;
  const doc: DomDocument = {
    type: "document",
    nodeIndex: nodeCounter++,
    parent: null,
    children: [],
  };

  const stack: Array<DomDocument | DomElement> = [doc];
  const len = html.length;
  let pos = 0;

  while (pos < len) {
    const lt = html.indexOf("<", pos);
    if (lt === -1) {
      const tail = html.slice(pos);
      if (tail.length > 0) {
        appendText(stack[stack.length - 1], tail, nodeCounter++);
      }
      break;
    }

    if (lt > pos) {
      const textSlice = html.slice(pos, lt);
      appendText(stack[stack.length - 1], textSlice, nodeCounter++);
    }

    // Comment <!-- ... -->
    if (html.startsWith("<!--", lt)) {
      const endComment = html.indexOf("-->", lt + 4);
      pos = endComment === -1 ? len : endComment + 3;
      continue;
    }

    // DOCTYPE or processing instruction <! ... > or <? ... >
    const nextChar = html.charCodeAt(lt + 1);
    if (nextChar === 33 /* ! */ || nextChar === 63 /* ? */) {
      if (html.startsWith("<![CDATA[", lt)) {
        const endCdata = html.indexOf("]]>", lt + 9);
        pos = endCdata === -1 ? len : endCdata + 3;
      } else {
        const gt = html.indexOf(">", lt + 2);
        pos = gt === -1 ? len : gt + 1;
      }
      continue;
    }

    // Closing tag </tag>
    if (nextChar === 47 /* / */) {
      const gt = html.indexOf(">", lt + 2);
      if (gt === -1) break;
      const closeName = html.slice(lt + 2, gt).trim().toLowerCase();
      popUntilTag(stack, closeName);
      pos = gt + 1;
      continue;
    }

    // Opening tag <tag ...>
    const tagStart = lt + 1;
    let i = tagStart;
    while (i < len && isTagNameChar(html.charCodeAt(i))) i++;

    if (i === tagStart) {
      // Stray '<' treated as text
      appendText(stack[stack.length - 1], "<", nodeCounter++);
      pos = lt + 1;
      continue;
    }

    const tag = html.slice(tagStart, i).toLowerCase();
    const attrs: Record<string, string> = {};
    let selfClosing = false;

    // Parse attributes
    while (i < len) {
      while (i < len && isWhitespace(html.charCodeAt(i))) i++;
      if (i >= len) break;

      const ch = html.charCodeAt(i);
      if (ch === 62 /* > */) {
        i++;
        break;
      }
      if (ch === 47 /* / */) {
        selfClosing = true;
        i++;
        if (i < len && html.charCodeAt(i) === 62 /* > */) {
          i++;
          break;
        }
        continue;
      }

      const attrStart = i;
      while (
        i < len &&
        !isWhitespace(html.charCodeAt(i)) &&
        html.charCodeAt(i) !== 61 /* = */ &&
        html.charCodeAt(i) !== 62 /* > */ &&
        html.charCodeAt(i) !== 47 /* / */
      ) {
        i++;
      }
      const attrName = html.slice(attrStart, i).toLowerCase();
      while (i < len && isWhitespace(html.charCodeAt(i))) i++;

      let attrValue = "";
      if (i < len && html.charCodeAt(i) === 61 /* = */) {
        i++;
        while (i < len && isWhitespace(html.charCodeAt(i))) i++;
        if (i < len) {
          const quote = html.charCodeAt(i);
          if (quote === 34 /* " */ || quote === 39 /* ' */) {
            i++;
            const valStart = i;
            const endQuote = html.indexOf(quote === 34 ? '"' : "'", i);
            if (endQuote === -1) {
              attrValue = decodeHtmlEntities(html.slice(valStart));
              i = len;
            } else {
              attrValue = decodeHtmlEntities(html.slice(valStart, endQuote));
              i = endQuote + 1;
            }
          } else {
            const valStart = i;
            while (
              i < len &&
              !isWhitespace(html.charCodeAt(i)) &&
              html.charCodeAt(i) !== 62 /* > */
            ) {
              i++;
            }
            attrValue = decodeHtmlEntities(html.slice(valStart, i));
          }
        }
      } else {
        // Boolean attribute (e.g. disabled, checked, required)
        attrValue = "";
      }

      if (attrName) {
        attrs[attrName] = attrValue;
      }
    }

    pos = i;

    // Skip raw text tags (<script>, <style>, <noscript>, <template>) immediately
    // Exception: Declarative Shadow DOM (<template shadowrootmode="open">) is parsed!
    const isDeclarativeShadow = tag === "template" && "shadowrootmode" in attrs;
    if (RAW_TEXT_TAGS.has(tag) && !isDeclarativeShadow) {
      if (!selfClosing) {
        const closeRe = new RegExp(`</${tag}\\s*>`, "i");
        const rest = html.slice(pos);
        const match = closeRe.exec(rest);
        pos = match ? pos + match.index + match[0].length : len;
      }
      continue;
    }

    // Handle auto-closing tags (e.g. unclosed <p>, <li>, <option>, <td>)
    const top = stack[stack.length - 1];
    if (top.type === "element") {
      const autoCloseSet = AUTO_CLOSE_PARENT[top.tag];
      if (autoCloseSet && autoCloseSet.has(tag)) {
        stack.pop();
      }
    }

    const parent = stack[stack.length - 1];
    const element: DomElement = {
      type: "element",
      nodeIndex: nodeCounter++,
      parent,
      tag,
      attrs,
      children: [],
    };
    parent.children.push(element);

    if (!selfClosing && !VOID_TAGS.has(tag)) {
      stack.push(element);
    }
  }

  return doc;
}

function appendText(parent: DomDocument | DomElement, raw: string, nodeIndex: number): void {
  const decoded = decodeHtmlEntities(raw);
  if (!decoded) return;
  const textNode: DomText = {
    type: "text",
    nodeIndex,
    parent,
    value: decoded,
  };
  parent.children.push(textNode);
}

function popUntilTag(stack: Array<DomDocument | DomElement>, closeName: string): void {
  for (let i = stack.length - 1; i >= 1; i--) {
    const node = stack[i];
    if (node.type === "element" && node.tag === closeName) {
      stack.length = i;
      return;
    }
  }
}

function isWhitespace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 12;
}

function isTagNameChar(code: number): boolean {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 45 ||
    code === 58 ||
    code === 95
  );
}

// ============================================================================
// DOM QUERY & INSPECTION HELPERS
// ============================================================================

export function isHiddenElement(el: DomElement): boolean {
  if (el.attrs["data-fp-hidden"] === "true") return true;
  if ("hidden" in el.attrs) return true;
  if (el.attrs["aria-hidden"] === "true") return true;
  if (el.tag === "input" && (el.attrs.type ?? "").toLowerCase() === "hidden") return true;
  const style = (el.attrs.style ?? "").toLowerCase().replace(/\s+/g, "");
  if (style.includes("display:none") || style.includes("visibility:hidden")) return true;
  return false;
}

export function getInnerText(node: DomNode, includeHidden = false): string {
  const parts: string[] = [];
  collectText(node, parts, includeHidden);
  return normalizeSpace(parts.join(" "));
}

function collectText(node: DomNode, parts: string[], includeHidden: boolean): void {
  if (node.type === "text") {
    const trimmed = node.value.trim();
    if (trimmed) parts.push(trimmed);
    return;
  }
  if (node.type === "element") {
    if (!includeHidden && isHiddenElement(node)) return;
    if (node.tag === "svg") {
      const label = node.attrs["aria-label"] || node.attrs.title;
      if (label) parts.push(label);
      return;
    }
    if (node.tag === "img") {
      const alt = node.attrs.alt?.trim();
      if (alt) parts.push(alt);
      return;
    }
    for (const child of node.children) {
      collectText(child, parts, includeHidden);
    }
    return;
  }
  for (const child of node.children) {
    collectText(child, parts, includeHidden);
  }
}

export function indexElementsById(doc: DomDocument): Map<string, DomElement> {
  const map = new Map<string, DomElement>();
  const walk = (node: DomNode) => {
    if (node.type === "element") {
      if (node.attrs.id && !map.has(node.attrs.id)) {
        map.set(node.attrs.id, node);
      }
      for (const child of node.children) walk(child);
    } else if (node.type === "document") {
      for (const child of node.children) walk(child);
    }
  };
  walk(doc);
  return map;
}

export function escapeCssAttr(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function buildSelectors(el: DomElement): { primary: string; fallbacks: string[] } {
  const candidates: string[] = [];

  const testId = el.attrs["data-testid"] || el.attrs["data-test"] || el.attrs["data-cy"];
  if (testId) {
    const attrName = el.attrs["data-testid"]
      ? "data-testid"
      : el.attrs["data-test"]
        ? "data-test"
        : "data-cy";
    candidates.push(`[${attrName}="${escapeCssAttr(testId)}"]`);
  }

  if (el.attrs.id && /^[a-zA-Z][\w-]*$/.test(el.attrs.id)) {
    candidates.push(`#${el.attrs.id}`);
  } else if (el.attrs.id) {
    candidates.push(`[id="${escapeCssAttr(el.attrs.id)}"]`);
  }

  if (el.attrs.name && (el.tag === "input" || el.tag === "select" || el.tag === "textarea" || el.tag === "button")) {
    candidates.push(`${el.tag}[name="${escapeCssAttr(el.attrs.name)}"]`);
  }

  if (el.attrs["aria-label"]) {
    candidates.push(`${el.tag}[aria-label="${escapeCssAttr(el.attrs["aria-label"])}"]`);
  }

  if (el.tag === "a" && el.attrs.href) {
    candidates.push(`a[href="${escapeCssAttr(el.attrs.href)}"]`);
  }

  // Structural CSS path fallback (guaranteed unique within document)
  candidates.push(buildCssPath(el));

  const deduped = Array.from(new Set(candidates));
  return {
    primary: deduped[0],
    fallbacks: deduped.slice(1, 4),
  };
}

export function buildCssPath(el: DomElement): string {
  const segments: string[] = [];
  let current: DomDocument | DomElement | null = el;
  let depth = 0;

  while (current && current.type === "element" && depth < 6) {
    const curEl: DomElement = current;
    if (curEl.attrs.id && /^[a-zA-Z][\w-]*$/.test(curEl.attrs.id) && segments.length > 0) {
      segments.unshift(`#${curEl.attrs.id}`);
      break;
    }

    let segment = curEl.tag;
    const parentNode: DomDocument | DomElement | null = curEl.parent;
    if (parentNode && (parentNode.type === "element" || parentNode.type === "document")) {
      const sameTagSiblings = parentNode.children.filter(
        (c): c is DomElement => c.type === "element" && c.tag === curEl.tag,
      );
      if (sameTagSiblings.length > 1) {
        const idx = sameTagSiblings.indexOf(curEl) + 1;
        segment += `:nth-of-type(${idx})`;
      }
    }

    segments.unshift(segment);
    if (curEl.tag === "body" || curEl.tag === "html") break;
    current = parentNode;
    depth++;
  }

  return segments.join(" > ");
}
