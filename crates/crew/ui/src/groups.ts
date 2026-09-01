import type { AgentInfo, ChannelInfo, Group, Kind } from "./types";

export const UNGROUPED_ID = "__ungrouped";

export type RailLayout = {
  groups: Group[];
  ungrouped: string[];
};

export function itemKey(kind: Kind, id: string): string {
  return `${kind}:${id}`;
}

export function parseItemKey(key: string): { kind: Kind; id: string } | null {
  const i = key.indexOf(":");
  if (i <= 0) return null;
  const kind = key.slice(0, i);
  const id = key.slice(i + 1);
  if ((kind !== "agent" && kind !== "channel") || !id) return null;
  return { kind, id };
}

export function normalizeGroups(raw: unknown): RailLayout {
  if (!Array.isArray(raw)) return { groups: [], ungrouped: [] };
  const out: Group[] = [];
  const seen = new Set<string>();
  let ungrouped: string[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const g = row as Partial<Group>;
    const id = typeof g.id === "string" ? g.id.trim() : "";
    const items = Array.isArray(g.items)
      ? g.items.filter((k): k is string => typeof k === "string" && !!parseItemKey(k))
      : [];
    if (id === UNGROUPED_ID) {
      ungrouped = uniqueKeys(items);
      continue;
    }
    const name = typeof g.name === "string" ? g.name.trim() : "";
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name,
      collapsed: !!g.collapsed,
      items: uniqueKeys(items),
    });
  }
  return { groups: out, ungrouped };
}

export function toPersist(layout: RailLayout): Group[] {
  const groups = layout.groups.filter((g) => g.id !== UNGROUPED_ID);
  if (!layout.ungrouped.length) return groups;
  return [
    ...groups,
    {
      id: UNGROUPED_ID,
      name: "",
      collapsed: false,
      items: uniqueKeys(layout.ungrouped),
    },
  ];
}

export function uniqueGroupName(groups: Group[], base = "새 그룹"): string {
  const taken = new Set(groups.map((g) => g.name));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} ${n}`)) n += 1;
  return `${base} ${n}`;
}

export function newGroupId(existing: string[]): string {
  const taken = new Set(existing);
  let id = "g" + Date.now().toString(16);
  if (!taken.has(id)) return id;
  id = id + "-" + Math.random().toString(16).slice(2, 8);
  return taken.has(id) ? id + "-x" : id;
}

export function groupIdOf(groups: Group[], kind: Kind, id: string): string | null {
  const key = itemKey(kind, id);
  const found = groups.find((g) => g.items.includes(key));
  return found ? found.id : null;
}

export function pruneLayout(
  layout: RailLayout,
  agents: AgentInfo[],
  channels: ChannelInfo[],
): RailLayout {
  const valid = validKeys(agents, channels);
  return {
    groups: layout.groups
      .filter((g) => g.id !== UNGROUPED_ID)
      .map((g) => ({
        ...g,
        items: g.items.filter((k) => valid.has(k)),
      })),
    ungrouped: layout.ungrouped.filter((k) => valid.has(k)),
  };
}

export function layoutChanged(a: RailLayout, b: RailLayout): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}

export function visibleUngroupedKeys(
  groups: Group[],
  ungrouped: string[],
  agents: AgentInfo[],
  channels: ChannelInfo[],
): string[] {
  const grouped = new Set(groups.flatMap((g) => g.items));
  const present: { key: string; name: string }[] = [];
  for (const a of agents) {
    const key = itemKey("agent", a.id);
    if (!grouped.has(key)) present.push({ key, name: a.name || a.id });
  }
  for (const c of channels) {
    const key = itemKey("channel", c.id);
    if (!grouped.has(key)) present.push({ key, name: c.name || c.id });
  }
  const byKey = new Map(present.map((p) => [p.key, p]));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const k of ungrouped) {
    if (!byKey.has(k) || seen.has(k)) continue;
    out.push(k);
    seen.add(k);
  }
  const rest = present.filter((p) => !seen.has(p.key));
  rest.sort((a, b) => a.name.localeCompare(b.name, "ko"));
  for (const p of rest) out.push(p.key);
  return out;
}

/** Sidebar order for keyboard next/prev. Collapsed group children are skipped. */
export function railOrder(
  groups: Group[],
  ungrouped: string[],
  agents: AgentInfo[],
  channels: ChannelInfo[],
): { kind: Kind; id: string }[] {
  const valid = validKeys(agents, channels);
  const out: { kind: Kind; id: string }[] = [];
  const used = new Set<string>();
  for (const g of groups) {
    if (g.id === UNGROUPED_ID) continue;
    for (const key of g.items) {
      if (!valid.has(key) || used.has(key)) continue;
      used.add(key);
      if (g.collapsed) continue;
      const parsed = parseItemKey(key);
      if (parsed) out.push(parsed);
    }
  }
  for (const key of visibleUngroupedKeys(groups, ungrouped, agents, channels)) {
    if (used.has(key)) continue;
    used.add(key);
    const parsed = parseItemKey(key);
    if (parsed) out.push(parsed);
  }
  return out;
}

export function moveItem(
  layout: RailLayout,
  key: string,
  destGroupId: string | null,
  beforeKey: string | null | undefined,
  ungroupedVisual: string[],
): RailLayout {
  const parsed = parseItemKey(key);
  if (!parsed) return layout;
  if (beforeKey === key) return layout;
  if (
    destGroupId &&
    destGroupId !== UNGROUPED_ID &&
    !layout.groups.some((g) => g.id === destGroupId)
  ) {
    return layout;
  }
  const groups = layout.groups
    .filter((g) => g.id !== UNGROUPED_ID)
    .map((g) => ({
      ...g,
      items: g.items.filter((k) => k !== key),
    }));
  if (!destGroupId) {
    const list = ungroupedVisual.filter((k) => k !== key);
    const idx = beforeKey ? list.indexOf(beforeKey) : -1;
    if (idx < 0) list.push(key);
    else list.splice(idx, 0, key);
    return { groups, ungrouped: uniqueKeys(list) };
  }
  return {
    groups: groups.map((g) => {
      if (g.id !== destGroupId) return g;
      const items = [...g.items];
      const idx = beforeKey ? items.indexOf(beforeKey) : -1;
      if (idx < 0) items.push(key);
      else items.splice(idx, 0, key);
      return { ...g, items };
    }),
    ungrouped: uniqueKeys(ungroupedVisual.filter((k) => k !== key)),
  };
}

export function validKeys(
  agents: AgentInfo[],
  channels: ChannelInfo[],
): Set<string> {
  const keys = new Set<string>();
  for (const a of agents) keys.add(itemKey("agent", a.id));
  for (const c of channels) keys.add(itemKey("channel", c.id));
  return keys;
}

export function uniqueKeys(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of items) {
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}
