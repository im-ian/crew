import type { ChatMessage } from "./types";

/** A send this window drew before the daemon answered. `at` is when it left. */
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
 * Keep sends the daemon has not answered on the end of its snapshot. A send
 * whose row is already there is left out, so it never shows twice: each row
 * the user typed, with the same text and written no earlier than the send
 * left, stands for one send, oldest first.
 */
export function withUnaccepted(
  messages: readonly ChatMessage[],
  held: readonly HeldSend[],
): ChatMessage[] {
  if (!held.length) return messages as ChatMessage[];
  const ids = new Set(messages.map((m) => m.id));
  const rows = messages.filter((m) => m.role === "user" && m.from === "user" && !m.answer);
  const taken = new Set<ChatMessage>();
  const extra: ChatMessage[] = [];
  for (const h of held) {
    if (ids.has(h.id)) continue;
    const row = rows.find((m) => !taken.has(m) && m.text === h.text && m.ts >= h.at);
    if (row) {
      taken.add(row);
      continue;
    }
    extra.push(optimisticLine(h));
  }
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

/** The invoke failed, but the daemon still kept this send as a waiting line. */
export function sendKeptQueued(
  messages: readonly { role: string; queued?: boolean; text: string }[],
  text: string,
): boolean {
  return messages.some((m) => m.role === "user" && m.queued === true && m.text === text);
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
