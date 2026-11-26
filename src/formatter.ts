import type {
  ActionFrame,
  FrameDiff,
  InteractableFrame,
  ParsedPageFrames,
  StructureFrame,
  TextFrame,
} from "./types.js";

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Serializes Frame 1 (Structure) into an ultra-compact outline for AI agents.
 */
export function formatFrame1ForAI(frame1: StructureFrame): string {
  const lines: string[] = [];
  lines.push(`# FRAME 1: STRUCTURE`);
  lines.push(
    `title: ${frame1.meta.title || "(untitled)"} | url: ${frame1.meta.url ?? "-"} | hash: ${frame1.meta.structureHash}`,
  );
  if (frame1.meta.description) {
    lines.push(`desc: ${frame1.meta.description}`);
  }
  lines.push(`landmarks:`);
  // Map folded repeated siblings so Frame 1 wire output stays ~150-300 tokens even on 1,000-card SPAs
  const hiddenByFold = new Set<string>();
  const foldAnchorMap = new Map<string, NonNullable<StructureFrame["foldedGroups"]>[number]>();
  for (const grp of frame1.foldedGroups ?? []) {
    // Keep first 2 and last 1 visible; fold the middle N-3 items into one summary line
    const members = grp.memberIds;
    if (members.length >= 4) {
      foldAnchorMap.set(members[2], grp);
      for (let i = 2; i < members.length - 1; i++) {
        hiddenByFold.add(members[i]);
      }
    }
  }

  for (const lm of frame1.landmarks) {
    if (hiddenByFold.has(lm.id)) {
      const grp = foldAnchorMap.get(lm.id);
      if (grp) {
        const indent = "  ".repeat(lm.depth);
        const omitted = grp.count - 3;
        lines.push(
          `${indent}- ... [${omitted} more repeated ${grp.role} <${grp.tag}> items folded (${grp.firstId}..${grp.lastId}, total=${grp.count}, avg ${grp.avgTextBlocks}txt/${grp.avgInteractables}int) — use frame_query]`,
        );
      }
      continue;
    }
    const indent = "  ".repeat(lm.depth);
    const s = lm.stats;
    const statsParts: string[] = [];
    if (s.textBlocks) statsParts.push(`${s.textBlocks}txt/${s.wordCount}w`);
    if (s.interactables) statsParts.push(`${s.interactables}int`);
    if (s.forms) statsParts.push(`${s.forms}form`);
    const statsStr = statsParts.length ? ` (${statsParts.join(", ")})` : "";
    lines.push(`${indent}- ${lm.id} [${lm.role}] "${lm.label}"${statsStr}`);
  }
  return lines.join("\n");
}

/**
 * Serializes Frame 2 (Text) into a compact region-anchored reading view.
 */
export function formatFrame2ForAI(frame2: TextFrame): string {
  const lines: string[] = [];
  lines.push(`# FRAME 2: TEXT (${frame2.totalBlocks} blocks, ${frame2.totalWords} words)`);
  for (const b of frame2.blocks) {
    const tag = b.kind === "heading" && b.level ? `h${b.level}` : b.kind;
    const refs = b.linkedInteractableIds?.length ? ` {${b.linkedInteractableIds.join(",")}}` : "";
    lines.push(`${b.id} @${b.structureId} [${tag}] ${b.text}${refs}`);
  }
  return lines.join("\n");
}

/**
 * Serializes Frame 3 (Interactables) into a compact ref-indexed control table.
 */
export function formatFrame3ForAI(frame3: InteractableFrame): string {
  const lines: string[] = [];
  lines.push(`# FRAME 3: INTERACTABLES (${frame3.totalInteractables} controls)`);
  for (const el of frame3.elements) {
    const flags: string[] = [];
    if (el.state.required) flags.push("req");
    if (el.state.disabled) flags.push("disabled");
    if (el.state.checked !== undefined) flags.push(el.state.checked ? "checked" : "unchecked");
    if (el.state.expanded !== undefined) flags.push(el.state.expanded ? "expanded" : "collapsed");
    const flagStr = flags.length ? ` <${flags.join(",")}>` : "";
    const extra: string[] = [];
    if (el.inputType) extra.push(`type=${el.inputType}`);
    if (el.href) extra.push(`href=${el.href}`);
    if (el.formId) extra.push(`form=${el.formId}`);
    if (el.value) extra.push(`val="${el.value}"`);
    if (el.options?.length) {
      extra.push(`opts=[${el.options.slice(0, 4).map((o) => o.label).join("|")}]`);
    }
    const extraStr = extra.length ? ` | ${extra.join(" ")}` : "";
    lines.push(`${el.id} @${el.structureId} [${el.kind}] "${el.name}"${flagStr}${extraStr} -> ${el.selector}`);
  }
  return lines.join("\n");
}

/**
 * Serializes Frame 4 (Actions) into a compact deterministic action manifest.
 */
export function formatFrame4ForAI(frame4: ActionFrame): string {
  const lines: string[] = [];
  lines.push(
    `# FRAME 4: ACTIONS (${frame4.totalWorkflows} workflows, ${frame4.totalActions} atomic actions)`,
  );

  if (frame4.workflows.length > 0) {
    lines.push(`workflows:`);
    for (const w of frame4.workflows) {
      const steps = w.steps.map((s) => `${s.op}(${s.ref}${s.param ? `:${s.param}` : ""})`).join(" -> ");
      lines.push(`- ${w.id} @${w.structureId} [${w.category}|${w.effect}] ${w.summary}`);
      lines.push(`    steps: ${steps}`);
    }
  }

  lines.push(`actions:`);
  for (const a of frame4.actions) {
    const pre = a.preconditions.length ? ` !pre:[${a.preconditions.join("; ")}]` : "";
    lines.push(`- ${a.id} -> ${a.targetId} @${a.structureId} [${a.verb}|${a.category}|${a.effect}] ${a.summary}${pre}`);
  }
  return lines.join("\n");
}

/**
 * Formats all present layers in a ParsedPageFrames bundle for AI consumption.
 */
export function formatFramesForAI(parsed: ParsedPageFrames): string {
  const sections: string[] = [formatFrame1ForAI(parsed.frame1)];
  if (parsed.frame2) sections.push(formatFrame2ForAI(parsed.frame2));
  if (parsed.frame3) sections.push(formatFrame3ForAI(parsed.frame3));
  if (parsed.frame4) sections.push(formatFrame4ForAI(parsed.frame4));
  return sections.join("\n\n");
}

export function formatDiffForAI(diff: FrameDiff): string {
  const lines: string[] = [`# FRAME DIFF (structureChanged=${diff.structureChanged})`];
  if (diff.addedLandmarks.length) lines.push(`+landmarks: ${diff.addedLandmarks.join(", ")}`);
  if (diff.removedLandmarks.length) lines.push(`-landmarks: ${diff.removedLandmarks.join(", ")}`);
  if (diff.addedTextBlocks.length) {
    lines.push(`+text (${diff.addedTextBlocks.length}):`);
    for (const b of diff.addedTextBlocks) {
      lines.push(`  + ${b.id} [${b.kind}] ${b.text}`);
    }
  }
  if (diff.removedTextBlockIds.length) {
    lines.push(`-text: ${diff.removedTextBlockIds.join(", ")}`);
  }
  if (diff.addedInteractables.length) {
    lines.push(`+interactables (${diff.addedInteractables.length}):`);
    for (const el of diff.addedInteractables) {
      lines.push(`  + ${el.id} [${el.kind}] "${el.name}" -> ${el.selector}`);
    }
  }
  if (diff.changedInteractables.length) {
    lines.push(`~changed interactables (${diff.changedInteractables.length}):`);
    for (const ch of diff.changedInteractables) {
      lines.push(`  ~ ${ch.id} "${ch.name}": ${JSON.stringify(ch.changes)}`);
    }
  }
  if (diff.addedActions.length) {
    lines.push(`+actions (${diff.addedActions.length}):`);
    for (const a of diff.addedActions) {
      lines.push(`  + ${a.id} [${a.verb}|${a.effect}] ${a.summary}`);
    }
  }
  return lines.join("\n");
}
