import { groupLead, parseItemKey } from "./groups";
import type { AgentInfo, Group } from "./types";

/**
 * The sidebar group `botId` leads (Make group lead), or null. A router's
 * representative is a different thing and does not count.
 */
export function ledGroup(groups: readonly Group[], botId: string | null | undefined): Group | null {
  if (!botId) return null;
  return groups.find((g) => groupLead(g) === botId) ?? null;
}

/** The group's bots in sidebar order, the lead among them. Ids with no bot behind them are left out. */
export function groupBots(group: Group, agents: readonly AgentInfo[]): AgentInfo[] {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const out: AgentInfo[] = [];
  for (const key of group.items) {
    const item = parseItemKey(key);
    const agent = item ? byId.get(item.id) : undefined;
    if (agent) out.push(agent);
  }
  return out;
}
