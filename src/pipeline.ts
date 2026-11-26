import { performance } from "node:perf_hooks";
import type { ActionEffectCache } from "./action-cache.js";
import { snapshotToDomDocument } from "./browser-adapter.js";
import { buildStructureFrame, computeFoldedGroups } from "./frame1-structure.js";
import { buildTextFrame } from "./frame2-text.js";
import { buildInteractableFrame } from "./frame3-interactables.js";
import { buildActionFrame, planAction } from "./frame4-actions.js";
import {
  estimateTokens,
  formatFrame1ForAI,
  formatFrame2ForAI,
  formatFrame3ForAI,
  formatFrame4ForAI,
} from "./formatter.js";
import { indexElementsById, parseHtml } from "./html-parser.js";
import type {
  ActionFrame,
  DomDocument,
  DomElement,
  InteractableFrame,
  LiveDomSnapshot,
  ParseOptions,
  ParsedPageFrames,
  PlannedActionMatch,
  StructureFrame,
  StructureNode,
  TextFrame,
} from "./types.js";

export interface ExtendedParseOptions extends ParseOptions {
  actionCache?: ActionEffectCache;
  rawByteSize?: number;
}

function expandStructureFilter(
  requested: string[] | undefined,
  landmarkMap: Map<string, StructureNode>,
): Set<string> | undefined {
  if (!requested || requested.length === 0) return undefined;
  const expanded = new Set<string>();
  const queue = [...requested];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (expanded.has(id)) continue;
    expanded.add(id);
    const node = landmarkMap.get(id);
    if (node) {
      for (const childId of node.children) {
        if (!expanded.has(childId)) queue.push(childId);
      }
    }
  }
  return expanded;
}

/**
 * Parses raw HTML deterministically (zero AI) into progressive layered frames:
 *   Frame 1: Structure (landmarks, headings, metadata, hash)
 *   Frame 2: Text (clean readable blocks anchored to structure IDs)
 *   Frame 3: Interactables (controls, accessible names, states, selectors)
 *   Frame 4: Actions (what each control/workflow will do, side effects, steps)
 */
export function parsePageFrames(html: string, options: ExtendedParseOptions = {}): ParsedPageFrames {
  const t0 = performance.now();
  const doc = parseHtml(html);
  const htmlParseMs = performance.now() - t0;
  const byteSize = Buffer.byteLength(html, "utf8");
  return parseDomFrames(doc, { ...options, rawByteSize: byteSize }, htmlParseMs, t0);
}

/**
 * Parses a live post-hydration browser DOM snapshot (from Playwright, Chrome DevTools,
 * Lightpanda, or a browser extension using LIVE_DOM_EXTRACTOR_SCRIPT) into 4 frames.
 */
export function parseLiveSnapshotFrames(
  snapshot: LiveDomSnapshot,
  options: ExtendedParseOptions = {},
): ParsedPageFrames {
  const t0 = performance.now();
  const doc = snapshotToDomDocument(snapshot);
  const parseMs = performance.now() - t0;
  const approxBytes = options.rawByteSize ?? Buffer.byteLength(JSON.stringify(snapshot), "utf8");
  return parseDomFrames(
    doc,
    { ...options, url: options.url ?? snapshot.url, rawByteSize: approxBytes },
    parseMs,
    t0,
  );
}

/**
 * Core 4-layer deterministic pipeline operating on any DomDocument (HTML or Live Browser DOM).
 */
export function parseDomFrames(
  doc: DomDocument,
  options: ExtendedParseOptions = {},
  htmlParseMs = 0,
  startTime = performance.now(),
): ParsedPageFrames {
  const maxLayer = options.maxLayer ?? 4;
  const idMap = indexElementsById(doc);
  const tHtml = performance.now();

  const byteSize = options.rawByteSize ?? 0;
  const { frame1, landmarkMap } = buildStructureFrame(doc, idMap, {
    url: options.url,
    byteSize,
    parseMs: Number(htmlParseMs.toFixed(3)),
    includeHidden: options.includeHidden,
  });
  const t1 = performance.now();

  const allowedStructureIds = expandStructureFilter(options.structureIds, landmarkMap);

  let frame2: TextFrame | undefined;
  let frame3: InteractableFrame | undefined;
  let frame4: ActionFrame | undefined;

  let t2Start = t1;
  let t2End = t1;
  let t3Start = t1;
  let t3End = t1;
  let t4Start = t1;
  let t4End = t1;

  // Build Frame 3 before Frame 2 when layer >= 3 so Frame 2 text blocks link embedded i# refs
  if (maxLayer >= 3) {
    t3Start = performance.now();
    frame3 = buildInteractableFrame(doc, idMap, landmarkMap, {
      url: options.url,
      allowedStructureIds,
      includeHidden: options.includeHidden,
    });
    t3End = performance.now();
  }

  if (maxLayer >= 2) {
    t2Start = performance.now();
    frame2 = buildTextFrame(doc, landmarkMap, {
      allowedStructureIds,
      includeHidden: options.includeHidden,
      minTextLength: options.minTextLength,
    });
    t2End = performance.now();
  }

  // Recompute foldedGroups after Frame 2 & 3 stats are populated so averages are accurate
  const refreshedGroups = computeFoldedGroups(frame1.landmarks, landmarkMap);
  frame1.foldedGroups = refreshedGroups.length > 0 ? refreshedGroups : undefined;

  if (maxLayer >= 4 && frame3) {
    t4Start = performance.now();
    frame4 = buildActionFrame(frame3, {
      url: options.url,
      actionCache: options.actionCache,
    });
    t4End = performance.now();
  }

  const totalEnd = performance.now();
  frame1.meta.parseMs = Number((totalEnd - startTime).toFixed(3));

  const f1Tokens = estimateTokens(formatFrame1ForAI(frame1));
  const f2Tokens = frame2 ? estimateTokens(formatFrame2ForAI(frame2)) : 0;
  const f3Tokens = frame3 ? estimateTokens(formatFrame3ForAI(frame3)) : 0;
  const f4Tokens = frame4 ? estimateTokens(formatFrame4ForAI(frame4)) : 0;
  const totalFrameTokens = f1Tokens + f2Tokens + f3Tokens + f4Tokens;
  const estimatedRawTokens = Math.ceil(byteSize / 4);
  const compressionRatio =
    totalFrameTokens > 0 ? Number((estimatedRawTokens / totalFrameTokens).toFixed(2)) : 1;

  return {
    frame1,
    frame2,
    frame3,
    frame4,
    timingsMs: {
      htmlParse: Number(htmlParseMs.toFixed(3)),
      frame1: Number((t1 - tHtml).toFixed(3)),
      frame2: Number((t2End - t2Start).toFixed(3)),
      frame3: Number((t3End - t3Start).toFixed(3)),
      frame4: Number((t4End - t4Start).toFixed(3)),
      total: Number((totalEnd - startTime).toFixed(3)),
    },
    metrics: {
      rawHtmlBytes: byteSize,
      estimatedRawTokens,
      frame1Tokens: f1Tokens,
      frame2Tokens: f2Tokens,
      frame3Tokens: f3Tokens,
      frame4Tokens: f4Tokens,
      totalFrameTokens,
      compressionRatio,
    },
  };
}

/**
 * Progressive session: parses HTML once and lets an AI agent pull Frame 1 first,
 * then lazily drill into Frame 2, Frame 3, and Frame 4 for only the regions it needs.
 */
export class FrameSession {
  private readonly doc: DomDocument;
  private readonly idMap: Map<string, DomElement>;
  private readonly landmarkMap: Map<string, StructureNode>;
  private readonly options: { url?: string; includeHidden?: boolean; minTextLength?: number };
  public readonly frame1: StructureFrame;

  constructor(html: string, options: Omit<ParseOptions, "maxLayer" | "structureIds"> = {}) {
    const t0 = performance.now();
    this.doc = parseHtml(html);
    this.idMap = indexElementsById(this.doc);
    this.options = options;
    const { frame1, landmarkMap } = buildStructureFrame(this.doc, this.idMap, {
      url: options.url,
      byteSize: Buffer.byteLength(html, "utf8"),
      parseMs: Number((performance.now() - t0).toFixed(3)),
      includeHidden: options.includeHidden,
    });
    this.frame1 = frame1;
    this.landmarkMap = landmarkMap;
  }

  getStructure(): StructureFrame {
    return this.frame1;
  }

  getText(structureIds?: string[]): TextFrame {
    const allowed = expandStructureFilter(structureIds, this.landmarkMap);
    return buildTextFrame(this.doc, this.landmarkMap, {
      allowedStructureIds: allowed,
      includeHidden: this.options.includeHidden,
      minTextLength: this.options.minTextLength,
    });
  }

  getInteractables(structureIds?: string[]): InteractableFrame {
    const allowed = expandStructureFilter(structureIds, this.landmarkMap);
    return buildInteractableFrame(this.doc, this.idMap, this.landmarkMap, {
      url: this.options.url,
      allowedStructureIds: allowed,
      includeHidden: this.options.includeHidden,
    });
  }

  getActions(structureIds?: string[]): ActionFrame {
    const frame3 = this.getInteractables(structureIds);
    return buildActionFrame(frame3, { url: this.options.url });
  }

  plan(
    goalQuery: string,
    options: { structureIds?: string[]; limit?: number; allowDestructive?: boolean } = {},
  ): PlannedActionMatch[] {
    const frame4 = this.getActions(options.structureIds);
    return planAction(frame4, goalQuery, {
      limit: options.limit,
      allowDestructive: options.allowDestructive,
    });
  }
}
