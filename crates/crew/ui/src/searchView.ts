import type { SearchHit } from "./types";

export type MatchRun = { text: string; match: boolean };

/**
 * A snippet split around each place the query appears, any case, so the
 * list can mark what was found.
 */
export function matchRuns(text: string, query: string): MatchRun[] {
  const q = query.trim().toLowerCase();
  if (!q) return text ? [{ text, match: false }] : [];
  const lower = text.toLowerCase();
  // Lowercasing that changes a string's length would put the marks in the
  // wrong place, so such a snippet is left unmarked.
  if (lower.length !== text.length) return [{ text, match: false }];
  const runs: MatchRun[] = [];
  let at = 0;
  for (let i = lower.indexOf(q); i >= 0; i = lower.indexOf(q, at)) {
    if (i > at) runs.push({ text: text.slice(at, i), match: false });
    runs.push({ text: text.slice(i, i + q.length), match: true });
    at = i + q.length;
  }
  if (at < text.length) runs.push({ text: text.slice(at), match: false });
  return runs;
}

/**
 * The hits listed under the rail. A bot hit is left out: the rail above is
 * already filtered to the bots the query finds.
 */
export function listedHits(hits: readonly SearchHit[]): SearchHit[] {
  return hits.filter((hit) => hit.kind !== "bot");
}
