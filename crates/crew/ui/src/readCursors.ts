import { itemKey } from "./groups";
import type { AgentInfo, ChannelInfo, Kind } from "./types";

const KEY = "crew.read";

export type ReadMap = Record<string, number>;

export function loadRead(): ReadMap {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object") return {};
    const out: ReadMap = {};
    for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
      if (typeof n === "number" && Number.isFinite(n) && n >= 0) out[k] = n;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveRead(map: ReadMap) {
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* private mode / quota */
  }
}

export function markRead(map: ReadMap, kind: Kind, id: string, ts: number): ReadMap {
  if (!id || ts <= 0) return map;
  const key = itemKey(kind, id);
  if ((map[key] ?? 0) >= ts) return map;
  return { ...map, [key]: ts };
}

export function isUnread(
  map: ReadMap,
  kind: Kind,
  id: string,
  lastTs: number,
  selectedKind: Kind | null,
  selectedId: string | null,
): boolean {
  if (!lastTs) return false;
  if (kind === selectedKind && id === selectedId) return false;
  return lastTs > (map[itemKey(kind, id)] ?? 0);
}

export function unreadKeys(
  map: ReadMap,
  agents: AgentInfo[],
  channels: ChannelInfo[],
  selectedKind: Kind | null,
  selectedId: string | null,
): string[] {
  const out: string[] = [];
  for (const a of agents) {
    if (isUnread(map, "agent", a.id, a.last_ts || 0, selectedKind, selectedId)) {
      out.push(itemKey("agent", a.id));
    }
  }
  for (const c of channels) {
    if (isUnread(map, "channel", c.id, c.last_ts || 0, selectedKind, selectedId)) {
      out.push(itemKey("channel", c.id));
    }
  }
  return out;
}
