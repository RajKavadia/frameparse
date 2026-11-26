import type { DomDocument, DomElement, DomNode, LiveDomNodeSnapshot, LiveDomSnapshot } from "./types.js";

/**
 * Self-contained browser-side script (Gap 1, Gap 2, Gap 4).
 * Run inside Playwright (`page.evaluate`), Chrome DevTools, Puppeteer, Lightpanda,
 * or a browser extension to extract a live, post-hydration DOM snapshot including:
 *   - Open Shadow DOM (`el.shadowRoot`)
 *   - Same-origin `<iframe>` documents
 *   - Real computed CSS visibility & layout geometry (`getComputedStyle`, `getBoundingClientRect`)
 *   - "Div soup" JS-clickable controls (`cursor: pointer`, React `__reactProps$`, `onclick`, `tabindex`)
 *   - Live form values (`input.value`, `checked`, `selectedIndex`, `details.open`)
 */
export const LIVE_DOM_EXTRACTOR_SCRIPT = `(() => {
  const SKIP_TAGS = new Set(["script", "style", "noscript", "template"]);

  function isVisiblyHidden(el) {
    if (el.hidden) return true;
    if (el.getAttribute("aria-hidden") === "true") return true;
    if (el.tagName === "INPUT" && (el.type || "").toLowerCase() === "hidden") return true;
    try {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity) === 0) {
        return true;
      }
      if (style.display !== "contents" && el.tagName !== "BODY" && el.tagName !== "HTML" && el.tagName !== "HEAD") {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0 && el.children.length === 0) {
          return true;
        }
      }
    } catch {}
    return false;
  }

  function detectJsClickable(el) {
    const tag = el.tagName.toLowerCase();
    if (["a", "button", "input", "select", "textarea", "summary", "form", "body", "html", "main", "header", "footer", "nav"].includes(tag)) {
      return null;
    }
    if (typeof el.onclick === "function") return "onclick";
    if (el.isContentEditable) return "contenteditable";
    // Detect React synthetic event handlers (__reactProps$...)
    for (const k of Object.keys(el)) {
      if (k.startsWith("__reactProps$") || k.startsWith("__reactEventHandlers$")) {
        const props = el[k];
        if (props && (typeof props.onClick === "function" || typeof props.onMouseDown === "function")) {
          return "react-prop";
        }
      }
    }
    // Detect CSS cursor: pointer on compact interactive-sized elements (not giant page wrappers)
    try {
      const style = window.getComputedStyle(el);
      if (style.cursor === "pointer") {
        const parentStyle = el.parentElement ? window.getComputedStyle(el.parentElement) : null;
        if (!parentStyle || parentStyle.cursor !== "pointer") {
          const rect = el.getBoundingClientRect();
          if (rect.width > 4 && rect.height > 4 && rect.width < 900 && rect.height < 260) {
            return "cursor-pointer";
          }
        }
      }
    } catch {}
    return null;
  }

  function serialize(node, depth) {
    if (depth > 40) return null;
    if (node.nodeType === 3) {
      const val = (node.nodeValue || "").trim();
      if (!val) return null;
      return { type: "text", value: node.nodeValue };
    }
    if (node.nodeType !== 1) return null;

    const tag = node.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return null;

    const attrs = {};
    for (const attr of node.attributes || []) {
      attrs[attr.name.toLowerCase()] = attr.value;
    }

    if (tag !== "head" && tag !== "title" && tag !== "meta" && tag !== "link" && isVisiblyHidden(node)) {
      attrs["data-fp-hidden"] = "true";
    }

    const clickSource = detectJsClickable(node);
    if (clickSource) {
      attrs["data-fp-clickable"] = "true";
      attrs["data-fp-click-source"] = clickSource;
    }

    // Sync live DOM runtime state (SPAs mutate JS properties without updating HTML attributes)
    if (tag === "input") {
      if (typeof node.value === "string" && node.value.length > 0) attrs.value = node.value;
      if (node.type === "checkbox" || node.type === "radio") {
        if (node.checked) attrs.checked = "";
        else delete attrs.checked;
      }
      if (node.disabled) attrs.disabled = "";
    } else if (tag === "textarea") {
      if (typeof node.value === "string" && node.value.length > 0) attrs.value = node.value;
    } else if (tag === "select") {
      attrs["data-fp-selected-index"] = String(node.selectedIndex);
    } else if (tag === "details" && node.open) {
      attrs.open = "";
    }

    const children = [];

    // 1. Traverse open Shadow DOM
    if (node.shadowRoot) {
      attrs["data-fp-shadow-host"] = "true";
      for (const sc of node.shadowRoot.childNodes) {
        const ser = serialize(sc, depth + 1);
        if (ser) children.push(ser);
      }
    }

    // 2. Traverse same-origin iframe contentDocument
    if (tag === "iframe") {
      try {
        if (node.contentDocument && node.contentDocument.body) {
          attrs["data-fp-iframe-inlined"] = "true";
          const ser = serialize(node.contentDocument.body, depth + 1);
          if (ser) children.push(ser);
        }
      } catch {}
    }

    // 3. Regular light DOM children
    for (const child of node.childNodes) {
      const ser = serialize(child, depth + 1);
      if (ser) children.push(ser);
    }

    return { type: "element", tag, attrs, children };
  }

  return {
    url: window.location.href,
    title: document.title || "",
    root: serialize(document.documentElement, 0),
  };
})()`;

/**
 * Converts a LiveDomSnapshot (captured from Playwright, Chrome DevTools, or a browser
 * extension via LIVE_DOM_EXTRACTOR_SCRIPT) into a standard FrameParse DomDocument.
 */
export function snapshotToDomDocument(snapshot: LiveDomSnapshot): DomDocument {
  let nodeCounter = 0;
  const doc: DomDocument = {
    type: "document",
    nodeIndex: nodeCounter++,
    parent: null,
    children: [],
  };

  const buildNode = (
    snap: LiveDomNodeSnapshot,
    parent: DomDocument | DomElement,
  ): DomNode | null => {
    if (snap.type === "text") {
      if (!snap.value) return null;
      return {
        type: "text",
        nodeIndex: nodeCounter++,
        parent,
        value: snap.value,
      };
    }

    const el: DomElement = {
      type: "element",
      nodeIndex: nodeCounter++,
      parent,
      tag: (snap.tag || "div").toLowerCase(),
      attrs: { ...(snap.attrs || {}) },
      children: [],
    };

    if (snap.children) {
      for (const childSnap of snap.children) {
        const child = buildNode(childSnap, el);
        if (child) el.children.push(child);
      }
    }

    return el;
  };

  const rootNode = buildNode(snapshot.root, doc);
  if (rootNode) doc.children.push(rootNode);
  return doc;
}
