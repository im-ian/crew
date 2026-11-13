import { botDefaultOf, type BotDefault } from "./botDefault";
import type { CliKind } from "./types";

/**
 * The default AI, now a list. The first one is what a new bot starts on.
 * When a bot's own AI is out of its limit, the daemon runs that turn on the
 * others, top to bottom. It keeps the list in `fallback-ai.json`.
 */
export type AiChoice = BotDefault;

/** One the daemon kept, cleaned up the way a stored default is. */
export function aiListOf(stored: unknown): AiChoice[] | null {
  if (!Array.isArray(stored)) return null;
  const out: AiChoice[] = [];
  for (const v of stored) {
    const ai = botDefaultOf(JSON.stringify(v));
    // `botDefaultOf` falls back to Grok on a broken entry; that is not one.
    if (ai.cli === (v as { cli?: unknown } | null)?.cli) out.push(ai);
  }
  return out.length > 0 ? out : null;
}

/** The list the window shows: the daemon's, or the old single default. */
export function startingList(kept: AiChoice[] | null, legacy: AiChoice): AiChoice[] {
  return kept && kept.length > 0 ? kept : [legacy];
}

/** `list` with the entry at `from` placed at `to`, both indexes into `list`. */
export function moveAi<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length) return [...list];
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, item);
  return next;
}

/** One more, on the first CLI the list does not have yet. */
export function addAi(list: readonly AiChoice[], order: readonly CliKind[]): AiChoice[] {
  const used = new Set(list.map((a) => a.cli));
  const cli = order.find((c) => c !== "custom" && !used.has(c)) ?? order[0];
  return [...list, { cli, model: "", effort: "", cmd: "" }];
}

/** Without the one at `index`. The last one stays: a new bot needs an AI. */
export function removeAi(list: readonly AiChoice[], index: number): AiChoice[] {
  if (list.length <= 1) return [...list];
  return list.filter((_, i) => i !== index);
}

/**
 * Where a dragged row lands, from the pointer's y and each row's vertical
 * middle, top to bottom. The answer is the index it takes after the move.
 */
export function dropIndex(mids: readonly number[], y: number, from: number): number {
  let before = mids.findIndex((mid) => y < mid);
  if (before < 0) before = mids.length;
  // Taking the row out shifts everything after it up by one.
  return before > from ? before - 1 : before;
}
