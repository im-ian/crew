import { useRef } from "react";

/**
 * How many rows can land in an empty chat and still be an arrival.
 * A history load is a batch; a line or two is someone speaking.
 */
const EMPTY_BURST = 2;

/** The typing row. It is not part of the thread, so a reply that replaces it still arrives. */
function isTypingRow(id: string): boolean {
  return id.startsWith("working-");
}

/**
 * Row ids that just showed up on a thread already on screen.
 * A loaded history or a switched chat shares no message with the previous
 * list, so those rows stay still. An empty chat has no previous message,
 * and the next one or two are the line that just landed.
 */
export function arrivingIds(
  prev: readonly string[],
  next: readonly string[],
): string[] {
  const prevRows = prev.filter((id) => !isTypingRow(id));
  const seen = new Set(prevRows);
  const freshRows = next.filter((id) => !isTypingRow(id) && !seen.has(id));
  const freshTyping = next.filter((id) => isTypingRow(id) && !prev.includes(id));
  let rows: string[] = [];
  if (freshRows.length > 0) {
    const kept = next.some((id) => !isTypingRow(id) && seen.has(id));
    if (prevRows.length === 0) {
      if (freshRows.length <= EMPTY_BURST) rows = freshRows;
    } else if (kept) {
      rows = freshRows;
    }
  }
  return [...rows, ...freshTyping];
}

/** Ids whose row should play the entrance. The first paint is the baseline. */
export function useArriving(ids: readonly string[]): Set<string> {
  const track = useRef<{ ids: string[]; arrive: Set<string>; ready: boolean }>({
    ids: [],
    arrive: new Set(),
    ready: false,
  });
  const prev = track.current.ids;
  const same =
    prev.length === ids.length && prev.every((id, i) => id === ids[i]);
  if (!track.current.ready) {
    track.current = { ids: [...ids], arrive: new Set(), ready: true };
  } else if (!same) {
    const fresh = new Set(arrivingIds(prev, ids));
    const arrive = new Set<string>();
    for (const id of ids) {
      if (fresh.has(id) || track.current.arrive.has(id)) arrive.add(id);
    }
    track.current = { ids: [...ids], arrive, ready: true };
  }
  return track.current.arrive;
}
