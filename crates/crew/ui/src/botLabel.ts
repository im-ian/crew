import { itemKey } from "./groups";
import { mentionLabel } from "./mentions";
import type { AgentInfo, Group } from "./types";

/** Between a group and a bot's name, as the screen reads them. */
export const LABEL_SEP = " · ";

export function groupOfBot(groups: readonly Group[], id: string): Group | null {
  const key = itemKey("agent", id);
  return groups.find((g) => g.items.includes(key)) ?? null;
}

/**
 * How a bot is named outside its own sidebar row: `group · name`, so two
 * bots with one name in two groups read apart. A bot in the same group as
 * the bot whose chat is open needs no group, and a loose bot has none.
 * A teammate's bot is in no folder; it says its server the same way.
 */
export function botLabel(
  agent: AgentInfo,
  groups: readonly Group[],
  viewerId?: string | null,
): string {
  if (agent.remote) return mentionLabel(agent);
  const name = agent.name || agent.id;
  const group = groupOfBot(groups, agent.id);
  if (!group) return name;
  if (viewerId && groupOfBot(groups, viewerId)?.id === group.id) return name;
  return group.name + LABEL_SEP + name;
}

/**
 * The text a search reads for a bot. Its name, its id and its group's name
 * each find it, and so does the label typed out as shown or with a space.
 */
export function botSearchText(agent: AgentInfo, groups: readonly Group[]): string {
  const name = agent.name || agent.id;
  const group = groupOfBot(groups, agent.id);
  const named = group ? [group.name + LABEL_SEP + name, group.name + " " + name] : [name];
  return [...named, agent.id].join("\n");
}
