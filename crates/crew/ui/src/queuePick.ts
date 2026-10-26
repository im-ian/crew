import type { TFn } from "./i18n";
import { displayWho, sentTarget } from "./peek";
import { splitReply, type ReplyTarget } from "./reply";
import type { AgentInfo } from "./types";

/** User lines still waiting, oldest first. ArrowUp walks them toward the older ones. */
export function waitingIds(
  messages: { id: string; role: string; queued?: boolean }[],
): string[] {
  return messages.filter((m) => m.queued && m.role === "user").map((m) => m.id);
}

/**
 * Move the selection through `ids`. Up from nothing picks the newest. Down
 * from the newest clears it. Up on the oldest stays there.
 */
export function stepQueuePick(
  ids: readonly string[],
  current: string | null,
  dir: "prev" | "next",
): string | null {
  if (ids.length === 0) return null;
  const at = current ? ids.indexOf(current) : -1;
  if (dir === "prev") {
    if (at <= 0) return at === 0 ? ids[0] : ids[ids.length - 1];
    return ids[at - 1];
  }
  if (at < 0 || at >= ids.length - 1) return null;
  return ids[at + 1];
}

/** What the composer opens when Enter edits a waiting line. */
export function waitingEdit(
  text: string,
  agents: AgentInfo[],
  t: TFn,
): { body: string; reply: ReplyTarget | null } {
  const { reply, body } = splitReply(text);
  if (!reply) return { body, reply: null };
  const id = sentTarget(reply.from) ?? reply.from;
  const who =
    reply.from === "user"
      ? t("thread.you")
      : displayWho(id, agents.find((a) => a.id === id) ?? null, t);
  return {
    body,
    reply: { id: reply.id, from: reply.from, who, text: reply.snippet },
  };
}
