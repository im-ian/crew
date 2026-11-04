import {
  groupOrderChanges,
  parseItemKey,
  railSlots,
  UNGROUPED_ID,
  type RailLayout,
} from "./groups";
import type { AgentInfo, Kind, RemoteInfo } from "./types";

/** The port crew-router listens on unless its owner picked another. */
export const ROUTER_PORT = 7420;
/** Where a router comes from: install, run, and how to connect. */
export const ROUTER_REPO = "https://github.com/im-ian/crew-router";

const NAME_MAX = 32;
const ALIAS_MAX = 32;

/**
 * The router's address from the form. One typed with a scheme is taken as it
 * is, port and all; the switch and the port field only fill in a bare host.
 */
export function routerUrl(address: string, port: string, tls: boolean): string {
  const host = address.trim().replace(/\/+$/, "");
  if (!host) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) return host;
  const p = port.trim() || String(ROUTER_PORT);
  return `${tls ? "wss" : "ws"}://${host}:${p}`;
}

/** A port the form can send: blank (the default) or 1–65535. */
export function portOk(port: string): boolean {
  const p = port.trim();
  if (!p) return true;
  if (!/^\d+$/.test(p)) return false;
  const n = Number(p);
  return n >= 1 && n <= 65535;
}

export type NameError = "empty" | "long" | "bad";

/**
 * The router's own rule: 1–32 characters, each a letter in any script, a
 * digit, `-` or `_`. Checked here first so a typo does not cost a round trip.
 */
export function nameError(name: string): NameError | null {
  const n = name.trim();
  if (!n) return "empty";
  if ([...n].length > NAME_MAX) return "long";
  if (!/^[\p{L}\p{N}_-]+$/u.test(n)) return "bad";
  return null;
}

export type AliasError = "empty" | "long" | "bad" | "taken";

/**
 * An alias is the first half of `@alias/account`, so it keeps to the
 * characters a handle reads: ASCII letters, digits, `-` and `_`.
 */
export function aliasError(alias: string, taken: readonly string[]): AliasError | null {
  const a = alias.trim();
  if (!a) return "empty";
  if (a.length > ALIAS_MAX) return "long";
  if (!/^[A-Za-z0-9_-]+$/.test(a)) return "bad";
  const lower = a.toLowerCase();
  if (taken.some((t) => t.toLowerCase() === lower)) return "taken";
  return null;
}

/** The router's title as an alias. A title with no ASCII in it becomes `team`. */
export function slugAlias(title: string): string {
  const slug = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, ALIAS_MAX)
    .replace(/[-_]+$/, "");
  return slug || "team";
}

/** `base`, or `base-2`, `base-3`… when another router already has it. */
export function freeAlias(base: string, taken: readonly string[]): string {
  const names = new Set(taken.map((t) => t.toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const tail = `-${n}`;
    const next = base.slice(0, ALIAS_MAX - tail.length) + tail;
    if (!names.has(next.toLowerCase())) return next;
  }
}

export type JoinField = "name" | "invite" | null;

/**
 * Which field a refused sign-up belongs under. The daemon passes the router's
 * code or its own sentence; either way a taken name goes under the name.
 */
export function joinErrorField(message: string): JoinField {
  const m = message.toLowerCase();
  if (m.includes("name_taken") || m.includes("bad_name") || m.includes("이름")) {
    return "name";
  }
  if (m.includes("invite") || m.includes("초대")) return "invite";
  return null;
}

export function isRemote(agent: AgentInfo | null | undefined): boolean {
  return !!agent?.remote;
}

/** Bots on this PC. Remote ones have their own rail sections and no layout. */
export function localAgents(agents: AgentInfo[]): AgentInfo[] {
  return agents.some((a) => a.remote) ? agents.filter((a) => !a.remote) : agents;
}

/** `alias/name`, how a teammate's bot is told apart from a local one. */
export function remoteLabel(agent: AgentInfo): string {
  return agent.remote ? `${agent.remote}/${agent.name || agent.id}` : agent.name || agent.id;
}

/** False only for a remote bot whose PC is away. A local bot is always here. */
export function isOnline(agent: AgentInfo | null | undefined): boolean {
  return !agent?.remote || agent.remote_online !== false;
}

export type RemoteSection = {
  alias: string;
  /** Null when only the bot list knows the alias. */
  remote: RemoteInfo | null;
  bots: AgentInfo[];
};

/** Where this PC put its routers and their bots, kept next to the router folds. */
export type RemoteLayout = {
  /** The rail's sections top to bottom: folder ids, the loose bots, `remote:alias`. */
  sections: string[];
  /** Bot ids per router alias, top to bottom. */
  bots: Record<string, string[]>;
};

/**
 * One rail section per router, in the order the daemon lists them. Bots go
 * in the order this PC saved, then by name. An alias that only the bot list
 * has (the router list failed, or is a poll behind) still gets its section.
 * This PC's representative sits in its own router's section once it was put
 * there, which is its id in that router's saved order.
 */
export function remoteSections(
  agents: AgentInfo[],
  remotes: RemoteInfo[],
  locale = "ko",
  saved: RemoteLayout["bots"] = {},
): RemoteSection[] {
  const byAlias = new Map<string, AgentInfo[]>();
  for (const a of agents) {
    if (!a.remote) continue;
    const list = byAlias.get(a.remote);
    if (list) list.push(a);
    else byAlias.set(a.remote, [a]);
  }
  const out: RemoteSection[] = remotes.map((r) => {
    const rep = (saved[r.alias] ?? []).includes(r.bot)
      ? agents.find((a) => a.id === r.bot && !a.remote)
      : undefined;
    const bots = byAlias.get(r.alias) ?? [];
    return { alias: r.alias, remote: r, bots: rep ? [rep, ...bots] : bots };
  });
  const listed = new Set(remotes.map((r) => r.alias));
  for (const alias of byAlias.keys()) {
    if (!listed.has(alias)) out.push({ alias, remote: null, bots: byAlias.get(alias) ?? [] });
  }
  for (const section of out) {
    const rank = new Map((saved[section.alias] ?? []).map((id, i) => [id, i]));
    section.bots = [...section.bots].sort((a, b) => {
      const ra = rank.get(a.id);
      const rb = rank.get(b.id);
      if (ra !== undefined || rb !== undefined) {
        return (ra ?? Infinity) - (rb ?? Infinity);
      }
      return (a.name || a.id).localeCompare(b.name || b.id, locale);
    });
  }
  return out;
}

/** A router's key among the rail's sections, next to folder ids. */
export function remoteKey(alias: string): string {
  return `remote:${alias}`;
}

export function isRemoteKey(key: string): boolean {
  return key.startsWith("remote:");
}

/**
 * The rail's sections top to bottom. `local` is already folders and loose
 * bots in the order they show. A router goes back before the section it was
 * saved above. One this PC has not placed goes after the last loose bot.
 * An old save still says `__ungrouped` for the whole loose block: that anchor
 * is the first loose bot.
 */
export function railSections(
  local: readonly string[],
  aliases: string[],
  saved: readonly string[],
): string[] {
  const firstLoose =
    local.find((key) => key === UNGROUPED_ID || !!parseItemKey(key)) ?? null;
  const keys = firstLoose ? [...local] : [...local, UNGROUPED_ID];
  const isLocal = new Set(keys);
  const resolve = (key: string): string | null => {
    if (isLocal.has(key)) return key;
    if (key === UNGROUPED_ID && firstLoose && firstLoose !== UNGROUPED_ID) {
      return firstLoose;
    }
    return null;
  };
  const routers = new Set(aliases.map(remoteKey));
  const above = new Map<string, string[]>();
  const placed = new Set<string>();
  let pending: string[] = [];
  for (const key of saved) {
    if (routers.has(key) && !placed.has(key)) {
      placed.add(key);
      pending.push(key);
      continue;
    }
    const anchor = resolve(key);
    if (anchor && pending.length) {
      above.set(anchor, [...(above.get(anchor) ?? []), ...pending]);
      pending = [];
    }
  }
  return [
    ...keys.flatMap((key) => [...(above.get(key) ?? []), key]),
    ...pending,
    ...aliases.map(remoteKey).filter((key) => !placed.has(key)),
  ];
}

/** `key` taken out of `keys` and put back before `beforeKey`, or at the end. */
export function moved(keys: readonly string[], key: string, beforeKey: string | null): string[] {
  if (!groupOrderChanges([...keys], key, beforeKey)) return [...keys];
  const rest = keys.filter((k) => k !== key);
  rest.splice(beforeKey == null ? rest.length : rest.indexOf(beforeKey), 0, key);
  return rest;
}

/**
 * The next folder or loose bot after `key` in `keys`, or null at the bottom.
 * A router between them is skipped: it is not part of the folder layout.
 */
export function localBefore(
  keys: readonly string[],
  key: string,
  local: ReadonlySet<string>,
): string | null {
  const at = keys.indexOf(key);
  if (at < 0) return null;
  return keys.slice(at + 1).find((k) => local.has(k)) ?? null;
}

/**
 * Where a folder lands in the layout once the rail's sections are in `keys`:
 * before the next folder below it, or last.
 */
export function folderBefore(
  keys: readonly string[],
  groupId: string,
  groupIds: string[],
): string | null {
  return localBefore(keys, groupId, new Set(groupIds));
}

/** Saved bot orders for routers and bots still here. */
function keptBots(saved: RemoteLayout["bots"], sections: RemoteSection[]): RemoteLayout["bots"] {
  const out: RemoteLayout["bots"] = {};
  for (const s of sections) {
    const here = new Set(s.bots.map((b) => b.id));
    const ids = (saved[s.alias] ?? []).filter((id) => here.has(id));
    if (ids.length) out[s.alias] = ids;
  }
  return out;
}

/** The saved layout after a folder or router moved among the rail's sections. */
export function moveRailSection(
  saved: RemoteLayout,
  keys: readonly string[],
  sections: RemoteSection[],
  key: string,
  beforeKey: string | null,
): RemoteLayout {
  return { sections: moved(keys, key, beforeKey), bots: keptBots(saved.bots, sections) };
}

/** The saved layout after a router's bot moved within its router. */
export function moveRemoteBot(
  saved: RemoteLayout,
  sections: RemoteSection[],
  alias: string,
  id: string,
  beforeId: string | null,
): RemoteLayout {
  const bots = keptBots(saved.bots, sections);
  const ids = sections.find((s) => s.alias === alias)?.bots.map((b) => b.id) ?? [];
  if (ids.includes(id)) bots[alias] = moved(ids, id, beforeId);
  return { sections: saved.sections, bots };
}

/** Bots on this PC that sit in a router's section instead of the local list. */
export function placedReps(sections: RemoteSection[]): Set<string> {
  return new Set(sections.flatMap((s) => s.bots.filter((b) => !b.remote).map((b) => b.id)));
}

/**
 * The saved layout after this PC's representative `id` was put in `alias`'s
 * section before `beforeId`, or last. It leaves any other router it was in.
 */
export function placeRep(
  saved: RemoteLayout,
  sections: RemoteSection[],
  alias: string,
  id: string,
  beforeId: string | null,
): RemoteLayout {
  const bots = unplaceRep(saved, sections, id).bots;
  const ids = (sections.find((s) => s.alias === alias)?.bots ?? [])
    .map((b) => b.id)
    .filter((b) => b !== id);
  ids.splice(beforeId && ids.includes(beforeId) ? ids.indexOf(beforeId) : ids.length, 0, id);
  bots[alias] = ids;
  return { sections: saved.sections, bots };
}

/** The saved layout after this PC's representative `id` went back to the local list. */
export function unplaceRep(
  saved: RemoteLayout,
  sections: RemoteSection[],
  id: string,
): RemoteLayout {
  const bots = keptBots(saved.bots, sections);
  for (const [alias, ids] of Object.entries(bots)) {
    const rest = ids.filter((b) => b !== id);
    if (rest.length) bots[alias] = rest;
    else delete bots[alias];
  }
  return { sections: saved.sections, bots };
}

/**
 * Rows for ⌘[ and ⌘], top to bottom as the rail stacks folders, loose bots
 * and routers. A collapsed folder or a folded router is skipped.
 */
export function chatOrder(
  rail: RailLayout,
  agents: AgentInfo[],
  remotes: RemoteInfo[],
  folded: readonly string[],
  saved: RemoteLayout,
): { kind: Kind; id: string }[] {
  const sections = remoteSections(agents, remotes, undefined, saved.bots);
  // A representative put in its router's section is stepped through there.
  const placed = placedReps(sections);
  const local = localAgents(agents).filter((a) => !placed.has(a.id));
  const slots = railSlots(rail.groups, rail.ungrouped, local, rail.order);
  const rows = new Map<string, { kind: Kind; id: string }[]>();
  const byGroup = new Map(rail.groups.map((g) => [g.id, g]));
  const here = new Set(local.map((a) => a.id));
  for (const slot of slots) {
    const group = byGroup.get(slot);
    if (!group) {
      const parsed = parseItemKey(slot);
      if (parsed && here.has(parsed.id)) rows.set(slot, [parsed]);
      continue;
    }
    if (group.collapsed) {
      rows.set(slot, []);
      continue;
    }
    const bots: { kind: Kind; id: string }[] = [];
    for (const key of group.items) {
      const parsed = parseItemKey(key);
      if (parsed && here.has(parsed.id)) bots.push(parsed);
    }
    rows.set(slot, bots);
  }
  for (const s of sections) {
    if (folded.includes(s.alias)) continue;
    rows.set(
      remoteKey(s.alias),
      s.bots.map((b) => ({ kind: "agent" as const, id: b.id })),
    );
  }
  return railSections(
    slots,
    sections.map((s) => s.alias),
    saved.sections,
  ).flatMap((key) => rows.get(key) ?? []);
}

/** Aliases of the routers this local bot stands in for. */
export function representing(id: string, remotes: RemoteInfo[]): string[] {
  return remotes.filter((r) => r.bot === id).map((r) => r.alias);
}

/** Adds `id` when it is missing, takes it out when it is there. */
export function toggled(list: readonly string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

/** The router list as the daemon sent it, or nothing for an answer that is not one. */
export function normalizeRemotes(raw: unknown): RemoteInfo[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (r): r is RemoteInfo =>
      !!r && typeof r === "object" && typeof (r as RemoteInfo).alias === "string",
  );
}

const FOLD_KEY = "crew.remote-folded";

export function loadRemoteFolds(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(FOLD_KEY) || "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function saveRemoteFolds(aliases: string[]) {
  try {
    localStorage.setItem(FOLD_KEY, JSON.stringify(aliases));
  } catch {
    /* private mode */
  }
}

const ORDER_KEY = "crew.remote-order";

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Where this PC put its routers and their bots, or nothing for a value that is not that. */
export function normalizeRemoteLayout(raw: unknown): RemoteLayout {
  if (!raw || typeof raw !== "object") return { sections: [], bots: {} };
  const r = raw as Partial<Record<keyof RemoteLayout, unknown>>;
  const bots: RemoteLayout["bots"] = {};
  if (r.bots && typeof r.bots === "object" && !Array.isArray(r.bots)) {
    for (const [alias, ids] of Object.entries(r.bots)) bots[alias] = strings(ids);
  }
  return { sections: strings(r.sections), bots };
}

export function loadRemoteLayout(): RemoteLayout {
  try {
    return normalizeRemoteLayout(JSON.parse(localStorage.getItem(ORDER_KEY) || "{}"));
  } catch {
    return { sections: [], bots: {} };
  }
}

export function saveRemoteLayout(layout: RemoteLayout) {
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(layout));
  } catch {
    /* private mode */
  }
}
