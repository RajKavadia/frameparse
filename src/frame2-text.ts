import { countWords, getInnerText, isHiddenElement, normalizeSpace } from "./html-parser.js";
import type {
  DomDocument,
  DomElement,
  DomNode,
  StructureNode,
  TextBlock,
  TextBlockKind,
  TextFrame,
} from "./types.js";

const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const BLOCK_TEXT_TAGS = new Set([
  "p",
  "li",
  "dt",
  "dd",
  "blockquote",
  "pre",
  "figcaption",
  "caption",
  "label",
  "legend",
  "summary",
]);

const SKIP_SUBTREE_FOR_TEXT = new Set(["head", "script", "style", "noscript", "template", "select", "svg"]);

export interface Frame2Options {
  allowedStructureIds?: Set<string>;
  includeHidden?: boolean;
  minTextLength?: number;
}

/**
 * Frame 2: Text
 * Extracts deduplicated, noise-stripped readable text blocks anchored to their
 * Frame 1 `structureId` so AI agents can read only the regions they care about.
 */
export function buildTextFrame(
  doc: DomDocument,
  landmarkMap: Map<string, StructureNode>,
  options: Frame2Options = {},
): TextFrame {
  const includeHidden = options.includeHidden ?? false;
  const minTextLength = options.minTextLength ?? 2;
  const allowed = options.allowedStructureIds;

  const blocks: TextBlock[] = [];
  const seenPerStructure = new Set<string>();
  let seq = 1;
  let totalWords = 0;

  const emitBlock = (
    structureId: string,
    kind: TextBlockKind,
    rawText: string,
    level?: number,
    linkedInteractableIds?: string[],
  ): void => {
    const text = normalizeSpace(rawText);
    if (text.length < minTextLength) return;

    const dedupeKey = `${structureId}::${kind}::${text}`;
    if (seenPerStructure.has(dedupeKey)) return;
    seenPerStructure.add(dedupeKey);

    const words = countWords(text);
    const landmark = landmarkMap.get(structureId);
    if (landmark) {
      landmark.stats.textBlocks += 1;
      landmark.stats.wordCount += words;
    }

    if (allowed && !allowed.has(structureId)) return;

    totalWords += words;
    const block: TextBlock = {
      id: `t${seq++}`,
      structureId,
      kind,
      text,
      wordCount: words,
    };
    if (level !== undefined) block.level = level;
    if (linkedInteractableIds && linkedInteractableIds.length > 0) {
      block.linkedInteractableIds = linkedInteractableIds;
    }
    blocks.push(block);
  };

  const walk = (node: DomNode, insideCapturedBlock: boolean): void => {
    if (node.type === "document") {
      for (const child of node.children) walk(child, false);
      return;
    }
    if (node.type !== "element") return;
    if (SKIP_SUBTREE_FOR_TEXT.has(node.tag)) return;
    if (!includeHidden && isHiddenElement(node)) return;

    const structureId = node.structureId ?? "s0";
    const ariaRole = (node.attrs.role || "").toLowerCase();

    // Alerts / status banners
    if (ariaRole === "alert" || ariaRole === "status") {
      const text = getInnerText(node, includeHidden);
      emitBlock(structureId, "alert", text, undefined, collectInteractableIds(node));
      return;
    }

    // Headings
    if (HEADING_TAGS.has(node.tag)) {
      const level = Number.parseInt(node.tag[1], 10);
      const text = getInnerText(node, includeHidden);
      emitBlock(structureId, "heading", text, level, collectInteractableIds(node));
      return;
    }

    // Table rows -> compact pipe-separated cells
    if (node.tag === "tr") {
      const cells: string[] = [];
      for (const child of node.children) {
        if (child.type === "element" && (child.tag === "th" || child.tag === "td")) {
          const cellText = getInnerText(child, includeHidden);
          cells.push(cellText);
        }
      }
      const rowText = cells.filter(Boolean).join(" | ");
      if (rowText) {
        emitBlock(structureId, "table_row", rowText, undefined, collectInteractableIds(node));
      }
      return;
    }

    // Semantic text blocks
    if (BLOCK_TEXT_TAGS.has(node.tag) && !insideCapturedBlock) {
      // If a <li> contains nested lists or paragraphs, recurse into its children instead of flattening
      if (node.tag === "li" && hasNestedBlockChildren(node)) {
        const directText = getDirectTextOnly(node);
        if (directText.length >= minTextLength) {
          emitBlock(structureId, "list_item", directText);
        }
        for (const child of node.children) walk(child, false);
        return;
      }

      const text = getInnerText(node, includeHidden);
      const kind = mapTagToTextKind(node.tag);
      emitBlock(structureId, kind, text, undefined, collectInteractableIds(node));
      return;
    }

    // Leaf-ish generic containers (div, span, time, small, strong, etc.) with direct text
    if (!insideCapturedBlock && !isPureInteractiveLeaf(node)) {
      const directText = getDirectTextOnly(node);
      if (directText.length >= minTextLength) {
        // If this container has only inline children (no nested block elements), capture whole inline text
        if (!hasBlockChildren(node)) {
          const fullText = getInnerText(node, includeHidden);
          const kind: TextBlockKind =
            node.tag === "time" || node.tag === "small" ? "metadata" : "paragraph";
          emitBlock(structureId, kind, fullText, undefined, collectInteractableIds(node));
          return;
        }
        emitBlock(structureId, "paragraph", directText);
      }
    }

    for (const child of node.children) {
      walk(child, insideCapturedBlock);
    }
  };

  walk(doc, false);

  return {
    layer: 2,
    name: "text",
    totalBlocks: blocks.length,
    totalWords,
    blocks,
  };
}

function mapTagToTextKind(tag: string): TextBlockKind {
  switch (tag) {
    case "p":
      return "paragraph";
    case "li":
    case "dt":
    case "dd":
      return "list_item";
    case "blockquote":
      return "blockquote";
    case "pre":
      return "code";
    case "figcaption":
    case "caption":
      return "caption";
    case "label":
    case "legend":
    case "summary":
      return "label";
    default:
      return "paragraph";
  }
}

const STRUCTURAL_OR_BLOCK_TAGS = new Set([
  "div",
  "section",
  "article",
  "main",
  "header",
  "footer",
  "nav",
  "aside",
  "form",
  "table",
  "thead",
  "tbody",
  "tr",
  "ul",
  "ol",
  "dl",
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "pre",
  "dialog",
  "details",
]);

function hasBlockChildren(el: DomElement): boolean {
  for (const child of el.children) {
    if (child.type === "element" && STRUCTURAL_OR_BLOCK_TAGS.has(child.tag)) {
      return true;
    }
  }
  return false;
}

function hasNestedBlockChildren(el: DomElement): boolean {
  for (const child of el.children) {
    if (child.type === "element" && (child.tag === "ul" || child.tag === "ol" || child.tag === "p" || child.tag === "div")) {
      return true;
    }
  }
  return false;
}

function isPureInteractiveLeaf(el: DomElement): boolean {
  return el.tag === "button" || el.tag === "a" || el.tag === "input" || el.tag === "textarea" || el.tag === "option";
}

function getDirectTextOnly(el: DomElement): string {
  const parts: string[] = [];
  for (const child of el.children) {
    if (child.type === "text") {
      const t = child.value.trim();
      if (t) parts.push(t);
    }
  }
  return normalizeSpace(parts.join(" "));
}

function collectInteractableIds(el: DomElement): string[] {
  const ids: string[] = [];
  const walk = (node: DomNode) => {
    if (node.type === "element") {
      if (node.interactableId) ids.push(node.interactableId);
      for (const child of node.children) walk(child);
    }
  };
  walk(el);
  return ids;
}
