import type { AgentInfo, Group, Kind } from "./types";

export const UNGROUPED_ID = "__ungrouped";

export type RailLayout = {
  groups: Group[];
  ungrouped: string[];
  /**
   * Top-level keys, top to bottom: folder ids and loose `agent:` keys.
   * Absent means every folder, then every loose bot.
   */
  order?: string[];
};

export function itemKey(kind: Kind, id: string): string {
  return `${kind}:${id}`;
}

export function parseItemKey(key: string): { kind: Kind; id: string } | null {
  const i = key.indexOf(":");
  if (i <= 0) return null;
  const kind = key.slice(0, i);
  const id = key.slice(i + 1);
  if (kind !== "agent" || !id) return null;
  return { kind, id };
}

export function normalizeGroups(raw: unknown): RailLayout {
  if (!Array.isArray(raw)) return { groups: [], ungrouped: [] };
  const out: Group[] = [];
  const seen = new Set<string>();
  const ungrouped: string[] = [];
  const order: string[] = [];
  const looseSeen = new Set<string>();
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const g = row as Partial<Group>;
    const id = typeof g.id === "string" ? g.id.trim() : "";
    const items = Array.isArray(g.items)
      ? g.items.filter((k): k is string => typeof k === "string" && !!parseItemKey(k))
      : [];
    if (id === UNGROUPED_ID) {
      for (const key of uniqueKeys(items)) {
        if (looseSeen.has(key)) continue;
        looseSeen.add(key);
        ungrouped.push(key);
        order.push(key);
      }
      continue;
    }
    const name = typeof g.name === "string" ? g.name.trim() : "";
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    const path = typeof g.path === "string" ? g.path.trim() : "";
    const next: Group = {
      id,
      name,
      collapsed: !!g.collapsed,
      items: uniqueKeys(items),
    };
    if (path) next.path = path;
    out.push(next);
    order.push(id);
  }
  return applyOrder(out, order);
}

/** Last path segment. A trailing slash is the picker's, not part of the name. */
export function folderName(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return (cut >= 0 ? trimmed.slice(cut + 1) : trimmed).trim();
}

/** Working folder a group gives its bots. Blank is the same as none. */
export function groupCwd(
  group: { path?: string | null } | null | undefined,
): string | null {
  const path = group?.path?.trim() ?? "";
  return path || null;
}

/** Give a group a working folder, or take it away with a blank one. */
export function setGroupFolder(layout: RailLayout, id: string, path: string): RailLayout {
  const folder = path.trim();
  return {
    groups: layout.groups.map((g) => {
      if (g.id !== id) return g;
      if (folder) return { ...g, path: folder };
      return { id: g.id, name: g.name, collapsed: g.collapsed, items: g.items };
    }),
    ungrouped: layout.ungrouped,
    ...(layout.order ? { order: layout.order } : {}),
  };
}

function persistedGroup(g: Group): Group {
  const path = groupCwd(g);
  if (!path) {
    if (g.path == null) return g;
    return { id: g.id, name: g.name, collapsed: g.collapsed, items: g.items };
  }
  return { ...g, path };
}

export function toPersist(layout: RailLayout): Group[] {
  const byId = new Map(
    layout.groups.filter((g) => g.id !== UNGROUPED_ID).map((g) => [g.id, g]),
  );
  const out: Group[] = [];
  let bucket: string[] = [];
  const flush = () => {
    if (!bucket.length) return;
    out.push({
      id: UNGROUPED_ID,
      name: "",
      collapsed: false,
      items: bucket,
    });
    bucket = [];
  };
  for (const key of orderedSlots(layout)) {
    const group = byId.get(key);
    if (group) {
      flush();
      out.push(persistedGroup(group));
    } else if (parseItemKey(key)) {
      bucket.push(key);
    }
  }
  flush();
  return out;
}

/** Folders a bot just wrote. Folders the window already has stay as they are,
    so this poll cannot undo a rename or a drag that is still only local. */
export function adoptNewGroups(local: RailLayout, remoteRaw: unknown): RailLayout | null {
  const remote = normalizeGroups(remoteRaw);
  const known = new Set(local.groups.map((g) => g.id));
  const fresh = remote.groups.filter((g) => g.id !== UNGROUPED_ID && !known.has(g.id));
  if (fresh.length === 0) return null;
  const taken = new Set<string>();
  const ordered = [...fresh]
    .reverse()
    .map((g) => {
      const items = uniqueKeys(g.items.filter((k) => !taken.has(k)));
      for (const key of items) taken.add(key);
      return { ...g, items };
    })
    .reverse();
  const keys = new Set(ordered.flatMap((g) => g.items));
  const groups = [
    ...local.groups
      .filter((g) => g.id !== UNGROUPED_ID)
      .map((g) => ({ ...g, items: g.items.filter((k) => !keys.has(k)) })),
    ...ordered,
  ];
  const ungrouped = local.ungrouped.filter((k) => !keys.has(k));
  if (!local.order) return { groups, ungrouped };
  const ids = new Set(groups.map((g) => g.id));
  const loose = new Set(ungrouped);
  const order = local.order.filter((k) => ids.has(k) || loose.has(k));
  for (const g of ordered) {
    if (!order.includes(g.id)) order.push(g.id);
  }
  return applyOrder(groups, order);
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

export function pruneLayout(layout: RailLayout, agents: AgentInfo[]): RailLayout {
  const valid = validKeys(agents);
  const groups = layout.groups
    .filter((g) => g.id !== UNGROUPED_ID)
    .map((g) => ({
      ...g,
      items: g.items.filter((k) => valid.has(k)),
    }));
  const ungrouped = layout.ungrouped.filter((k) => valid.has(k));
  if (!layout.order) return { groups, ungrouped };
  return applyOrder(groups, orderedSlots({ groups, ungrouped, order: layout.order }));
}

export function layoutChanged(a: RailLayout, b: RailLayout): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}

export function visibleUngroupedKeys(
  groups: Group[],
  ungrouped: string[],
  agents: AgentInfo[],
): string[] {
  const grouped = new Set(groups.flatMap((g) => g.items));
  const present: { key: string; name: string }[] = [];
  for (const a of agents) {
    const key = itemKey("agent", a.id);
    if (!grouped.has(key)) present.push({ key, name: a.name || a.id });
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

/**
 * Top-level keys as saved: folder ids and loose bot keys.
 * A missing folder or bot is appended, folders first when `order` is absent.
 */
export function orderedSlots(layout: RailLayout): string[] {
  const groupIds = layout.groups
    .filter((g) => g.id !== UNGROUPED_ID)
    .map((g) => g.id);
  const loose = layout.ungrouped.filter((k) => parseItemKey(k));
  const known = new Set<string>([...groupIds, ...loose]);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const key of layout.order ?? [...groupIds, ...loose]) {
    if (!known.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  for (const id of groupIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  for (const key of loose) {
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** The rail's top level, including loose bots that are not saved yet. */
export function railSlots(
  groups: Group[],
  ungrouped: string[],
  agents: AgentInfo[],
  order?: string[],
): string[] {
  return orderedSlots({
    groups,
    ungrouped: visibleUngroupedKeys(groups, ungrouped, agents),
    order,
  });
}

/**
 * Drop `order` when it is just folders then loose bots, so an old layout
 * still compares equal after a save.
 */
export function applyOrder(groups: Group[], order: string[]): RailLayout {
  const rank = new Map(order.map((key, i) => [key, i]));
  const nextGroups = groups
    .filter((g) => g.id !== UNGROUPED_ID)
    .slice()
    .sort((a, b) => (rank.get(a.id) ?? order.length) - (rank.get(b.id) ?? order.length));
  const loose = order.filter((key) => parseItemKey(key));
  const plain = [...nextGroups.map((g) => g.id), ...loose];
  const mixed =
    plain.length !== order.length || plain.some((key, i) => key !== order[i]);
  return mixed
    ? { groups: nextGroups, ungrouped: loose, order }
    : { groups: nextGroups, ungrouped: loose };
}

function insertAt(keys: string[], key: string, before: string | null): string[] {
  const rest = keys.filter((k) => k !== key);
  const at = before == null ? -1 : rest.indexOf(before);
  if (at < 0) rest.push(key);
  else rest.splice(at, 0, key);
  return rest;
}

/** Sidebar order for keyboard next/prev. Collapsed group children are skipped. */
export function railOrder(
  groups: Group[],
  ungrouped: string[],
  agents: AgentInfo[],
  order?: string[],
): { kind: Kind; id: string }[] {
  const valid = validKeys(agents);
  const byGroup = new Map(
    groups.filter((g) => g.id !== UNGROUPED_ID).map((g) => [g.id, g]),
  );
  const out: { kind: Kind; id: string }[] = [];
  const used = new Set<string>();
  for (const slot of railSlots(groups, ungrouped, agents, order)) {
    const group = byGroup.get(slot);
    if (group) {
      if (group.collapsed) continue;
      for (const key of group.items) {
        if (!valid.has(key) || used.has(key)) continue;
        used.add(key);
        const parsed = parseItemKey(key);
        if (parsed) out.push(parsed);
      }
      continue;
    }
    if (!valid.has(slot) || used.has(slot)) continue;
    used.add(slot);
    const parsed = parseItemKey(slot);
    if (parsed) out.push(parsed);
  }
  return out;
}

/** First bot a reopened window can land on.
 *  The sidebar's first visible row. A collapsed folder hides its bots, so
 *  they are not that row. When every folder is collapsed and nothing is
 *  loose, the first bot in folder order still opens a chat. */
export function firstOpenAgent(
  groups: Group[],
  ungrouped: string[],
  agents: AgentInfo[],
  order?: string[],
): string | null {
  const shown = railOrder(groups, ungrouped, agents, order)[0];
  if (shown) return shown.id;
  const valid = validKeys(agents);
  for (const g of groups) {
    if (g.id === UNGROUPED_ID) continue;
    for (const key of g.items) {
      if (!valid.has(key)) continue;
      const parsed = parseItemKey(key);
      if (parsed) return parsed.id;
    }
  }
  return null;
}

/** True when inserting `id` before `beforeId` (or at the end) would change `ids`. */
export function groupOrderChanges(
  ids: string[],
  id: string,
  beforeId: string | null,
): boolean {
  const from = ids.indexOf(id);
  if (from < 0) return false;
  const rest = ids.filter((key) => key !== id);
  const to = beforeId == null ? rest.length : rest.indexOf(beforeId);
  if (to < 0) return false;
  return to !== from;
}

/**
 * Move a folder before `beforeId`. That is another folder, a loose bot, or
 * null for the bottom of the whole list.
 */
export function moveGroup(
  layout: RailLayout,
  groupId: string,
  beforeId: string | null,
): RailLayout {
  const slots = orderedSlots(layout);
  if (!groupOrderChanges(slots, groupId, beforeId)) return layout;
  return applyOrder(
    layout.groups,
    insertAt(slots, groupId, beforeId),
  );
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
    const loose = uniqueKeys(ungroupedVisual.filter((k) => k !== key));
    const slots = orderedSlots({
      groups,
      ungrouped: loose,
      order: layout.order?.filter((k) => k !== key),
    });
    return applyOrder(groups, insertAt(slots, key, beforeKey ?? null));
  }
  const placed = groups.map((g) => {
    if (g.id !== destGroupId) return g;
    const items = [...g.items];
    const idx = beforeKey ? items.indexOf(beforeKey) : -1;
    if (idx < 0) items.push(key);
    else items.splice(idx, 0, key);
    return { ...g, items };
  });
  return applyOrder(
    placed,
    orderedSlots({
      groups: placed,
      ungrouped: uniqueKeys(ungroupedVisual.filter((k) => k !== key)),
      order: layout.order?.filter((k) => k !== key),
    }),
  );
}

export function validKeys(agents: AgentInfo[]): Set<string> {
  const keys = new Set<string>();
  for (const a of agents) keys.add(itemKey("agent", a.id));
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
