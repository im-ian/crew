import type { AgentInfo, ChannelInfo, Group, Kind } from "./types";

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

export function normalizeGroups(raw: unknown): Group[] {
  if (!Array.isArray(raw)) return [];
  const out: Group[] = [];
  const seen = new Set<string>();
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const g = row as Partial<Group>;
    const id = typeof g.id === "string" ? g.id.trim() : "";
    const name = typeof g.name === "string" ? g.name.trim() : "";
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    const items = Array.isArray(g.items)
      ? g.items.filter((k): k is string => typeof k === "string" && !!parseItemKey(k))
      : [];
    out.push({
      id,
      name,
      collapsed: !!g.collapsed,
      items: uniqueKeys(items),
    });
  }
  return out;
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

export function pruneGroups(
  groups: Group[],
  agents: AgentInfo[],
  channels: ChannelInfo[],
): Group[] {
  const valid = validKeys(agents, channels);
  return groups.map((g) => ({
    ...g,
    items: g.items.filter((k) => valid.has(k)),
  }));
}

export function groupsChanged(a: Group[], b: Group[]): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}

export function moveItem(
  groups: Group[],
  key: string,
  destGroupId: string | null,
  beforeKey?: string | null,
): Group[] {
  const parsed = parseItemKey(key);
  if (!parsed) return groups;
  const next = groups.map((g) => ({
    ...g,
    items: g.items.filter((k) => k !== key),
  }));
  if (!destGroupId) return next;
  return next.map((g) => {
    if (g.id !== destGroupId) return g;
    const items = [...g.items];
    const idx = beforeKey ? items.indexOf(beforeKey) : -1;
    if (idx < 0) items.push(key);
    else items.splice(idx, 0, key);
    return { ...g, items };
  });
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

function uniqueKeys(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of items) {
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}
