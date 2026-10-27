export type FaceLine = {
  id: string;
  role: string;
  from: string;
  queued?: boolean;
  peer?: string | null;
  kind?: string | null;
};

/**
 * A 1:1 room shows the bot once, on its latest line.
 * The typing row takes that spot while a turn has no bubble of its own.
 */
export function threadFaceId(
  messages: readonly FaceLine[],
  agentId: string | null,
  typingId: string | null,
): string | null {
  if (!agentId) return null;
  if (typingId) return typingId;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.queued || m.peer || m.kind) continue;
    if (m.role === "assistant" && m.from === agentId) return m.id;
  }
  return null;
}
