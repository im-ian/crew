import { groupOfBot } from "./botLabel";
import type { AgentInfo, Group } from "./types";

/** One bot in the ⌘K list. */
export type SwitchRow = {
  agent: AgentInfo;
  /** The folder it sits in, or the router a teammate's bot is on. Empty: neither. */
  group: string;
};

const RECENT_KEY = "crew.recent-chats";
/** How many opened chats the list remembers. */
export const RECENT_MAX = 30;

/** The open chat goes to the front of the ones seen before it. */
export function pushRecent(list: readonly string[], id: string, max = RECENT_MAX): string[] {
  return [id, ...list.filter((x) => x !== id)].slice(0, max);
}

export function loadRecent(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function saveRecent(list: readonly string[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* private mode */
  }
}

/**
 * How well `query` matches `text`, higher is better; null when it does not.
 * The whole text beats its start, its start beats a word's start, that beats
 * anywhere inside, and letters in order with gaps come last, closer together
 * scoring higher. Hangul is compared by syllable, as it is typed.
 */
export function fuzzyScore(text: string, query: string): number | null {
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  if (!q) return 0;
  if (t === q) return 1000;
  // Two names that both start with it tie, so the one opened last leads.
  if (t.startsWith(q)) return 800;
  const at = t.indexOf(q);
  if (at > 0) {
    let word = -1;
    for (let i = t.indexOf(q); i > 0; i = t.indexOf(q, i + 1)) {
      if (/[\s\-_.·/#@]/.test(t[i - 1])) {
        word = i;
        break;
      }
    }
    if (word > 0) return 600 - Math.min(word, 99);
    return 400 - Math.min(at, 99);
  }
  // In order, with gaps.
  let from = 0;
  let first = -1;
  let gaps = 0;
  let prev = -1;
  for (const ch of q) {
    if (/\s/.test(ch)) continue;
    const i = t.indexOf(ch, from);
    if (i < 0) return null;
    if (first < 0) first = i;
    if (prev >= 0) gaps += i - prev - 1;
    prev = i;
    from = i + 1;
  }
  return Math.max(1, 200 - gaps * 8 - Math.min(first, 40));
}

/** The words a bot is found by: its name, its id, and its folder or router. */
function fieldsOf(row: SwitchRow): string[] {
  const name = row.agent.name || row.agent.id;
  return [name, row.agent.id, row.group].filter(Boolean);
}

/**
 * Each word of the query has to match one of the bot's fields, so
 * `crew 디버` finds 디버거 in the Crew folder. The best field counts per word;
 * a match on the name is worth a little more than one on the folder.
 */
export function rowScore(row: SwitchRow, query: string): number | null {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 0;
  const fields = fieldsOf(row);
  let total = 0;
  for (const word of words) {
    let best: number | null = null;
    fields.forEach((field, i) => {
      const s = fuzzyScore(field, word);
      if (s === null) return;
      // The name first, then the id, then the folder.
      const scored = s - i * 5;
      if (best === null || scored > best) best = scored;
    });
    if (best === null) return null;
    total += best;
  }
  return total;
}

/**
 * The ⌘K list. Typed nothing: the chats opened most recently first, then the
 * rest as the sidebar stacks them (`order`), then any the sidebar has folded
 * away, with the chat already open last. Typed something: the bots that
 * match, best first, ties in that same order.
 */
export function switchRows(opts: {
  agents: readonly AgentInfo[];
  groups: readonly Group[];
  /** Bot ids top to bottom as the sidebar shows them. */
  order: readonly string[];
  /** Bot ids opened before, newest first. */
  recent: readonly string[];
  current: string | null;
  query: string;
}): SwitchRow[] {
  const byId = new Map(opts.agents.map((a) => [a.id, a]));
  const ids: string[] = [];
  const seen = new Set<string>();
  const add = (id: string) => {
    if (seen.has(id) || !byId.has(id) || id === opts.current) return;
    seen.add(id);
    ids.push(id);
  };
  opts.recent.forEach(add);
  opts.order.forEach(add);
  opts.agents.forEach((a) => add(a.id));
  if (opts.current && byId.has(opts.current)) ids.push(opts.current);
  const rows = ids.map((id) => {
    const agent = byId.get(id)!;
    const group = agent.remote ?? groupOfBot(opts.groups, id)?.name.trim() ?? "";
    return { agent, group };
  });
  if (!opts.query.trim()) return rows;
  return rows
    .map((row, i) => ({ row, i, score: rowScore(row, opts.query) }))
    .filter((x): x is { row: SwitchRow; i: number; score: number } => x.score !== null)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.row);
}

/** One step through the list, wrapping at either end. */
export function stepIndex(index: number, count: number, dir: 1 | -1): number {
  if (count <= 0) return 0;
  return (index + dir + count) % count;
}

/**
 * Whether an Enter or an arrow belongs to the IME. While Hangul is composing,
 * the key that ends the syllable arrives with `isComposing` (or keyCode 229,
 * as WebKit sends it); acting on it would pick a row for half a syllable.
 */
export function imeKey(e: { isComposing?: boolean; keyCode?: number }): boolean {
  return !!e.isComposing || e.keyCode === 229;
}
