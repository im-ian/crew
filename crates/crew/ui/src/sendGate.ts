import type { ChatMessage } from "./types";

/**
 * A send this window drew before the daemon answered. `id` goes with the send,
 * and the daemon's row keeps it, so that row takes this line's place.
 */
export type HeldSend = { id: string; agent: string; text: string; at: number };

/** How a user line may look. `sending` is drawn now, before the daemon answers. */
export type UserLineAppearance = "waiting" | "sent" | "sending" | "other";

/**
 * A user line waits only while the daemon row is queued.
 * It is a sent bubble only after that flag is gone.
 * A line this window inserted early is sending: drawn, but with nothing to
 * edit, cancel or reply to until the daemon row takes its place.
 */
export function userLineAppearance(m: {
  role: string;
  queued?: boolean;
  optimistic?: boolean;
}): UserLineAppearance {
  if (m.optimistic) return "sending";
  if (m.role !== "user") return "other";
  if (m.queued === true) return "waiting";
  return "sent";
}

/** Edit and cancel open only on a waiting user line. */
export function queueActions(m: {
  role: string;
  queued?: boolean;
  optimistic?: boolean;
}): { edit: boolean; cancel: boolean } {
  const open = userLineAppearance(m) === "waiting";
  return { edit: open, cancel: open };
}

/** A row id for a send, made here so the daemon's row can keep it. */
export function sendRowId(seq: number, now: number, rand = Math.random()): string {
  return `u-${now}-${seq}-${Math.floor(rand * 0xffffff).toString(36)}`;
}

export function optimisticLine(held: HeldSend): ChatMessage {
  return {
    id: held.id,
    role: "user",
    from: "user",
    text: held.text,
    ts: held.at,
    optimistic: true,
  };
}

/**
 * Keep sends the daemon has not answered on the end of its snapshot, until a
 * row with the send's id is in it.
 */
export function withUnaccepted(
  messages: readonly ChatMessage[],
  held: readonly HeldSend[],
): ChatMessage[] {
  if (!held.length) return messages as ChatMessage[];
  const ids = new Set(messages.map((m) => m.id));
  const extra = held.filter((h) => !ids.has(h.id)).map(optimisticLine);
  if (!extra.length) return messages as ChatMessage[];
  return [...messages, ...extra];
}

export function heldFor(agent: string, held: readonly HeldSend[]): HeldSend[] {
  return held.filter((h) => h.agent === agent);
}

/** Drop the unaccepted line and hand its text back to the composer. */
export function rollbackSend(
  messages: readonly ChatMessage[],
  id: string,
): { messages: ChatMessage[]; restore: string | null } {
  const row = messages.find((m) => m.id === id && m.optimistic);
  if (!row) return { messages: messages as ChatMessage[], restore: null };
  return {
    messages: messages.filter((m) => m !== row),
    restore: row.text,
  };
}

/** The invoke failed, but the daemon still kept this send: its row is there. */
export function sendKept(
  messages: readonly { id: string; optimistic?: boolean }[],
  id: string,
): boolean {
  return messages.some((m) => m.id === id && !m.optimistic);
}

/**
 * `null` leaves the composer cleared, because the daemon accepted the send.
 * Anything else is the draft to put back.
 */
export function composerAfterSend(
  accepted: boolean,
  draft: string,
): string | null {
  return accepted ? null : draft;
}

/** Stop never writes a thread row. The next daemon snapshot is the thread. */
export function applyStop<T>(messages: T[]): T[] {
  return messages;
}

/** Both stop buttons ask the daemon to stop. They do not build a row here. */
export function stopTurn(stopAgent: () => void): void {
  stopAgent();
}
