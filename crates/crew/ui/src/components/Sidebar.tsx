import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import { useLocale, useT } from "../LocaleContext";
import { itemKey, parseItemKey } from "../groups";
import type { AgentInfo, ChannelInfo, Group, Kind, SearchHit } from "../types";
import { Avatar, ChannelAvatar } from "./Avatar";

const RAIL_DEFAULT = 232;
const RAIL_MIN = 176;
const RAIL_MAX = 480;
const RAIL_KEY = "crew.rail-w";

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

function applyRail(px: number) {
  document.documentElement.style.setProperty("--rail-w", `${px}px`);
}

type RailItem = {
  key: string;
  kind: Kind;
  id: string;
  name: string;
  preview?: string | null;
  agent?: AgentInfo;
  channel?: ChannelInfo;
};

type RailDrop = {
  groupId: string | null;
  beforeKey: string | null;
  into: boolean;
  line: { left: number; top: number; width: number } | null;
};

type RailDrag = {
  key: string;
  item: RailItem;
  x: number;
  y: number;
  grabX: number;
  grabY: number;
  width: number;
  armed: boolean;
};

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

function hitRailTarget(x: number, y: number, dragKey: string): RailDrop | null {
  const stack = document.elementsFromPoint(x, y);
  const row = pickClosest(stack, "[data-rail-row]");
  if (row) {
    const key = row.dataset.railRow || null;
    const rect = row.getBoundingClientRect();
    const groupEl = row.closest("[data-rail-group]");
    const groupId =
      groupEl instanceof HTMLElement ? groupEl.dataset.railGroup || null : null;
    const inset = 8;
    const before = y < rect.top + rect.height * 0.5;
    if (before) {
      return { groupId, beforeKey: key, into: false, line: lineAt(rect, true, inset) };
    }
    const next = nextRailRow(row);
    let insertBefore = next?.dataset.railRow || null;
    if (insertBefore === dragKey && next) {
      insertBefore = nextRailRow(next)?.dataset.railRow || null;
    }
    return {
      groupId,
      beforeKey: insertBefore,
      into: false,
      line: lineAt(rect, false, inset),
    };
  }

  const head = pickClosest(stack, "[data-rail-group-head]");
  if (head) {
    return {
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
    return { groupId, beforeKey: null, into: true, line: null };
  }

  const group = pickClosest(stack, "[data-rail-group]");
  if (group) {
    return {
      groupId: group.dataset.railGroup || null,
      beforeKey: null,
      into: true,
      line: null,
    };
  }

  const ungrouped = pickClosest(stack, "[data-rail-ungrouped]");
  if (ungrouped) {
    return { groupId: null, beforeKey: null, into: true, line: null };
  }

  return null;
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
  channels: ChannelInfo[];
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
  onSelectChannel: (id: string) => void;
  onCreateMenu: (e: MouseEvent) => void;
  onAgentCtx: (e: MouseEvent, id: string) => void;
  onChannelCtx: (e: MouseEvent, id: string) => void;
  onGroupCtx: (e: MouseEvent, id: string) => void;
  onToggleGroup: (id: string) => void;
  onRenameGroup: (id: string, name: string) => void;
  onRenameDone: () => void;
  onMove: (kind: Kind, id: string, groupId: string | null, beforeKey?: string | null) => void;
  unread?: string[];
  searchRef?: Ref<HTMLInputElement>;
  onOpenSettings?: () => void;
};

function matches(parts: Array<string | null | undefined>, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return parts.filter(Boolean).join(" ").toLowerCase().includes(q);
}

function toItems(agents: AgentInfo[], channels: ChannelInfo[]): RailItem[] {
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
  for (const c of channels) {
    items.push({
      key: itemKey("channel", c.id),
      kind: "channel",
      id: c.id,
      name: c.name || c.id,
      preview: c.preview || (c.members || []).join(", "),
      channel: c,
    });
  }
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
  channels,
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
  onSelectChannel,
  onCreateMenu,
  onAgentCtx,
  onChannelCtx,
  onGroupCtx,
  onToggleGroup,
  onRenameGroup,
  onRenameDone,
  onMove,
  unread = [],
  searchRef,
  onOpenSettings,
}: Props) {
  const t = useT();
  const { locale } = useLocale();
  const all = toItems(agents, channels).filter((item) => {
    if (item.agent) {
      return matches(
        [item.agent.name, item.agent.id, item.agent.title, item.agent.role, item.agent.preview],
        query,
      );
    }
    const c = item.channel;
    return matches([c?.name, c?.id, (c?.members || []).join(" "), c?.preview], query);
  });
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
  const empty = !all.length;

  const [preferredRail, setPreferredRail] = useState(() => {
    const w = loadRail();
    applyRail(clampRail(w));
    return w;
  });
  const [viewW, setViewW] = useState(() => window.innerWidth);
  const railW = clampRail(preferredRail, viewW);
  const dragRail = useRef<{ startX: number; startW: number } | null>(null);

  useLayoutEffect(() => {
    applyRail(railW);
  }, [railW]);

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
    if (persist) saveRail(stored);
  }

  function onRailPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRail.current = { startX: e.clientX, startW: railW };
    document.documentElement.classList.add("rail-resizing");
  }

  function onRailPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRail.current;
    if (!drag) return;
    setRail(drag.startW + (e.clientX - drag.startX), false);
  }

  function onRailPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (!dragRail.current) return;
    dragRail.current = null;
    document.documentElement.classList.remove("rail-resizing");
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    setPreferredRail((w) => {
      saveRail(w);
      return w;
    });
  }

  function onRailKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    const step = e.shiftKey ? 32 : 16;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      setRail(preferredRail - step, true);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      setRail(preferredRail + step, true);
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
  const dragRef = useRef<RailDrag | null>(null);
  const dropRef = useRef<RailDrop | null>(null);
  const didDrag = useRef(false);
  const stopListen = useRef<(() => void) | null>(null);
  const expandTimer = useRef<number | null>(null);
  const expandFor = useRef<string | null>(null);
  const onMoveRef = useRef(onMove);
  const onToggleGroupRef = useRef(onToggleGroup);
  onMoveRef.current = onMove;
  onToggleGroupRef.current = onToggleGroup;

  useEffect(() => {
    return () => {
      stopListen.current?.();
      if (expandTimer.current) window.clearTimeout(expandTimer.current);
      document.documentElement.classList.remove("rail-dragging");
    };
  }, []);

  function select(item: RailItem) {
    if (item.kind === "channel") onSelectChannel(item.id);
    else onSelectAgent(item.id);
  }

  function ctx(e: MouseEvent, item: RailItem) {
    if (item.kind === "channel") onChannelCtx(e, item.id);
    else onAgentCtx(e, item.id);
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
    if (t.beforeKey === d.key) return;
    const parsed = parseItemKey(d.key);
    if (!parsed) return;
    onMoveRef.current(parsed.kind, parsed.id, t.groupId, t.beforeKey);
    if (t.into && t.groupId) {
      const collapsed = document.querySelector(
        `[data-rail-group="${t.groupId}"] .group-head.collapsed`,
      );
      if (collapsed) onToggleGroupRef.current(t.groupId);
    }
  }

  function onRowPointerDown(e: ReactPointerEvent<HTMLButtonElement>, item: RailItem) {
    if (e.button !== 0 || searching) return;
    if ((e.target as HTMLElement).closest("input, textarea, a")) return;
    const rowEl = e.currentTarget;
    const rect = rowEl.getBoundingClientRect();
    const originX = e.clientX;
    const originY = e.clientY;
    const pending: RailDrag = {
      key: item.key,
      item,
      x: e.clientX,
      y: e.clientY,
      grabX: e.clientX - rect.left,
      grabY: e.clientY - rect.top,
      width: rect.width,
      armed: false,
    };
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
      const target = hitRailTarget(ev.clientX, ev.clientY, cur.key);
      dropRef.current = target;
      setDrop(target);
      queueExpand(target?.groupId ?? null, !!target?.into);
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

  return (
    <aside>
      <div className="drag-top" data-tauri-drag-region />
      <div className="search-row">
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
        />
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
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M8 3.5v9M3.5 8h9"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
      {searchHits.length ? (
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
            {agents.length || channels.length ? t("sidebar.noResults") : t("sidebar.empty")}
          </div>
        ) : (
          <>
            {grouped.map(({ group, items }) => {
              if (searching && !items.length) return null;
              const hidden = !searching && group.collapsed;
              const showEmpty = !hidden && !items.length && !searching;
              return (
                <section
                  key={group.id}
                  className={
                    "rail-section grouped" +
                    (drop?.groupId === group.id && drop.into ? " drop-into" : "")
                  }
                  data-rail-group={group.id}
                >
                  <GroupHead
                    group={group}
                    renaming={renamingId === group.id}
                    searching={searching}
                    dropInto={drop?.groupId === group.id && drop.into}
                    onToggle={() => onToggleGroup(group.id)}
                    onRename={(name) => {
                      onRenameGroup(group.id, name);
                      onRenameDone();
                    }}
                    onCancelRename={onRenameDone}
                    onContextMenu={(e) => onGroupCtx(e, group.id)}
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
                        agents={agents}
                        active={selectedKind === item.kind && selected === item.id}
                        unread={unread.includes(item.key)}
                        dragging={drag?.key === item.key && drag.armed}
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
            })}
            {ungroupedItems.length || drag?.armed ? (
              <section
                className={
                  "rail-section" +
                  (drop && drop.groupId === null && drop.into ? " drop-into" : "")
                }
                data-rail-ungrouped="1"
              >
                {ungroupedItems.map((item) => (
                  <ItemRow
                    key={item.key}
                    item={item}
                    agents={agents}
                    active={selectedKind === item.kind && selected === item.id}
                    unread={unread.includes(item.key)}
                    dragging={drag?.key === item.key && drag.armed}
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
                {!ungroupedItems.length && drag?.armed ? (
                  <div className="empty-rail" data-rail-empty="1">
                    {t("sidebar.ungroupDrop")}
                  </div>
                ) : null}
              </section>
            ) : null}
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
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="8" cy="8" r="2.15" stroke="currentColor" strokeWidth="1.4" />
              <path
                d="M8 1.7v1.6M8 12.7v1.6M1.7 8h1.6M12.7 8h1.6M3.4 3.4l1.15 1.15M11.45 11.45l1.15 1.15M3.4 12.6l1.15-1.15M11.45 4.55l1.15-1.15"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      ) : null}
      <div
        className="rail-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label={t("sidebar.resize")}
        aria-valuemin={RAIL_MIN}
        aria-valuemax={RAIL_MAX}
        aria-valuenow={railW}
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
              {drop?.line && drop.beforeKey !== drag.key ? (
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
                <ItemRow item={drag.item} agents={agents} ghost />
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
  renaming,
  searching,
  dropInto,
  onToggle,
  onRename,
  onCancelRename,
  onContextMenu,
}: {
  group: Group;
  renaming: boolean;
  searching: boolean;
  dropInto?: boolean;
  onToggle: () => void;
  onRename: (name: string) => void;
  onCancelRename: () => void;
  onContextMenu: (e: MouseEvent) => void;
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
        (dropInto ? " drop-into" : "")
      }
      data-rail-group-head={group.id}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(e);
      }}
    >
      <button
        type="button"
        className="group-toggle"
        title={group.collapsed ? t("sidebar.expand") : t("sidebar.collapse")}
        aria-label={group.collapsed ? t("sidebar.expand") : t("sidebar.collapse")}
        onClick={onToggle}
      >
        <span className="group-chevron">▾</span>
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
        <button type="button" className="group-name" onClick={onToggle}>
          {group.name}
        </button>
      )}
    </div>
  );
}

function ItemRow({
  item,
  agents,
  active,
  unread,
  dragging,
  ghost,
  onSelect,
  onContextMenu,
  onPointerDown,
}: {
  item: RailItem;
  agents: AgentInfo[];
  active?: boolean;
  unread?: boolean;
  dragging?: boolean;
  ghost?: boolean;
  onSelect?: () => void;
  onContextMenu?: (e: MouseEvent) => void;
  onPointerDown?: (e: ReactPointerEvent<HTMLButtonElement>) => void;
}) {
  const a = item.agent;
  const face =
    item.kind === "channel" && item.channel ? (
      <ChannelAvatar channel={item.channel} agents={agents} />
    ) : (
      <Avatar
        id={item.id}
        name={item.name}
        src={a?.avatar}
        shape={a?.avatar_shape}
        color={a?.avatar_color}
        badge={a?.status || undefined}
        status={a?.status}
      />
    );
  const inner = (
    <>
      {face}
      <div className="rail-row-text">
        <div className="agent-name">{item.name}</div>
        {item.preview ? <div className="agent-preview">{item.preview}</div> : null}
      </div>
      {unread ? <span className="unread-dot" aria-hidden /> : null}
    </>
  );
  if (ghost) {
    return (
      <div className="rail-row" aria-hidden>
        {inner}
      </div>
    );
  }
  return (
    <button
      type="button"
      className={
        "rail-row" +
        (active ? " active" : "") +
        (unread ? " unread" : "") +
        (dragging ? " dragging" : "")
      }
      data-rail-row={item.key}
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
