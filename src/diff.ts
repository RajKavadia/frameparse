import type { FrameDiff, ParsedPageFrames } from "./types.js";

/**
 * Computes a compact delta between two parsed webpage states (e.g., before and
 * after executing a Frame 4 action). Agents can inspect only what changed
 * instead of re-reading the whole page.
 */
export function diffFrames(before: ParsedPageFrames, after: ParsedPageFrames): FrameDiff {
  const structureChanged = before.frame1.meta.structureHash !== after.frame1.meta.structureHash;

  const beforeLandmarks = new Set(before.frame1.landmarks.map((l) => `${l.role}:${l.label}`));
  const afterLandmarks = new Set(after.frame1.landmarks.map((l) => `${l.role}:${l.label}`));

  const addedLandmarks = [...afterLandmarks].filter((k) => !beforeLandmarks.has(k));
  const removedLandmarks = [...beforeLandmarks].filter((k) => !afterLandmarks.has(k));

  // Frame 2 text diff
  const beforeTexts = new Map((before.frame2?.blocks ?? []).map((b) => [`${b.kind}:${b.text}`, b]));
  const afterTexts = new Map((after.frame2?.blocks ?? []).map((b) => [`${b.kind}:${b.text}`, b]));

  const addedTextBlocks = [...afterTexts.entries()]
    .filter(([k]) => !beforeTexts.has(k))
    .map(([, b]) => b);
  const removedTextBlockIds = [...beforeTexts.entries()]
    .filter(([k]) => !afterTexts.has(k))
    .map(([, b]) => b.id);

  // Frame 3 interactables diff (keyed by selector + kind)
  const beforeInter = new Map(
    (before.frame3?.elements ?? []).map((e) => [`${e.kind}:${e.selector}`, e]),
  );
  const afterInter = new Map(
    (after.frame3?.elements ?? []).map((e) => [`${e.kind}:${e.selector}`, e]),
  );

  const addedInteractables = [...afterInter.entries()]
    .filter(([k]) => !beforeInter.has(k))
    .map(([, e]) => e);
  const removedInteractableIds = [...beforeInter.entries()]
    .filter(([k]) => !afterInter.has(k))
    .map(([, e]) => e.id);

  const changedInteractables: FrameDiff["changedInteractables"] = [];
  for (const [key, afterEl] of afterInter.entries()) {
    const beforeEl = beforeInter.get(key);
    if (!beforeEl) continue;

    const changes: Record<string, { before: unknown; after: unknown }> = {};
    if (beforeEl.value !== afterEl.value) {
      changes.value = { before: beforeEl.value, after: afterEl.value };
    }
    if (beforeEl.state.disabled !== afterEl.state.disabled) {
      changes.disabled = { before: beforeEl.state.disabled, after: afterEl.state.disabled };
    }
    if (beforeEl.state.checked !== afterEl.state.checked) {
      changes.checked = { before: beforeEl.state.checked, after: afterEl.state.checked };
    }
    if (beforeEl.state.expanded !== afterEl.state.expanded) {
      changes.expanded = { before: beforeEl.state.expanded, after: afterEl.state.expanded };
    }
    if (beforeEl.name !== afterEl.name) {
      changes.name = { before: beforeEl.name, after: afterEl.name };
    }

    if (Object.keys(changes).length > 0) {
      changedInteractables.push({ id: afterEl.id, name: afterEl.name, changes });
    }
  }

  // Frame 4 actions diff
  const beforeActKeys = new Set(
    [...(before.frame4?.workflows ?? []), ...(before.frame4?.actions ?? [])].map((a) => a.summary),
  );
  const afterAllActs = [...(after.frame4?.workflows ?? []), ...(after.frame4?.actions ?? [])];
  const afterActKeys = new Set(afterAllActs.map((a) => a.summary));

  const addedActions = afterAllActs.filter((a) => !beforeActKeys.has(a.summary));
  const removedActionIds = [
    ...(before.frame4?.workflows ?? []),
    ...(before.frame4?.actions ?? []),
  ]
    .filter((a) => !afterActKeys.has(a.summary))
    .map((a) => a.id);

  return {
    structureChanged,
    addedLandmarks,
    removedLandmarks,
    addedTextBlocks,
    removedTextBlockIds,
    addedInteractables,
    removedInteractableIds,
    changedInteractables,
    addedActions,
    removedActionIds,
  };
}
