import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import { useLocale, useT } from "../LocaleContext";
import { groupOrderChanges, itemKey, parseItemKey, UNGROUPED_ID } from "../groups";
import type { AgentInfo, Group, Kind, RemoteInfo, SearchHit } from "../types";
import { listStamp } from "../clock";
import { mentionRuns, mentionText } from "../mentions";
import { foldsAt, numberDuplicateNames, RAIL_FOLDED } from "../rail";
import {
  folderBefore,
  isOnline,
  isRemoteKey,
  loadRemoteFolds,
  loadRemoteLayout,
  localAgents,
  moveRailSection,
  moveRemoteBot,
  railSections,
  remoteKey,
  remoteSections,
  representing,
  saveRemoteFolds,
  saveRemoteLayout,
  type RemoteLayout,
  type RemoteSection,
} from "../remote";
import { Avatar } from "./Avatar";
import { MentionChip } from "./MentionChip";
import { BotLabelProvider } from "../BotLabelContext";
import { botSearchText } from "../botLabel";
import { PlanUsageButton } from "./PlanUsageBar";
import { ChevronDown, Ellipsis, Plus, Search, Settings } from "../icons";

const RAIL_DEFAULT = 232;
const RAIL_MIN = 176;
const RAIL_MAX = 480;
const RAIL_KEY = "crew.rail-w";
const FOLD_KEY = "crew.rail-folded";

function clampRail(px: number, vw = window.innerWidth): number {
  const max = Math.max(RAIL_MIN, Math.min(RAIL_MAX, Math.floor(vw * 0.5)));
  return Math.min(max, Math.max(RAIL_MIN, Math.round(px)));
}

function loadRail(): number {
  try {
    const raw = localStorage.getItem(RAIL_KEY);
    if (!raw) return RAIL_DEFAULT;
    const n = Number(raw);
    if (!Number.isFinite(n)) return RAIL_DEFAULT;
    return Math.min(RAIL_MAX, Math.max(RAIL_MIN, Math.round(n)));
  } catch {
    return RAIL_DEFAULT;
  }
}

function saveRail(px: number) {
  try {
    localStorage.setItem(RAIL_KEY, String(px));
  } catch {
    /* private mode / quota */
  }
}

function loadFolded(): boolean {
  try {
    return localStorage.getItem(FOLD_KEY) === "on";
  } catch {
    return false;
  }
}

function saveFolded(on: boolean) {
  try {
    localStorage.setItem(FOLD_KEY, on ? "on" : "off");
  } catch {
    /* private mode / quota */
  }
}

function applyRail(px: number) {
  document.documentElement.style.setProperty("--rail-w", `${px}px`);
}

type RailItem = {
  key: string;
  kind: Kind;
  id: string;
  name: string;
  preview?: string | null;
  /** Set only when another item shares this name. */
  ordinal?: number;
  agent?: AgentInfo;
};

type DropLine = { left: number; top: number; width: number };

type RailDrop =
  | {
      kind: "item";
      groupId: string | null;
      beforeKey: string | null;
      into: boolean;
      line: DropLine | null;
    }
  | {
      kind: "group";
      beforeId: string | null;
      line: DropLine | null;
    };

type DragGeom = {
  x: number;
  y: number;
  grabX: number;
  grabY: number;
  width: number;
  armed: boolean;
};

/** A "group" drag moves a rail section: a folder by its id, a router by `remote:alias`. */
type RailDrag = DragGeom &
  (
    | { kind: "item"; key: string; item: RailItem }
    | { kind: "group"; key: string; groupName: string; collapsed: boolean }
  );

const DRAG_THRESHOLD = 6;

function lineAt(rect: DOMRect, before: boolean, inset: number) {
  return {
    left: Math.round(rect.left + inset),
    width: Math.max(32, Math.round(rect.width - inset - 8)),
    top: Math.round(before ? rect.top : rect.bottom),
  };
}

function nextRailRow(row: HTMLElement): HTMLElement | null {
  let n = row.nextElementSibling;
  while (n) {
    if (n instanceof HTMLElement && n.hasAttribute("data-rail-row")) return n;
    n = n.nextElementSibling;
  }
  return null;
}

function pickClosest(stack: Element[], sel: string): HTMLElement | null {
  for (const node of stack) {
    const hit = node.closest(sel);
    if (hit instanceof HTMLElement) return hit;
  }
  return null;
}

function rowDrop(row: HTMLElement, y: number, dragKey: string, groupId: string | null): RailDrop {
  const key = row.dataset.railRow || null;
  const rect = row.getBoundingClientRect();
  const inset = 8;
  const before = y < rect.top + rect.height * 0.5;
  if (before) {
    return {
      kind: "item",
      groupId,
      beforeKey: key,
      into: false,
      line: lineAt(rect, true, inset),
    };
  }
  const next = nextRailRow(row);
  let insertBefore = next?.dataset.railRow || null;
  if (insertBefore === dragKey && next) {
    insertBefore = nextRailRow(next)?.dataset.railRow || null;
  }
  return {
    kind: "item",
    groupId,
    beforeKey: insertBefore,
    into: false,
    line: lineAt(rect, false, inset),
  };
}

function hitRailTarget(x: number, y: number, dragKey: string): RailDrop | null {
  const stack = document.elementsFromPoint(x, y);
  const row = pickClosest(stack, "[data-rail-row]");
  if (row) {
    // A router's rows are the router's; a bot on this PC does not go there.
    if (row.closest("[data-rail-remote]")) return null;
    const groupEl = row.closest("[data-rail-group]");
    const groupId =
      groupEl instanceof HTMLElement ? groupEl.dataset.railGroup || null : null;
    return rowDrop(row, y, dragKey, groupId);
  }

  const head = pickClosest(stack, "[data-rail-group-head]");
  if (head) {
    return {
      kind: "item",
      groupId: head.dataset.railGroupHead || null,
      beforeKey: null,
      into: true,
      line: null,
    };
  }

  const empty = pickClosest(stack, "[data-rail-empty]");
  if (empty) {
    const groupEl = empty.closest("[data-rail-group]");
    const groupId =
      groupEl instanceof HTMLElement ? groupEl.dataset.railGroup || null : null;
    return { kind: "item", groupId, beforeKey: null, into: true, line: null };
  }

  const group = pickClosest(stack, "[data-rail-group]");
  if (group) {
    return {
      kind: "item",
      groupId: group.dataset.railGroup || null,
      beforeKey: null,
      into: true,
      line: null,
    };
  }

  const ungrouped = pickClosest(stack, "[data-rail-ungrouped]");
  if (ungrouped) {
    return { kind: "item", groupId: null, beforeKey: null, into: true, line: null };
  }

  return null;
}

/** A router's bot moves among that router's bots and nowhere else. */
function hitRemoteRow(x: number, y: number, dragKey: string, alias: string): RailDrop | null {
  const row = pickClosest(document.elementsFromPoint(x, y), "[data-rail-row]");
  const section = row?.closest<HTMLElement>("[data-rail-remote]");
  if (!row || section?.dataset.railRemote !== alias) return null;
  return rowDrop(row, y, dragKey, null);
}

/**
 * Section reorder: folders and routers move among each other. A folder stays
 * above the loose bots; a router can also go below them.
 */
function hitGroupTarget(y: number, dragId: string, order: string[]): RailDrop {
  const folder = !isRemoteKey(dragId);
  const sections = [...document.querySelectorAll<HTMLElement>("[data-rail-section]")].filter(
    (el) => el.dataset.railSection && el.dataset.railSection !== dragId,
  );
  let beforeId: string | null = null;
  let anchor: HTMLElement | null = null;
  let before = true;
  for (const section of sections) {
    const key = section.dataset.railSection || null;
    const head = section.querySelector<HTMLElement>(
      "[data-rail-group-head], [data-rail-remote-head]",
    );
    const headRect = (head ?? section).getBoundingClientRect();
    if ((folder && key === UNGROUPED_ID) || y < headRect.top + headRect.height * 0.5) {
      beforeId = key;
      anchor = section;
      break;
    }
  }
  if (!anchor) {
    const all = document.querySelectorAll<HTMLElement>("[data-rail-section]");
    anchor = all[all.length - 1] ?? null;
    before = false;
  }
  const changes = groupOrderChanges(order, dragId, beforeId);
  return {
    kind: "group",
    beforeId,
    line: changes && anchor ? lineAt(anchor.getBoundingClientRect(), before, 8) : null,
  };
}

function autoScrollLists(y: number) {
  const lists = document.querySelector(".rail-lists");
  if (!(lists instanceof HTMLElement)) return;
  const r = lists.getBoundingClientRect();
  const edge = 36;
  if (y < r.top + edge) {
    lists.scrollTop -= Math.max(6, (r.top + edge - y) * 0.4);
  } else if (y > r.bottom - edge) {
    lists.scrollTop += Math.max(6, (y - (r.bottom - edge)) * 0.4);
  }
}

type Props = {
  agents: AgentInfo[];
  /** Routers this PC is on. Their bots come from `agents`, by `remote`. */
  remotes?: RemoteInfo[];
  groups: Group[];
  ungrouped: string[];
  selected: string | null;
  selectedKind: Kind;
  query: string;
  searchHits?: SearchHit[];
  renamingId: string | null;
  onQuery: (q: string) => void;
  onSearchHit?: (hit: SearchHit) => void;
  onSelectAgent: (id: string) => void;
  onCreateMenu: (e: MouseEvent) => void;
  onAgentCtx: (e: MouseEvent, id: string) => void;
  onGroupCtx: (e: MouseEvent, id: string) => void;
  onGroupMenu: (e: MouseEvent, id: string) => void;
  onGroupNewBot: (id: string) => void;
  onToggleGroup: (id: string) => void;
  onRenameGroup: (id: string, name: string) => void;
  onRenameDone: () => void;
  onMove: (kind: Kind, id: string, groupId: string | null, beforeKey?: string | null) => void;
  onReorderGroup: (id: string, beforeId: string | null) => void;
  unread?: string[];
  /** Agent ids whose composer still holds unsent text. */
  drafting?: string[];
  searchRef?: Ref<HTMLInputElement>;
  onOpenSettings?: () => void;
};

function matches(parts: Array<string | null | undefined>, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return parts.filter(Boolean).join(" ").toLowerCase().includes(q);
}

function toItems(agents: AgentInfo[]): RailItem[] {
  const items: RailItem[] = [];
  for (const a of agents) {
    items.push({
      key: itemKey("agent", a.id),
      kind: "agent",
      id: a.id,
      name: a.name || a.id,
      preview: a.preview,
      agent: a,
    });
  }
  numberDuplicateNames(items);
  return items;
}

function orderItems(items: RailItem[], order: string[], locale: string): RailItem[] {
  const byKey = new Map(items.map((item) => [item.key, item]));
  const out: RailItem[] = [];
  const seen = new Set<string>();
  for (const key of order) {
    const item = byKey.get(key);
    if (!item || seen.has(key)) continue;
    out.push(item);
    seen.add(key);
  }
  const rest = items.filter((item) => !seen.has(item.key));
  rest.sort((a, b) => a.name.localeCompare(b.name, locale));
  return out.concat(rest);
}

export function Sidebar({
  agents,
  remotes = [],
  groups,
  ungrouped,
  selected,
  selectedKind,
  query,
  searchHits = [],
  renamingId,
  onQuery,
  onSearchHit,
  onSelectAgent,
  onCreateMenu,
  onAgentCtx,
  onGroupCtx,
  onGroupMenu,
  onGroupNewBot,
  onToggleGroup,
  onRenameGroup,
  onRenameDone,
  onMove,
  onReorderGroup,
  unread = [],
  drafting = [],
  searchRef,
  onOpenSettings,
}: Props) {
  const t = useT();
  const { locale } = useLocale();
  // Rebuilding the list numbers every duplicate name and re-sorts each group;
  // a drag re-renders this on every pointermove and none of it can change.
  const built = useMemo(() => toItems(localAgents(agents)), [agents]);
  // Where routers and their bots sit is this PC's, so it is kept here.
  const [remoteLayout, setRemoteLayout] = useState(loadRemoteLayout);
  const sections = useMemo(
    () => remoteSections(agents, remotes, locale, remoteLayout.bots),
    [agents, remotes, locale, remoteLayout.bots],
  );
  const railKeys = useMemo(
    () =>
      railSections(
        groups.map((g) => g.id),
        sections.map((s) => s.alias),
        remoteLayout.sections,
      ),
    [groups, sections, remoteLayout.sections],
  );
  const hit = (item: RailItem) =>
    matches(
      [
        item.agent ? botSearchText(item.agent, groups) : null,
        item.agent?.title,
        item.agent?.role,
        item.agent?.remote,
        // The row shows resolved names, so the query has to see them too.
        mentionText(item.preview || "", agents),
      ],
      query,
    );
  const all = built.filter(hit);
  const byKey = new Map(all.map((item) => [item.key, item]));
  const used = new Set<string>();
  const grouped = groups.map((group) => {
    const items: RailItem[] = [];
    for (const key of group.items) {
      const item = byKey.get(key);
      if (!item) continue;
      items.push(item);
      used.add(key);
    }
    return { group, items };
  });
  const ungroupedItems = orderItems(
    all.filter((item) => !used.has(item.key)),
    ungrouped,
    locale,
  );
  const searching = !!query.trim();
  const remoteShown = sections
    .map((section) => ({ section, items: toItems(section.bots).filter(hit) }))
    .filter(({ items }) => !searching || items.length);
  const empty = !all.length && !remoteShown.length;
  const [remoteFolds, setRemoteFolds] = useState(loadRemoteFolds);
  const groupByKey = new Map(grouped.map((g) => [g.group.id, g]));
  const remoteByKey = new Map(remoteShown.map((r) => [remoteKey(r.section.alias), r]));
  // The sections on screen, top to bottom, for telling whether a drop moves one.
  const shownKeys = railKeys.filter((key) =>
    key === UNGROUPED_ID
      ? ungroupedItems.length > 0
      : groupByKey.has(key) || remoteByKey.has(key),
  );

  function keepRemoteLayout(next: RemoteLayout) {
    setRemoteLayout(next);
    saveRemoteLayout(next);
  }

  // A folder's place among folders is the layout's; next to a router it is this PC's.
  function reorderSection(key: string, beforeKey: string | null) {
    const next = moveRailSection(remoteLayout, railKeys, sections, key, beforeKey);
    if (!isRemoteKey(key)) {
      onReorderGroupRef.current(key, folderBefore(next.sections, key, groups.map((g) => g.id)));
    }
    if (sections.length) keepRemoteLayout(next);
  }

  function toggleRemote(alias: string) {
    setRemoteFolds((prev) => {
      const next = prev.includes(alias) ? prev.filter((a) => a !== alias) : [...prev, alias];
      saveRemoteFolds(next);
      return next;
    });
  }

  // Folding keeps the open width, so opening the rail again lands where it was.
  const [folded, setFoldedState] = useState(loadFolded);
  const [preferredRail, setPreferredRail] = useState(loadRail);
  const [viewW, setViewW] = useState(() => window.innerWidth);
  const railW = clampRail(preferredRail, viewW);
  const shownW = folded ? RAIL_FOLDED : railW;
  const dragRail = useRef<{
    startX: number;
    startW: number;
    /** The open width before the drag, kept if the drag ends folded. */
    startPref: number;
    startFolded: boolean;
  } | null>(null);
  const foldedRef = useRef(folded);
  foldedRef.current = folded;

  useLayoutEffect(() => {
    applyRail(shownW);
  }, [shownW]);

  function setFolded(on: boolean, persist: boolean) {
    setFoldedState(on);
    if (persist) saveFolded(on);
    // The folded rail has no field to show a filter in, so it lists every bot.
    if (on && query) onQuery("");
  }

  // A group name being edited needs the open rail to be readable.
  useEffect(() => {
    if (folded && renamingId && groups.some((g) => g.id === renamingId)) {
      setFolded(false, true);
    }
  }, [folded, renamingId, groups]);

  useEffect(() => {
    function onWin() {
      setViewW(window.innerWidth);
    }
    window.addEventListener("resize", onWin);
    return () => window.removeEventListener("resize", onWin);
  }, []);

  function setRail(next: number, persist: boolean) {
    const stored = clampRail(next);
    setPreferredRail(stored);
    setFolded(false, persist);
    if (persist) saveRail(stored);
  }

  function onRailPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRail.current = {
      startX: e.clientX,
      startW: shownW,
      startPref: preferredRail,
      startFolded: folded,
    };
    document.documentElement.classList.add("rail-resizing");
  }

  function onRailPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRail.current;
    if (!drag) return;
    const next = drag.startW + (e.clientX - drag.startX);
    if (foldsAt(next)) setFolded(true, false);
    else setRail(next, false);
  }

  function onRailPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRail.current;
    if (!drag) return;
    dragRail.current = null;
    document.documentElement.classList.remove("rail-resizing");
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    // Passing the floor on the way to folding clamped the width to it; an
    // open rail that ends folded opens again at the width it had.
    const keep = foldedRef.current && !drag.startFolded;
    setPreferredRail((w) => {
      const next = keep ? drag.startPref : w;
      saveRail(next);
      return next;
    });
    saveFolded(foldedRef.current);
  }

  function onRailKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    const step = e.shiftKey ? 32 : 16;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (folded) return;
      if (railW <= RAIL_MIN) setFolded(true, true);
      else setRail(preferredRail - step, true);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      if (folded) setFolded(false, true);
      else setRail(preferredRail + step, true);
    } else if (e.key === "Home") {
      e.preventDefault();
      setRail(RAIL_MIN, true);
    } else if (e.key === "End") {
      e.preventDefault();
      setRail(RAIL_MAX, true);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setRail(RAIL_DEFAULT, true);
    }
  }

  const [drag, setDrag] = useState<RailDrag | null>(null);
  const [drop, setDrop] = useState<RailDrop | null>(null);
  // A bot on this PC being dragged, which can land among the loose bots.
  const localDrag = drag?.kind === "item" && drag.armed && !drag.item.agent?.remote;
  const dragRef = useRef<RailDrag | null>(null);
  const dropRef = useRef<RailDrop | null>(null);
  const didDrag = useRef(false);
  const stopListen = useRef<(() => void) | null>(null);
  const expandTimer = useRef<number | null>(null);
  const expandFor = useRef<string | null>(null);
  const onMoveRef = useRef(onMove);
  const onReorderGroupRef = useRef(onReorderGroup);
  const onToggleGroupRef = useRef(onToggleGroup);
  onMoveRef.current = onMove;
  onReorderGroupRef.current = onReorderGroup;
  onToggleGroupRef.current = onToggleGroup;

  useEffect(() => {
    return () => {
      stopListen.current?.();
      if (expandTimer.current) window.clearTimeout(expandTimer.current);
      document.documentElement.classList.remove("rail-dragging");
    };
  }, []);

  function select(item: RailItem) {
    onSelectAgent(item.id);
  }

  function ctx(e: MouseEvent, item: RailItem) {
    onAgentCtx(e, item.id);
  }

  function clearExpandTimer() {
    if (expandTimer.current) {
      window.clearTimeout(expandTimer.current);
      expandTimer.current = null;
    }
    expandFor.current = null;
  }

  function queueExpand(groupId: string | null, into: boolean) {
    if (!into || !groupId) {
      clearExpandTimer();
      return;
    }
    if (expandFor.current === groupId) return;
    clearExpandTimer();
    expandFor.current = groupId;
    expandTimer.current = window.setTimeout(() => {
      const collapsed = document.querySelector(
        `[data-rail-group="${groupId}"] .group-head.collapsed`,
      );
      if (collapsed) onToggleGroupRef.current(groupId);
    }, 450);
  }

  function endDrag(apply: boolean) {
    const d = dragRef.current;
    const t = dropRef.current;
    clearExpandTimer();
    stopListen.current?.();
    stopListen.current = null;
    document.documentElement.classList.remove("rail-dragging");
    dragRef.current = null;
    dropRef.current = null;
    setDrag(null);
    setDrop(null);
    if (!apply) didDrag.current = false;
    if (!apply || !d || !t) return;
    if (d.kind === "group") {
      if (t.kind !== "group") return;
      reorderSection(d.key, t.beforeId);
      return;
    }
    if (t.kind !== "item" || t.beforeKey === d.key) return;
    const parsed = parseItemKey(d.key);
    if (!parsed) return;
    const alias = d.item.agent?.remote;
    if (alias) {
      const beforeId = t.beforeKey ? (parseItemKey(t.beforeKey)?.id ?? null) : null;
      keepRemoteLayout(moveRemoteBot(remoteLayout, sections, alias, parsed.id, beforeId));
      return;
    }
    onMoveRef.current(parsed.kind, parsed.id, t.groupId, t.beforeKey);
    if (t.into && t.groupId) {
      const collapsed = document.querySelector(
        `[data-rail-group="${t.groupId}"] .group-head.collapsed`,
      );
      if (collapsed) onToggleGroupRef.current(t.groupId);
    }
  }

  function beginDrag(
    e: ReactPointerEvent<HTMLElement>,
    pending: RailDrag,
    locate: (x: number, y: number) => RailDrop | null,
  ) {
    if (e.button !== 0 || searching) return;
    // A press on the label hits the text node, which has no closest().
    const hit = e.target instanceof Element ? e.target : e.currentTarget;
    if (hit.closest("input, textarea, a")) return;
    const rowEl = e.currentTarget;
    const originX = e.clientX;
    const originY = e.clientY;
    dragRef.current = pending;
    didDrag.current = false;

    const onMovePtr = (ev: PointerEvent) => {
      const cur = dragRef.current;
      if (!cur || ev.pointerId !== e.pointerId) return;
      const dx = ev.clientX - originX;
      const dy = ev.clientY - originY;
      if (!cur.armed) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        cur.armed = true;
        didDrag.current = true;
        document.documentElement.classList.add("rail-dragging");
        try {
          rowEl.setPointerCapture(e.pointerId);
        } catch {
          /* already released */
        }
      }
      ev.preventDefault();
      const next: RailDrag = {
        ...cur,
        x: ev.clientX,
        y: ev.clientY,
        armed: true,
      };
      dragRef.current = next;
      setDrag(next);
      autoScrollLists(ev.clientY);
      const target = locate(ev.clientX, ev.clientY);
      dropRef.current = target;
      setDrop(target);
      if (cur.kind === "item" && target?.kind === "item") {
        queueExpand(target.groupId, target.into);
      } else {
        clearExpandTimer();
      }
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      const armed = !!dragRef.current?.armed;
      endDrag(armed);
      if (armed) window.setTimeout(() => {
        didDrag.current = false;
      }, 0);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        endDrag(false);
      }
    };
    window.addEventListener("pointermove", onMovePtr);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("keydown", onKey);
    stopListen.current = () => {
      window.removeEventListener("pointermove", onMovePtr);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("keydown", onKey);
    };
  }

  function onRowPointerDown(e: ReactPointerEvent<HTMLButtonElement>, item: RailItem) {
    const rect = e.currentTarget.getBoundingClientRect();
    const alias = item.agent?.remote;
    beginDrag(
      e,
      {
        kind: "item",
        key: item.key,
        item,
        x: e.clientX,
        y: e.clientY,
        grabX: e.clientX - rect.left,
        grabY: e.clientY - rect.top,
        width: rect.width,
        armed: false,
      },
      (x, y) => (alias ? hitRemoteRow(x, y, item.key, alias) : hitRailTarget(x, y, item.key)),
    );
  }

  function onGroupPointerDown(
    e: ReactPointerEvent<HTMLDivElement>,
    key: string,
    name: string,
    collapsed: boolean,
  ) {
    const rect = e.currentTarget.getBoundingClientRect();
    const order = shownKeys;
    beginDrag(
      e,
      {
        kind: "group",
        key,
        groupName: name,
        collapsed,
        x: e.clientX,
        y: e.clientY,
        grabX: e.clientX - rect.left,
        grabY: e.clientY - rect.top,
        width: rect.width,
        armed: false,
      },
      (_x, y) => hitGroupTarget(y, key, order),
    );
  }

  function renderFolder({ group, items }: { group: Group; items: RailItem[] }) {
    if (searching && !items.length) return null;
    const hidden = !searching && group.collapsed;
    const showEmpty = !hidden && !items.length && !searching;
    return (
      <section
        key={group.id}
        className={
          "rail-section grouped" +
          (drop?.kind === "item" && drop.groupId === group.id && drop.into
            ? " drop-into"
            : "") +
          (drag?.kind === "group" && drag.key === group.id && drag.armed
            ? " dragging"
            : "")
        }
        data-rail-group={group.id}
        data-rail-section={group.id}
      >
        <GroupHead
          group={group}
          compact={folded}
          renaming={renamingId === group.id}
          searching={searching}
          dropInto={
            drop?.kind === "item" && drop.groupId === group.id && drop.into
          }
          onToggle={() => {
            if (didDrag.current) return;
            onToggleGroup(group.id);
          }}
          onPointerDown={
            searching || renamingId === group.id
              ? undefined
              : (e) => onGroupPointerDown(e, group.id, group.name, group.collapsed)
          }
          onRename={(name) => {
            onRenameGroup(group.id, name);
            onRenameDone();
          }}
          onCancelRename={onRenameDone}
          onContextMenu={(e) => onGroupCtx(e, group.id)}
          onMenu={(e) => onGroupMenu(e, group.id)}
          onNewBot={() => onGroupNewBot(group.id)}
        />
        {hidden ? null : showEmpty ? (
          <div className="empty-rail" data-rail-empty="1">
            {t("sidebar.dropHere")}
          </div>
        ) : (
          items.map((item) => (
            <ItemRow
              key={item.key}
              item={item}
              compact={folded}
              agents={agents}
              represents={representing(item.id, remotes)}
              active={selectedKind === item.kind && selected === item.id}
              unread={unread.includes(item.key)}
              drafting={drafting.includes(item.id)}
              dragging={drag?.kind === "item" && drag.key === item.key && drag.armed}
              onSelect={() => {
                if (didDrag.current) return;
                select(item);
              }}
              onContextMenu={(e) => ctx(e, item)}
              onPointerDown={
                searching ? undefined : (e) => onRowPointerDown(e, item)
              }
            />
          ))
        )}
      </section>
    );
  }

  function renderLoose() {
    if (!ungroupedItems.length && !localDrag) return null;
    return (
      <section
        key={UNGROUPED_ID}
        className={
          "rail-section" +
          (drop?.kind === "item" && drop.groupId === null && drop.into
            ? " drop-into"
            : "")
        }
        data-rail-ungrouped="1"
        data-rail-section={UNGROUPED_ID}
      >
        {ungroupedItems.map((item) => (
          <ItemRow
            key={item.key}
            item={item}
            compact={folded}
            agents={agents}
            represents={representing(item.id, remotes)}
            active={selectedKind === item.kind && selected === item.id}
            unread={unread.includes(item.key)}
            drafting={drafting.includes(item.id)}
            dragging={drag?.kind === "item" && drag.key === item.key && drag.armed}
            onSelect={() => {
              if (didDrag.current) return;
              select(item);
            }}
            onContextMenu={(e) => ctx(e, item)}
            onPointerDown={
              searching ? undefined : (e) => onRowPointerDown(e, item)
            }
          />
        ))}
        {!ungroupedItems.length && localDrag ? (
          <div className="empty-rail" data-rail-empty="1">
            {t("sidebar.ungroupDrop")}
          </div>
        ) : null}
      </section>
    );
  }

  function renderRouter({ section, items }: { section: RemoteSection; items: RailItem[] }) {
    const hidden = !searching && remoteFolds.includes(section.alias);
    const key = remoteKey(section.alias);
    return (
      <section
        key={key}
        className={
          "rail-section grouped remote-section" +
          (drag?.kind === "group" && drag.key === key && drag.armed ? " dragging" : "")
        }
        data-rail-section={key}
        data-rail-remote={section.alias}
      >
        <RemoteHead
          section={section}
          compact={folded}
          collapsed={hidden}
          onToggle={() => {
            if (didDrag.current) return;
            toggleRemote(section.alias);
          }}
          onPointerDown={
            searching ? undefined : (e) => onGroupPointerDown(e, key, section.alias, hidden)
          }
        />
        {hidden ? null : items.length ? (
          items.map((item) => (
            <ItemRow
              key={item.key}
              item={item}
              compact={folded}
              agents={agents}
              active={selectedKind === item.kind && selected === item.id}
              unread={unread.includes(item.key)}
              drafting={drafting.includes(item.id)}
              dragging={drag?.kind === "item" && drag.key === item.key && drag.armed}
              onSelect={() => {
                if (didDrag.current) return;
                select(item);
              }}
              onContextMenu={(e) => ctx(e, item)}
              onPointerDown={
                searching ? undefined : (e) => onRowPointerDown(e, item)
              }
            />
          ))
        ) : folded ? null : (
          <div className="empty-rail">{t("sidebar.remoteEmpty")}</div>
        )}
      </section>
    );
  }

  return (
    <aside className={folded ? "folded" : undefined}>
      <div className="drag-top" data-tauri-drag-region />
      <div className="search-row">
        {/* A folded rail keeps the field in the tree so ⌘K can still reach
            it; focusing it opens the rail. */}
        <input
          ref={searchRef}
          className="search"
          type="search"
          placeholder={t("sidebar.search")}
          title={t("sidebar.searchTitle")}
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          tabIndex={folded ? -1 : undefined}
          onFocus={() => {
            if (folded) setFolded(false, true);
          }}
        />
        {folded ? (
          <button
            type="button"
            className="icon-btn search-open"
            title={t("sidebar.searchTitle")}
            aria-label={t("sidebar.search")}
            onClick={(e) =>
              e.currentTarget.parentElement
                ?.querySelector<HTMLInputElement>(".search")
                ?.focus()
            }
          >
            <Search />
          </button>
        ) : null}
        <button
          type="button"
          className="icon-btn"
          title={t("sidebar.add")}
          aria-label={t("sidebar.add")}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onCreateMenu(e);
          }}
        >
          <Plus />
        </button>
      </div>
      {searchHits.length && !folded ? (
        <div className="search-hits">
          {searchHits.slice(0, 12).map((hit) => (
            <button
              key={hit.kind + hit.id}
              type="button"
              className="search-hit"
              onClick={() => onSearchHit?.(hit)}
            >
              <span className="search-hit-kind">{hit.kind}</span>
              <span className="search-hit-title">{hit.title}</span>
              {hit.snippet ? (
                <span className="search-hit-snippet">{hit.snippet}</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
      <div className="rail-lists">
        {empty ? (
          <div className="empty-rail">
            {agents.length ? t("sidebar.noResults") : t("sidebar.empty")}
          </div>
        ) : (
          <>
            {railKeys.map((key) => {
              if (key === UNGROUPED_ID) return renderLoose();
              const router = remoteByKey.get(key);
              if (router) return renderRouter(router);
              const folder = groupByKey.get(key);
              return folder ? renderFolder(folder) : null;
            })}
          </>
        )}
      </div>
      {onOpenSettings ? (
        <div className="rail-foot">
          <button
            type="button"
            className="icon-btn"
            title={t("sidebar.settingsTitle")}
            aria-label={t("sidebar.settings")}
            onClick={onOpenSettings}
          >
            <Settings />
          </button>
          <PlanUsageButton agents={agents} />
        </div>
      ) : null}
      <div
        className="rail-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label={t("sidebar.resize")}
        aria-valuemin={RAIL_FOLDED}
        aria-valuemax={RAIL_MAX}
        aria-valuenow={shownW}
        tabIndex={0}
        onPointerDown={onRailPointerDown}
        onPointerMove={onRailPointerMove}
        onPointerUp={onRailPointerUp}
        onPointerCancel={onRailPointerUp}
        onDoubleClick={() => setRail(RAIL_DEFAULT, true)}
        onKeyDown={onRailKeyDown}
      />
      {drag?.armed
        ? createPortal(
            <>
              {drop?.line &&
              (drop.kind === "group" || drop.beforeKey !== drag.key) ? (
                <div
                  className="rail-drop-line"
                  style={{
                    left: drop.line.left,
                    top: drop.line.top,
                    width: drop.line.width,
                  }}
                />
              ) : null}
              <div
                className="rail-ghost"
                style={{
                  width: drag.width,
                  left: drag.x - drag.grabX,
                  top: drag.y - drag.grabY,
                  ["--ghost-ox" as string]: `${drag.grabX}px`,
                  ["--ghost-oy" as string]: `${drag.grabY}px`,
                }}
              >
                {drag.kind === "group" ? (
                  <div
                    className={
                      "group-head" +
                      (isRemoteKey(drag.key) ? " remote-head" : "") +
                      (drag.collapsed ? " collapsed" : "") +
                      (folded ? " compact" : "")
                    }
                  >
                    <span className="group-toggle" aria-hidden>
                      <ChevronDown className="group-chevron" size={14} />
                    </span>
                    <span className="group-name">{drag.groupName}</span>
                  </div>
                ) : (
                  <ItemRow item={drag.item} agents={agents} compact={folded} ghost />
                )}
              </div>
            </>,
            document.body,
          )
        : null}
    </aside>
  );
}

function GroupHead({
  group,
  compact,
  renaming,
  searching,
  dropInto,
  onToggle,
  onRename,
  onCancelRename,
  onContextMenu,
  onMenu,
  onNewBot,
  onPointerDown,
}: {
  group: Group;
  /** The folded rail: the chevron alone, the name on hover. */
  compact?: boolean;
  renaming: boolean;
  searching: boolean;
  dropInto?: boolean;
  onToggle: () => void;
  onRename: (name: string) => void;
  onCancelRename: () => void;
  onContextMenu: (e: MouseEvent) => void;
  onMenu: (e: MouseEvent) => void;
  onNewBot: () => void;
  onPointerDown?: (e: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(group.name);

  useEffect(() => {
    if (!renaming) return;
    setDraft(group.name);
    const t = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(t);
  }, [renaming, group.name]);

  function commit() {
    const name = draft.trim();
    if (!name || name === group.name) {
      onCancelRename();
      return;
    }
    onRename(name);
  }

  return (
    <div
      className={
        "group-head" +
        (!searching && group.collapsed ? " collapsed" : "") +
        (dropInto ? " drop-into" : "") +
        (compact ? " compact" : "")
      }
      data-rail-group-head={group.id}
      title={compact ? group.name : group.path || undefined}
      onPointerDown={onPointerDown}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(e);
      }}
    >
      <button
        type="button"
        className="group-toggle"
        title={
          compact
            ? group.name
            : group.collapsed
              ? t("sidebar.expand")
              : t("sidebar.collapse")
        }
        aria-label={group.collapsed ? t("sidebar.expand") : t("sidebar.collapse")}
        onClick={onToggle}
      >
        <ChevronDown className="group-chevron" size={14} />
      </button>
      {renaming ? (
        <input
          ref={inputRef}
          className="group-name-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancelRename();
            }
          }}
        />
      ) : (
        <>
          <button type="button" className="group-name" onClick={onToggle}>
            <span className="group-name-text">{group.name}</span>
          </button>
          <button
            type="button"
            className="group-more"
            title={t("sidebar.groupNewBot")}
            aria-label={t("sidebar.groupNewBot")}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onNewBot();
            }}
          >
            <Plus size={14} />
          </button>
          <button
            type="button"
            className="group-more"
            title={t("sidebar.groupMenu")}
            aria-label={t("sidebar.groupMenu")}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onMenu(e);
            }}
          >
            <Ellipsis size={14} />
          </button>
        </>
      )}
    </div>
  );
}

/** A router's head. It moves like a folder's; its rows are the router's, so nothing renames. */
function RemoteHead({
  section,
  compact,
  collapsed,
  onToggle,
  onPointerDown,
}: {
  section: RemoteSection;
  compact?: boolean;
  collapsed: boolean;
  onToggle: () => void;
  onPointerDown?: (e: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  const t = useT();
  const connected = section.remote?.connected;
  const state =
    connected === undefined
      ? ""
      : connected
        ? t("sidebar.remoteConnected")
        : t("sidebar.remoteDisconnected");
  const label = state ? `${section.alias} · ${state}` : section.alias;
  return (
    <div
      className={
        "group-head remote-head" + (collapsed ? " collapsed" : "") + (compact ? " compact" : "")
      }
      data-rail-remote-head={section.alias}
      title={compact ? label : section.remote?.url || undefined}
      onPointerDown={onPointerDown}
    >
      <button
        type="button"
        className="group-toggle"
        title={compact ? label : collapsed ? t("sidebar.expand") : t("sidebar.collapse")}
        aria-label={collapsed ? t("sidebar.expand") : t("sidebar.collapse")}
        onClick={onToggle}
      >
        <ChevronDown className="group-chevron" size={14} />
      </button>
      <button type="button" className="group-name" onClick={onToggle}>
        <span className="group-name-text">{section.alias}</span>
        {connected === undefined ? null : (
          <span
            className={"remote-conn" + (connected ? " is-on" : "")}
            title={state}
            aria-label={state}
            role="img"
          />
        )}
      </button>
    </div>
  );
}

function ItemRow({
  item,
  agents,
  compact,
  active,
  unread,
  drafting,
  dragging,
  ghost,
  represents = [],
  onSelect,
  onContextMenu,
  onPointerDown,
}: {
  item: RailItem;
  agents: AgentInfo[];
  /** Routers this local bot stands in for. */
  represents?: string[];
  /** The folded rail: the face alone, the name on hover. */
  compact?: boolean;
  active?: boolean;
  unread?: boolean;
  drafting?: boolean;
  dragging?: boolean;
  ghost?: boolean;
  onSelect?: () => void;
  onContextMenu?: (e: MouseEvent) => void;
  onPointerDown?: (e: ReactPointerEvent<HTMLButtonElement>) => void;
}) {
  const a = item.agent;
  const t = useT();
  const { locale } = useLocale();
  const ts = a?.last_ts || 0;
  const stamp = listStamp(ts, locale);
  // ItemRow re-renders on every pointermove while a drag is armed, so the scan
  // does not want to run per frame per visible row.
  const previewRuns = useMemo(
    () => mentionRuns(item.preview || "", agents),
    [item.preview, agents],
  );
  const remote = !!a?.remote;
  const online = isOnline(a);
  const face = (
    <Avatar
      id={item.id}
      name={item.name}
      src={a?.avatar}
      shape={a?.avatar_shape}
      color={a?.avatar_color}
      badge={a?.status || undefined}
      status={a?.status}
      overlay={
        remote ? <span className={"badge remote-dot" + (online ? " is-on" : "")} /> : null
      }
    />
  );
  const repLabel = represents.length
    ? t("sidebar.represents", { alias: represents.join(", ") })
    : "";
  const inner = (
    <>
      {face}
      <div className="rail-row-text">
        <div className="agent-name">
          <span className="agent-name-label">
            <span className="agent-name-text">{item.name}</span>
            {drafting ? (
              <span className="draft-mark" title={t("sidebar.draft")} aria-label={t("sidebar.draft")}>
                <Ellipsis size={14} />
              </span>
            ) : null}
            {item.ordinal ? (
              <span className="name-ordinal">#{item.ordinal}</span>
            ) : null}
            {represents.length ? (
              <span className="rep-mark" title={repLabel}>
                {represents.join(" · ")}
              </span>
            ) : null}
          </span>
          {stamp ? (
            <time className="rail-stamp" dateTime={new Date(ts).toISOString()}>
              {stamp}
            </time>
          ) : null}
        </div>
        {item.preview ? (
          <div className="agent-preview">
            {/* The preview is this bot's chat, so its group is the one left off. */}
            <BotLabelProvider viewer={item.id}>
              {previewRuns.map((run, i) =>
                run.agent ? (
                  <MentionChip key={i} agent={run.agent} />
                ) : (
                  <span key={i}>{run.text}</span>
                ),
              )}
            </BotLabelProvider>
          </div>
        ) : null}
      </div>
      {unread ? <span className="unread-dot" aria-hidden /> : null}
    </>
  );
  const label =
    (item.ordinal ? `${item.name} #${item.ordinal}` : item.name) +
    (remote ? ` · ${online ? t("sidebar.online") : t("sidebar.offline")}` : "") +
    (repLabel ? ` · ${repLabel}` : "") +
    (drafting ? ` · ${t("sidebar.draft")}` : "");
  if (ghost) {
    return (
      <div className={"rail-row" + (compact ? " compact" : "")} aria-hidden>
        {inner}
      </div>
    );
  }
  return (
    <button
      type="button"
      className={
        "rail-row" +
        (compact ? " compact" : "") +
        (active ? " active" : "") +
        (unread ? " unread" : "") +
        (dragging ? " dragging" : "") +
        (online ? "" : " is-offline")
      }
      data-rail-row={item.key}
      title={compact ? label : remote ? `${a?.remote}/${item.name}` : undefined}
      aria-label={compact ? label : undefined}
      onClick={onSelect}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu?.(e);
      }}
      onPointerDown={onPointerDown}
      onDragStart={(e) => e.preventDefault()}
    >
      {inner}
    </button>
  );
}
