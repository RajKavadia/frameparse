import {
  buildSelectors,
  fnv1aHash,
  getInnerText,
  isHiddenElement,
  normalizeSpace,
} from "./html-parser.js";
import type {
  DomDocument,
  DomElement,
  DomNode,
  FoldedLandmarkGroup,
  HeadingEntry,
  LandmarkRole,
  PageMeta,
  StructureFrame,
  StructureNode,
} from "./types.js";

const LANDMARK_TAG_MAP: Record<string, LandmarkRole> = {
  header: "header",
  nav: "nav",
  main: "main",
  aside: "aside",
  footer: "footer",
  section: "section",
  article: "article",
  form: "form",
  dialog: "dialog",
  table: "table",
  search: "search",
};

const LANDMARK_ARIA_MAP: Record<string, LandmarkRole> = {
  banner: "header",
  navigation: "nav",
  main: "main",
  complementary: "aside",
  contentinfo: "footer",
  region: "region",
  form: "form",
  dialog: "dialog",
  alertdialog: "dialog",
  search: "search",
  article: "article",
  table: "table",
};

const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

export interface Frame1BuildResult {
  frame1: StructureFrame;
  landmarkMap: Map<string, StructureNode>;
}

/**
 * Frame 1: Structure
 * Builds a lightweight skeleton of the webpage (landmarks, headings, metadata,
 * structural hash) and tags every DOM element with its owning `structureId`.
 */
export function buildStructureFrame(
  doc: DomDocument,
  idMap: Map<string, DomElement>,
  options: {
    url?: string;
    byteSize: number;
    parseMs: number;
    includeHidden?: boolean;
  },
): Frame1BuildResult {
  const includeHidden = options.includeHidden ?? false;
  const landmarks: StructureNode[] = [];
  const landmarkMap = new Map<string, StructureNode>();
  const outline: HeadingEntry[] = [];

  let title = "";
  let lang: string | null = null;
  let description: string | null = null;
  let canonical: string | null = null;

  // Root document landmark ("s0") holds top-level content outside explicit landmarks
  const rootLandmark: StructureNode = {
    id: "s0",
    role: "document",
    tag: "body",
    label: "Document",
    parentId: null,
    depth: 0,
    children: [],
    headings: [],
    stats: {
      textBlocks: 0,
      wordCount: 0,
      interactables: 0,
      forms: 0,
      links: 0,
      buttons: 0,
      inputs: 0,
    },
    selector: "body",
  };
  landmarks.push(rootLandmark);
  landmarkMap.set(rootLandmark.id, rootLandmark);

  let seq = 1;

  const walk = (node: DomNode, currentStructure: StructureNode, depth: number): void => {
    if (node.type === "document") {
      for (const child of node.children) walk(child, currentStructure, depth);
      return;
    }

    if (node.type !== "element") return;

    // Extract head metadata
    if (node.tag === "html" && node.attrs.lang) {
      lang = node.attrs.lang;
    } else if (node.tag === "title" && !title) {
      title = getInnerText(node, true);
      return;
    } else if (node.tag === "meta") {
      const name = (node.attrs.name || node.attrs.property || "").toLowerCase();
      if ((name === "description" || name === "og:description") && !description && node.attrs.content) {
        description = normalizeSpace(node.attrs.content);
      }
      return;
    } else if (node.tag === "link") {
      if ((node.attrs.rel || "").toLowerCase() === "canonical" && node.attrs.href) {
        canonical = node.attrs.href;
      }
      return;
    } else if (node.tag === "head") {
      for (const child of node.children) walk(child, currentStructure, depth);
      return;
    }

    if (!includeHidden && isHiddenElement(node)) {
      return;
    }

    const landmarkRole = detectLandmarkRole(node);
    let activeStructure = currentStructure;
    let nextDepth = depth;

    if (landmarkRole) {
      const id = `s${seq++}`;
      const label = resolveLandmarkLabel(node, landmarkRole, idMap, includeHidden);
      const { primary } = buildSelectors(node);
      const structNode: StructureNode = {
        id,
        role: landmarkRole,
        tag: node.tag,
        label,
        parentId: currentStructure.id,
        depth: depth + 1,
        children: [],
        headings: [],
        stats: {
          textBlocks: 0,
          wordCount: 0,
          interactables: 0,
          forms: 0,
          links: 0,
          buttons: 0,
          inputs: 0,
        },
        selector: primary,
      };
      currentStructure.children.push(id);
      landmarks.push(structNode);
      landmarkMap.set(id, structNode);
      activeStructure = structNode;
      nextDepth = depth + 1;
    }

    node.structureId = activeStructure.id;

    // Record headings into both the active landmark and global outline
    if (HEADING_TAGS.has(node.tag)) {
      const level = Number.parseInt(node.tag[1], 10);
      const text = getInnerText(node, includeHidden);
      if (text) {
        activeStructure.headings.push({ level, text });
        outline.push({ level, text, structureId: activeStructure.id });
        // Upgrade generic landmark label to its first heading if it had no explicit ARIA label
        if (
          activeStructure.id !== "s0" &&
          activeStructure.label.toLowerCase() === activeStructure.role &&
          activeStructure.headings.length === 1
        ) {
          activeStructure.label = text.slice(0, 80);
        }
      }
    }

    for (const child of node.children) {
      walk(child, activeStructure, nextDepth);
    }
  };

  walk(doc, rootLandmark, 0);

  if (title) {
    rootLandmark.label = title;
  }

  const hashSignature = landmarks
    .map((l) => `${l.id}:${l.role}:${l.tag}:${l.label}:${l.headings.map((h) => h.text).join("|")}`)
    .join("\n");

  const meta: PageMeta = {
    url: options.url ?? null,
    title,
    lang,
    description,
    canonical,
    byteSize: options.byteSize,
    parseMs: options.parseMs,
    structureHash: fnv1aHash(hashSignature),
  };

  const foldedGroups = computeFoldedGroups(landmarks, landmarkMap);

  return {
    frame1: {
      layer: 1,
      name: "structure",
      meta,
      landmarks,
      outline,
      foldedGroups: foldedGroups.length > 0 ? foldedGroups : undefined,
    },
    landmarkMap,
  };
}

/**
 * Gap 3: Detects repeated sibling landmarks (e.g., 200 or 800 identical product
 * <article> cards inside <main>) and folds them into compact pattern groups so
 * Frame 1 stays ~150-300 tokens even on massive catalog SPAs.
 */
export function computeFoldedGroups(
  landmarks: StructureNode[],
  landmarkMap: Map<string, StructureNode>,
  minRepeatCount = 4,
): FoldedLandmarkGroup[] {
  const groups: FoldedLandmarkGroup[] = [];

  for (const parent of landmarks) {
    if (parent.children.length < minRepeatCount) continue;

    // Group direct children by (role, tag)
    const buckets = new Map<string, StructureNode[]>();
    for (const childId of parent.children) {
      const child = landmarkMap.get(childId);
      if (!child) continue;
      // Only fold leaf-like or shallow repeated items (not major top-level landmarks like header/nav/main/footer)
      if (["header", "nav", "main", "footer", "aside"].includes(child.role)) continue;
      const key = `${child.role}::${child.tag}`;
      const list = buckets.get(key) ?? [];
      list.push(child);
      buckets.set(key, list);
    }

    for (const nodes of buckets.values()) {
      if (nodes.length < minRepeatCount) continue;
      const totalTxt = nodes.reduce((acc, n) => acc + n.stats.textBlocks, 0);
      const totalInt = nodes.reduce((acc, n) => acc + n.stats.interactables, 0);
      const sampleLabels = [
        nodes[0].label,
        nodes[1].label,
        nodes[nodes.length - 1].label,
      ].filter(Boolean);

      groups.push({
        parentId: parent.id,
        role: nodes[0].role,
        tag: nodes[0].tag,
        count: nodes.length,
        firstId: nodes[0].id,
        lastId: nodes[nodes.length - 1].id,
        sampleLabels,
        avgTextBlocks: Number((totalTxt / nodes.length).toFixed(1)),
        avgInteractables: Number((totalInt / nodes.length).toFixed(1)),
        memberIds: nodes.map((n) => n.id),
      });
    }
  }

  return groups;
}

function detectLandmarkRole(el: DomElement): LandmarkRole | null {
  const ariaRole = (el.attrs.role || "").trim().toLowerCase();
  if (ariaRole && LANDMARK_ARIA_MAP[ariaRole]) {
    // Only treat role="region" as landmark if it has an accessible name
    if (ariaRole === "region" && !el.attrs["aria-label"] && !el.attrs["aria-labelledby"]) {
      return null;
    }
    return LANDMARK_ARIA_MAP[ariaRole];
  }

  if (LANDMARK_TAG_MAP[el.tag]) {
    // Avoid creating noise for empty/wrapper <section> with no label, heading, or id
    if (el.tag === "section") {
      const hasName = Boolean(el.attrs["aria-label"] || el.attrs["aria-labelledby"] || el.attrs.id);
      if (!hasName && !hasDirectHeading(el)) {
        return null;
      }
    }
    return LANDMARK_TAG_MAP[el.tag];
  }

  return null;
}

function hasDirectHeading(el: DomElement): boolean {
  for (const child of el.children) {
    if (child.type === "element") {
      if (HEADING_TAGS.has(child.tag)) return true;
      if (child.tag === "header" || child.tag === "div") {
        for (const grand of child.children) {
          if (grand.type === "element" && HEADING_TAGS.has(grand.tag)) return true;
        }
      }
    }
  }
  return false;
}

function resolveLandmarkLabel(
  el: DomElement,
  role: LandmarkRole,
  idMap: Map<string, DomElement>,
  includeHidden: boolean,
): string {
  if (el.attrs["aria-label"]) {
    return normalizeSpace(el.attrs["aria-label"]).slice(0, 80);
  }
  if (el.attrs["aria-labelledby"]) {
    const texts = el.attrs["aria-labelledby"]
      .split(/\s+/)
      .map((id) => idMap.get(id))
      .filter((ref): ref is DomElement => Boolean(ref))
      .map((ref) => getInnerText(ref, includeHidden))
      .filter(Boolean);
    if (texts.length > 0) {
      return normalizeSpace(texts.join(" ")).slice(0, 80);
    }
  }
  if (el.attrs.title) {
    return normalizeSpace(el.attrs.title).slice(0, 80);
  }
  if (el.attrs.name && el.tag === "form") {
    return normalizeSpace(el.attrs.name).slice(0, 80);
  }
  if (el.attrs.id) {
    return el.attrs.id.replace(/[-_]+/g, " ").trim().slice(0, 80);
  }
  return role;
}
