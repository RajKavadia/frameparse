import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ActionEffectCache } from "./action-cache.js";
import { diffFrames } from "./diff.js";
import {
  estimateTokens,
  formatDiffForAI,
  formatFrame1ForAI,
  formatFrame2ForAI,
  formatFrame3ForAI,
  formatFrame4ForAI,
} from "./formatter.js";
import { planAction } from "./frame4-actions.js";
import { parseLiveSnapshotFrames, parsePageFrames } from "./pipeline.js";
import type {
  ActionSpec,
  FrameDiff,
  FrameLayer,
  InteractableElement,
  LiveDomSnapshot,
  ParsedPageFrames,
  PlannedActionMatch,
  StructureNode,
  TextBlock,
} from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(__dirname, "../../tests/fixtures");

export const BUILTIN_FIXTURES = [
  {
    id: "ecommerce",
    label: "NovaStore — E-Commerce Product Page",
    url: "https://novastore.example.com/products/ultrabook-pro-14",
    file: "ecommerce.html",
  },
  {
    id: "dashboard",
    label: "Acme Cloud — SaaS Workspace Settings",
    url: "https://acme.example.com/settings",
    file: "dashboard.html",
  },
  {
    id: "dashboard-after",
    label: "Acme Cloud — Post-Login State",
    url: "https://acme.example.com/settings",
    file: "dashboard-after.html",
  },
] as const;

export interface StoredSession {
  id: string;
  url: string | null;
  title: string;
  createdAt: number;
  updatedAt: number;
  html: string;
  parsed: ParsedPageFrames;
  includeHidden: boolean;
  rawTokensAvoided: number;
  tokensEmitted: number;
}

export interface OpenPageInput {
  url?: string;
  html?: string;
  fixture?: string;
  snapshot?: LiveDomSnapshot;
  sessionId?: string;
  includeHidden?: boolean;
}

export interface QueryMatch {
  layer: FrameLayer;
  id: string;
  structureId: string;
  score: number;
  summary: string;
  extra?: string;
}

export interface LineageResult {
  ref: string;
  layer: FrameLayer;
  structures: StructureNode[];
  texts: TextBlock[];
  interactables: InteractableElement[];
  actions: ActionSpec[];
}

export async function resolveHtmlSource(input: {
  url?: string;
  html?: string;
  fixture?: string;
}): Promise<{ html: string; url?: string }> {
  if (input.fixture) {
    const match = BUILTIN_FIXTURES.find((f) => f.id === input.fixture);
    if (!match) throw new Error(`Unknown fixture "${input.fixture}". Available: ${BUILTIN_FIXTURES.map((f) => f.id).join(", ")}`);
    const html = await readFile(path.join(fixturesDir, match.file), "utf8");
    return { html, url: input.url || match.url };
  }
  if (input.html && input.html.trim().length > 0) {
    return { html: input.html, url: input.url };
  }
  if (input.url && /^https?:\/\//i.test(input.url)) {
    const res = await fetch(input.url, {
      headers: {
        "user-agent": "frameparse-mcp/0.2 (+https://github.com/frameparse)",
        accept: "text/html,application/xhtml+xml,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${input.url}`);
    return { html: await res.text(), url: res.url || input.url };
  }
  throw new Error("Provide one of: url, html, or fixture");
}

function expandRegionSet(regions: string[] | undefined, landmarks: StructureNode[]): Set<string> | undefined {
  if (!regions || regions.length === 0) return undefined;
  const byId = new Map(landmarks.map((l) => [l.id, l]));
  const result = new Set<string>();
  const queue = [...regions];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (result.has(id)) continue;
    result.add(id);
    const node = byId.get(id);
    if (node) {
      for (const childId of node.children) {
        if (!result.has(childId)) queue.push(childId);
      }
    }
  }
  return result;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9$]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/**
 * Truncates lines cleanly to stay within a strict token budget while reporting
 * pagination info (`offset`, `nextOffset`, `remaining`) so agents never blow context.
 */
export function budgetLines(
  lines: string[],
  options: { maxTokens?: number; offset?: number } = {},
): { text: string; returned: number; total: number; truncated: boolean; nextOffset: number | null; tokens: number } {
  const offset = Math.max(0, options.offset ?? 0);
  const maxTokens = options.maxTokens ?? 1200;
  const sliced = lines.slice(offset);
  const out: string[] = [];
  let usedTokens = 0;

  for (const line of sliced) {
    const lineTok = estimateTokens(line + "\n");
    if (out.length > 0 && usedTokens + lineTok > maxTokens) {
      break;
    }
    out.push(line);
    usedTokens += lineTok;
  }

  const returned = out.length;
  const truncated = offset + returned < lines.length;
  return {
    text: out.join("\n"),
    returned,
    total: lines.length,
    truncated,
    nextOffset: truncated ? offset + returned : null,
    tokens: usedTokens,
  };
}

export class SessionStore {
  private readonly sessions = new Map<string, StoredSession>();
  public readonly actionCache = new ActionEffectCache();
  private readonly maxSessions: number;
  private seq = 1;

  constructor(maxSessions = 32) {
    this.maxSessions = maxSessions;
  }

  async open(input: OpenPageInput): Promise<StoredSession> {
    const includeHidden = Boolean(input.includeHidden);
    let html = "";
    let parsed: ParsedPageFrames;

    if (input.snapshot) {
      parsed = parseLiveSnapshotFrames(input.snapshot, {
        url: input.url ?? input.snapshot.url,
        maxLayer: 4,
        includeHidden,
        actionCache: this.actionCache,
      });
    } else {
      const resolved = await resolveHtmlSource(input);
      html = resolved.html;
      parsed = parsePageFrames(html, {
        url: resolved.url,
        maxLayer: 4,
        includeHidden,
        actionCache: this.actionCache,
      });
    }
    const id = input.sessionId?.trim() || `p${this.seq++}`;
    const now = Date.now();

    const session: StoredSession = {
      id,
      url: parsed.frame1.meta.url,
      title: parsed.frame1.meta.title || "(untitled)",
      createdAt: now,
      updatedAt: now,
      html,
      parsed,
      includeHidden,
      rawTokensAvoided: parsed.metrics.estimatedRawTokens,
      tokensEmitted: 0,
    };

    if (this.sessions.size >= this.maxSessions && !this.sessions.has(id)) {
      const oldestKey = this.sessions.keys().next().value;
      if (oldestKey) this.sessions.delete(oldestKey);
    }

    this.sessions.set(id, session);
    return session;
  }

  get(sessionId: string): StoredSession {
    const s = this.sessions.get(sessionId);
    if (!s) {
      const available = [...this.sessions.keys()].join(", ") || "(none)";
      throw new Error(`Unknown sessionId "${sessionId}". Active sessions: ${available}. Call frame_open first.`);
    }
    return s;
  }

  list(): Array<{
    sessionId: string;
    title: string;
    url: string | null;
    rawTokens: number;
    tokensEmitted: number;
    savingsPct: number;
    landmarks: number;
    workflows: number;
    actions: number;
  }> {
    return [...this.sessions.values()].map((s) => {
      const savingsPct =
        s.rawTokensAvoided > 0
          ? Number((((s.rawTokensAvoided - s.tokensEmitted) / s.rawTokensAvoided) * 100).toFixed(1))
          : 0;
      return {
        sessionId: s.id,
        title: s.title,
        url: s.url,
        rawTokens: s.parsed.metrics.estimatedRawTokens,
        tokensEmitted: s.tokensEmitted,
        savingsPct,
        landmarks: s.parsed.frame1.landmarks.length,
        workflows: s.parsed.frame4?.totalWorkflows ?? 0,
        actions: s.parsed.frame4?.totalActions ?? 0,
      };
    });
  }

  close(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  recordEmission(session: StoredSession, text: string): number {
    const tok = estimateTokens(text);
    session.tokensEmitted += tok;
    session.updatedAt = Date.now();
    return tok;
  }

  readLayer(
    sessionId: string,
    options: {
      layer: FrameLayer;
      regions?: string[];
      maxTokens?: number;
      offset?: number;
      kinds?: string[];
      effects?: string[];
    },
  ): {
    header: string;
    body: string;
    returned: number;
    total: number;
    truncated: boolean;
    nextOffset: number | null;
    tokens: number;
  } {
    const session = this.get(sessionId);
    const { parsed } = session;
    const regionSet = expandRegionSet(options.regions, parsed.frame1.landmarks);
    const kindSet = options.kinds?.length ? new Set(options.kinds.map((k) => k.toLowerCase())) : undefined;
    const effectSet = options.effects?.length ? new Set(options.effects.map((e) => e.toLowerCase())) : undefined;

    let header = "";
    let itemLines: string[] = [];

    if (options.layer === 1) {
      const full = formatFrame1ForAI(parsed.frame1).split("\n");
      header = full.slice(0, 3).join("\n");
      itemLines = full.slice(3);
    } else if (options.layer === 2 && parsed.frame2) {
      const blocks = parsed.frame2.blocks.filter((b) => {
        if (regionSet && !regionSet.has(b.structureId)) return false;
        if (kindSet && !kindSet.has(b.kind.toLowerCase())) return false;
        return true;
      });
      const subFrame = {
        ...parsed.frame2,
        totalBlocks: blocks.length,
        totalWords: blocks.reduce((acc, b) => acc + b.wordCount, 0),
        blocks,
      };
      const lines = formatFrame2ForAI(subFrame).split("\n");
      header = lines[0];
      itemLines = lines.slice(1);
    } else if (options.layer === 3 && parsed.frame3) {
      const elements = parsed.frame3.elements.filter((el) => {
        if (regionSet && !regionSet.has(el.structureId)) return false;
        if (kindSet && !kindSet.has(el.kind.toLowerCase())) return false;
        return true;
      });
      const subFrame = {
        ...parsed.frame3,
        totalInteractables: elements.length,
        elements,
      };
      const lines = formatFrame3ForAI(subFrame).split("\n");
      header = lines[0];
      itemLines = lines.slice(1);
    } else if (options.layer === 4 && parsed.frame4) {
      const workflows = parsed.frame4.workflows.filter((w) => {
        if (regionSet && !regionSet.has(w.structureId)) return false;
        if (effectSet && !effectSet.has(w.effect.toLowerCase())) return false;
        return true;
      });
      const actions = parsed.frame4.actions.filter((a) => {
        if (regionSet && !regionSet.has(a.structureId)) return false;
        if (effectSet && !effectSet.has(a.effect.toLowerCase())) return false;
        return true;
      });
      const subFrame = {
        ...parsed.frame4,
        totalWorkflows: workflows.length,
        totalActions: actions.length,
        workflows,
        actions,
      };
      const lines = formatFrame4ForAI(subFrame).split("\n");
      header = lines[0];
      itemLines = lines.slice(1);
    }

    const budgeted = budgetLines(itemLines, {
      maxTokens: options.maxTokens ?? 1000,
      offset: options.offset ?? 0,
    });
    const combined = `${header}\n${budgeted.text}`;
    const tokens = this.recordEmission(session, combined);

    return {
      header,
      body: budgeted.text,
      returned: budgeted.returned,
      total: budgeted.total,
      truncated: budgeted.truncated,
      nextOffset: budgeted.nextOffset,
      tokens,
    };
  }

  /**
   * Zero-AI high-density cross-layer search inside a cached page session.
   * Lets an agent ask for specific facts, prices, labels, or controls in ~100 tokens.
   */
  query(
    sessionId: string,
    queryText: string,
    options: { layers?: FrameLayer[]; limit?: number } = {},
  ): QueryMatch[] {
    const session = this.get(sessionId);
    const { parsed } = session;
    const layers = new Set<FrameLayer>(options.layers?.length ? options.layers : [2, 3, 4]);
    const limit = options.limit ?? 10;
    const qTokens = tokenize(queryText);
    if (qTokens.length === 0) return [];

    const scoreText = (haystack: string): number => {
      const lower = haystack.toLowerCase();
      let score = 0;
      if (lower.includes(queryText.toLowerCase())) score += 4;
      const hTokens = new Set(tokenize(haystack));
      for (const qt of qTokens) {
        if (hTokens.has(qt)) score += 3;
        else if (lower.includes(qt)) score += 1.5;
      }
      return score;
    };

    const matches: QueryMatch[] = [];

    if (layers.has(1)) {
      for (const lm of parsed.frame1.landmarks) {
        const s = scoreText(`${lm.role} ${lm.label} ${lm.headings.map((h) => h.text).join(" ")}`);
        if (s > 0) {
          matches.push({
            layer: 1,
            id: lm.id,
            structureId: lm.id,
            score: s,
            summary: `[${lm.role}] "${lm.label}" (${lm.stats.textBlocks}txt, ${lm.stats.interactables}int)`,
          });
        }
      }
    }

    if (layers.has(2) && parsed.frame2) {
      for (const blk of parsed.frame2.blocks) {
        const s = scoreText(`${blk.kind} ${blk.text}`);
        if (s > 0) {
          matches.push({
            layer: 2,
            id: blk.id,
            structureId: blk.structureId,
            score: s,
            summary: `[${blk.kind}] ${blk.text}`,
          });
        }
      }
    }

    if (layers.has(3) && parsed.frame3) {
      for (const el of parsed.frame3.elements) {
        const s = scoreText(`${el.kind} ${el.name} ${el.placeholder ?? ""} ${el.href ?? ""} ${el.value ?? ""}`);
        if (s > 0) {
          matches.push({
            layer: 3,
            id: el.id,
            structureId: el.structureId,
            score: s,
            summary: `[${el.kind}] "${el.name}" -> ${el.selector}`,
            extra: el.href ? `href=${el.href}` : undefined,
          });
        }
      }
    }

    if (layers.has(4) && parsed.frame4) {
      for (const act of [...parsed.frame4.workflows, ...parsed.frame4.actions]) {
        const s = scoreText(`${act.summary} ${act.category} ${act.verb}`);
        if (s > 0) {
          matches.push({
            layer: 4,
            id: act.id,
            structureId: act.structureId,
            score: act.isWorkflow ? s + 1.5 : s,
            summary: `[${act.category}|${act.effect}] ${act.summary}`,
            extra: act.steps.map((st) => `${st.op}(${st.ref})`).join(" -> "),
          });
        }
      }
    }

    matches.sort((a, b) => b.score - a.score);
    return matches.slice(0, limit);
  }

  plan(
    sessionId: string,
    goal: string,
    options: { regions?: string[]; allowDestructive?: boolean; limit?: number } = {},
  ): PlannedActionMatch[] {
    const session = this.get(sessionId);
    const frame4 = session.parsed.frame4;
    if (!frame4) return [];

    const regionSet = expandRegionSet(options.regions, session.parsed.frame1.landmarks);
    const scopedFrame4 = regionSet
      ? {
          ...frame4,
          workflows: frame4.workflows.filter((w) => regionSet.has(w.structureId)),
          actions: frame4.actions.filter((a) => regionSet.has(a.structureId)),
        }
      : frame4;

    return planAction(scopedFrame4, goal, {
      allowDestructive: options.allowDestructive ?? true,
      limit: options.limit ?? 5,
    });
  }

  inspect(sessionId: string, ref: string): LineageResult {
    const session = this.get(sessionId);
    const { frame1, frame2, frame3, frame4 } = session.parsed;
    const allActions = [...(frame4?.workflows ?? []), ...(frame4?.actions ?? [])];

    let layer: FrameLayer;
    if (ref.startsWith("s")) layer = 1;
    else if (ref.startsWith("t")) layer = 2;
    else if (ref.startsWith("i")) layer = 3;
    else if (ref.startsWith("a") || ref.startsWith("w")) layer = 4;
    else throw new Error(`Unrecognized ref "${ref}". Expected s#, t#, i#, w#, or a#.`);

    const sIds = new Set<string>();
    const tIds = new Set<string>();
    const iIds = new Set<string>();
    const aIds = new Set<string>();

    const addAncestors = (sid: string) => {
      let cur = frame1.landmarks.find((l) => l.id === sid);
      while (cur) {
        sIds.add(cur.id);
        cur = cur.parentId ? frame1.landmarks.find((l) => l.id === cur!.parentId) : undefined;
      }
    };

    if (layer === 1) {
      const expanded = expandRegionSet([ref], frame1.landmarks);
      expanded?.forEach((id) => sIds.add(id));
      addAncestors(ref);
      (frame2?.blocks ?? []).forEach((b) => { if (sIds.has(b.structureId)) tIds.add(b.id); });
      (frame3?.elements ?? []).forEach((el) => { if (sIds.has(el.structureId)) iIds.add(el.id); });
      allActions.forEach((a) => { if (sIds.has(a.structureId)) aIds.add(a.id); });
    } else if (layer === 2) {
      const blk = frame2?.blocks.find((b) => b.id === ref);
      if (!blk) throw new Error(`Text ref "${ref}" not found in session "${sessionId}"`);
      tIds.add(blk.id);
      addAncestors(blk.structureId);
      (blk.linkedInteractableIds ?? []).forEach((id) => iIds.add(id));
      allActions.forEach((a) => {
        if (iIds.has(a.targetId) || a.steps.some((st) => iIds.has(st.ref))) aIds.add(a.id);
      });
    } else if (layer === 3) {
      const el = frame3?.elements.find((e) => e.id === ref);
      if (!el) throw new Error(`Interactable ref "${ref}" not found in session "${sessionId}"`);
      iIds.add(el.id);
      if (el.formId) iIds.add(el.formId);
      addAncestors(el.structureId);
      (frame2?.blocks ?? []).forEach((b) => {
        if (b.structureId === el.structureId || b.linkedInteractableIds?.includes(el.id)) tIds.add(b.id);
      });
      allActions.forEach((a) => {
        if (a.targetId === el.id || a.steps.some((st) => st.ref === el.id)) aIds.add(a.id);
      });
    } else {
      const act = allActions.find((a) => a.id === ref);
      if (!act) throw new Error(`Action ref "${ref}" not found in session "${sessionId}"`);
      aIds.add(act.id);
      addAncestors(act.structureId);
      iIds.add(act.targetId);
      act.steps.forEach((st) => iIds.add(st.ref));
      act.parameters.forEach((p) => iIds.add(p.interactableId));
      (frame2?.blocks ?? []).forEach((b) => {
        if (b.structureId === act.structureId || b.linkedInteractableIds?.some((id) => iIds.has(id))) {
          tIds.add(b.id);
        }
      });
    }

    return {
      ref,
      layer,
      structures: frame1.landmarks.filter((l) => sIds.has(l.id)),
      texts: (frame2?.blocks ?? []).filter((b) => tIds.has(b.id)),
      interactables: (frame3?.elements ?? []).filter((e) => iIds.has(e.id)),
      actions: allActions.filter((a) => aIds.has(a.id)),
    };
  }

  async diffAndUpdate(
    sessionId: string,
    nextSource: {
      url?: string;
      html?: string;
      fixture?: string;
      snapshot?: LiveDomSnapshot;
      executedActionId?: string;
      updateSession?: boolean;
    },
  ): Promise<{ diff: FrameDiff; formatted: string; tokens: number; learnedOutcome?: string }> {
    const session = this.get(sessionId);
    let html = "";
    let afterParsed: ParsedPageFrames;

    if (nextSource.snapshot) {
      afterParsed = parseLiveSnapshotFrames(nextSource.snapshot, {
        url: nextSource.url ?? nextSource.snapshot.url ?? session.url ?? undefined,
        maxLayer: 4,
        includeHidden: session.includeHidden,
        actionCache: this.actionCache,
      });
    } else {
      const resolved = await resolveHtmlSource(nextSource);
      html = resolved.html;
      afterParsed = parsePageFrames(html, {
        url: resolved.url ?? session.url ?? undefined,
        maxLayer: 4,
        includeHidden: session.includeHidden,
        actionCache: this.actionCache,
      });
    }

    const diff = diffFrames(session.parsed, afterParsed);
    const formatted = formatDiffForAI(diff);

    // Gap 5B: Learn & cache real-world action outcome when executedActionId is provided
    let learnedOutcome: string | undefined;
    if (nextSource.executedActionId && session.parsed.frame4) {
      const allPrev = [...session.parsed.frame4.workflows, ...session.parsed.frame4.actions];
      const act = allPrev.find((a) => a.id === nextSource.executedActionId);
      if (act && act.steps.length > 0) {
        const selector = act.steps[act.steps.length - 1].selector;
        const cached = this.actionCache.recordFromDiff(session.url, selector, diff, act.effect);
        learnedOutcome = cached.summary;
      }
    }

    if (nextSource.updateSession !== false) {
      session.html = html;
      session.parsed = afterParsed;
      session.url = afterParsed.frame1.meta.url;
      session.title = afterParsed.frame1.meta.title || "(untitled)";
      session.rawTokensAvoided += afterParsed.metrics.estimatedRawTokens;
    }

    const tokens = this.recordEmission(session, formatted);
    return { diff, formatted, tokens, learnedOutcome };
  }
}
