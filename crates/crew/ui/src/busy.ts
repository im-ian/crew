import type { AgentStatus } from "./types";

export function isBusyStatus(status: AgentStatus | null | undefined): boolean {
  return status === "working" || status === "blocked";
}
