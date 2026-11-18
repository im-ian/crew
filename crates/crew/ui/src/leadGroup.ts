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

/**
 * Leads whose group pane the user left open, each with the group it showed.
 * Only the user's own close drops one: another chat, a file or a side chat
 * taking the place for a while does not. Not stored: like the other panels
 * beside the chat, it starts closed when the app opens again.
 */
export type LeadKept = Readonly<Record<string, string>>;

/** The header's group button: shown, it closes; otherwise it opens and stays open. */
export function toggleLeadKept(
  kept: LeadKept,
  groups: readonly Group[],
  leadId: string,
  shown: boolean,
): LeadKept {
  const group = ledGroup(groups, leadId);
  if (shown || !group) return dropLeadKept(kept, leadId);
  return { ...kept, [leadId]: group.id };
}

export function dropLeadKept(kept: LeadKept, leadId: string): LeadKept {
  if (!(leadId in kept)) return kept;
  const { [leadId]: _, ...rest } = kept;
  return rest;
}

/**
 * The group pane beside `selected`'s chat, or null. It was left open for this
 * bot, the bot still leads that same group, and no file or side chat (`taken`)
 * holds the place. A bot that stopped leading, or leads another group now, is
 * not shown its old pane.
 */
export function shownLeadGroup(
  kept: LeadKept,
  groups: readonly Group[],
  selected: string | null | undefined,
  taken: boolean,
): Group | null {
  if (taken || !selected) return null;
  const groupId = kept[selected];
  if (!groupId) return null;
  const group = ledGroup(groups, selected);
  return group && group.id === groupId ? group : null;
}
