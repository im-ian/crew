import { useRef } from "react";

/**
 * How many rows can land in an empty chat and still be an arrival.
 * A history load is a batch; a line or two is someone speaking.
 */
const EMPTY_BURST = 2;

/** Shared by the entrance, the scroll pin, and the dots row closing. */
export const ARRIVE_MS = 280;

/**
 * Slack for a row the daemon stamped just before the chat opened and the
 * window got a moment later. Anything older was already there.
 */
export const OPEN_SLACK_MS = 1500;

/** The typing row. It is not part of the thread, so a reply that replaces it still arrives. */
function isTypingRow(id: string): boolean {
  return id.startsWith("working-");
}

/**
 * Row ids that just showed up on a thread already on screen.
 * A loaded history or a switched chat shares no message with the previous
 * list, so those rows stay still. An empty chat has no previous message,
 * and the next one or two are the line that just landed.
 * `isNew` drops a row that was written before the chat was opened: tool cards
 * shown again, older history, a chat whose rows load a moment late.
 */
export function arrivingIds(
  prev: readonly string[],
  next: readonly string[],
  isNew: (id: string) => boolean = () => true,
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
  return [...rows.filter(isNew), ...freshTyping];
}

/**
 * Height a fresh row should open from. Null when the row is not arriving.
 * The reply that takes the typing row's place starts at that row's height,
 * so the thread does not collapse and grow back. Every other arrival
 * starts at zero.
 */
export function arriveStart(
  prev: readonly string[],
  next: readonly string[],
  id: string,
  typingHeight: number,
  isNew: (id: string) => boolean = () => true,
): number | null {
  const fresh = arrivingIds(prev, next, isNew);
  if (!fresh.includes(id)) return null;
  const typingLeft = prev.some((row) => isTypingRow(row) && !next.includes(row));
  if (!typingLeft || isTypingRow(id)) return 0;
  const taker = fresh.find((row) => !isTypingRow(row));
  return id === taker ? typingHeight : 0;
}

/**
 * Ids whose row should play the entrance, with the height it starts from.
 * The first paint is the baseline, and a start height stays put so a later
 * render does not restart the motion.
 */
export function useArriving(
  ids: readonly string[],
  typingHeight: () => number,
  isNew: (id: string) => boolean = () => true,
): Map<string, number> {
  const track = useRef<{
    ids: string[];
    arrive: Map<string, number>;
    ready: boolean;
  }>({
    ids: [],
    arrive: new Map(),
    ready: false,
  });
  const prev = track.current.ids;
  const same =
    prev.length === ids.length && prev.every((id, i) => id === ids[i]);
  if (!track.current.ready) {
    track.current = { ids: [...ids], arrive: new Map(), ready: true };
  } else if (!same) {
    const height = typingHeight();
    const arrive = new Map(track.current.arrive);
    for (const id of arrivingIds(prev, ids, isNew)) {
      const start = arriveStart(prev, ids, id, height, isNew);
      if (start !== null && !arrive.has(id)) arrive.set(id, start);
    }
    for (const id of [...arrive.keys()]) {
      if (!ids.includes(id)) arrive.delete(id);
    }
    track.current = { ids: [...ids], arrive, ready: true };
  }
  return track.current.arrive;
}

/**
 * Fade the row in where it already sits. The slot is not clipped or grown,
 * so the text is never cut while it arrives.
 * The reply that takes the typing row's place (`fromHeight` above zero) was
 * already on screen as that row, so it does not fade in again.
 */
export function playArrive(slot: HTMLElement, fromHeight: number): () => void {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return () => {};
  }
  if (fromHeight > 0) return () => {};
  const grow = slot.firstElementChild;
  if (!(grow instanceof HTMLElement)) return () => {};
  const ease =
    getComputedStyle(slot).getPropertyValue("--ease-out").trim() ||
    "cubic-bezier(0.16, 1, 0.3, 1)";
  const fade = grow.animate([{ opacity: 0 }, { opacity: 1 }], {
    duration: ARRIVE_MS,
    easing: ease,
  });
  return () => fade.cancel();
}
