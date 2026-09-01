import type { AgentInfo, AgentStatus } from "./types";

export function isBusyStatus(status: AgentStatus | null | undefined): boolean {
  return status === "working" || status === "blocked";
}

/** Bots whose in-flight turn belongs to this channel. */
export function busyInChannel(
  agents: AgentInfo[],
  channelId: string | null | undefined,
): AgentInfo[] {
  if (!channelId) return [];
  return agents.filter(
    (a) => isBusyStatus(a.status) && a.origin_channel === channelId,
  );
}
