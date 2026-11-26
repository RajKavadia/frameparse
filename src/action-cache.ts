import type { ActionEffect, CachedActionOutcome, FrameDiff } from "./types.js";

function extractOrigin(url: string | null | undefined): string {
  if (!url) return "local";
  try {
    return new URL(url).origin;
  } catch {
    return "local";
  }
}

/**
 * Zero-AI Site-Level Action Effect Cache (Gap 5B).
 * Remembers what happened after an ambiguous SPA button or action was clicked
 * (from `frame_diff`), and enriches Frame 4 deterministically on future parses.
 */
export class ActionEffectCache {
  private readonly entries = new Map<string, CachedActionOutcome>();

  private makeKey(origin: string, selector: string): string {
    return `${origin}::${selector}`;
  }

  get(url: string | null | undefined, selector: string): CachedActionOutcome | undefined {
    const origin = extractOrigin(url);
    return this.entries.get(this.makeKey(origin, selector));
  }

  recordFromDiff(
    url: string | null | undefined,
    selector: string,
    diff: FrameDiff,
    fallbackEffect: ActionEffect = "read",
  ): CachedActionOutcome {
    const origin = extractOrigin(url);
    const key = this.makeKey(origin, selector);
    const existing = this.entries.get(key);

    const addedAlerts = diff.addedTextBlocks
      .filter((b) => b.kind === "alert")
      .map((b) => b.text)
      .slice(0, 3);

    const parts: string[] = [];
    if (addedAlerts.length) parts.push(`alert: "${addedAlerts[0]}"`);
    if (diff.addedLandmarks.length) parts.push(`opened [${diff.addedLandmarks.slice(0, 3).join(", ")}]`);
    if (diff.removedLandmarks.length) parts.push(`closed [${diff.removedLandmarks.slice(0, 3).join(", ")}]`);
    if (diff.changedInteractables.length) {
      parts.push(
        `changed ${diff.changedInteractables
          .slice(0, 2)
          .map((c) => `"${c.name}"`)
          .join(", ")}`,
      );
    }
    if (parts.length === 0 && diff.addedTextBlocks.length > 0) {
      parts.push(`added ${diff.addedTextBlocks.length} text block(s)`);
    }

    let observedEffect: ActionEffect = fallbackEffect;
    if (
      diff.addedLandmarks.some((l) => l.startsWith("dialog:")) ||
      diff.changedInteractables.length > 0 ||
      diff.removedLandmarks.length > 0
    ) {
      observedEffect = fallbackEffect === "destructive" ? "destructive" : "mutate";
    }

    const outcome: CachedActionOutcome = {
      origin,
      selector,
      hits: (existing?.hits ?? 0) + 1,
      lastObservedAt: Date.now(),
      observedEffect,
      summary: parts.length ? parts.join("; ") : "no visible structural change",
      addedAlerts,
      addedLandmarks: diff.addedLandmarks.slice(0, 5),
      removedLandmarks: diff.removedLandmarks.slice(0, 5),
    };

    this.entries.set(key, outcome);
    return outcome;
  }

  size(): number {
    return this.entries.size;
  }

  list(): CachedActionOutcome[] {
    return [...this.entries.values()];
  }

  clear(): void {
    this.entries.clear();
  }
}
