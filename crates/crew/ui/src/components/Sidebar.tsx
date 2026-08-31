import { useEffect, useRef, useState, type DragEvent, type MouseEvent } from "react";
import { itemKey, parseItemKey } from "../groups";
import type { AgentInfo, ChannelInfo, Group, Kind } from "../types";
import { Avatar } from "./Avatar";

type RailItem = {
  key: string;
  kind: Kind;
  id: string;
  name: string;
  preview?: string | null;
  agent?: AgentInfo;
  channel?: ChannelInfo;
};

type Props = {
  agents: AgentInfo[];
  channels: ChannelInfo[];
  groups: Group[];
  selected: string | null;
  selectedKind: Kind;
  query: string;
  renamingId: string | null;
  onQuery: (q: string) => void;
  onSelectAgent: (id: string) => void;
  onSelectChannel: (id: string) => void;
  onCreateMenu: (e: MouseEvent) => void;
  onAgentCtx: (e: MouseEvent, id: string) => void;
  onChannelCtx: (e: MouseEvent, id: string) => void;
  onGroupCtx: (e: MouseEvent, id: string) => void;
  onPickAvatar: (id: string) => void;
  onToggleGroup: (id: string) => void;
  onRenameGroup: (id: string, name: string) => void;
  onRenameDone: () => void;
  onMove: (kind: Kind, id: string, groupId: string | null, beforeKey?: string | null) => void;
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

export function Sidebar({
  agents,
  channels,
  groups,
  selected,
  selectedKind,
  query,
  renamingId,
  onQuery,
  onSelectAgent,
  onSelectChannel,
  onCreateMenu,
  onAgentCtx,
  onChannelCtx,
  onGroupCtx,
  onPickAvatar,
  onToggleGroup,
  onRenameGroup,
  onRenameDone,
  onMove,
}: Props) {
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
  const ungrouped = all
    .filter((item) => !used.has(item.key))
    .sort((a, b) => a.name.localeCompare(b.name, "ko"));
  const searching = !!query.trim();
  const empty = !all.length;

  const [dragKey, setDragKey] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ groupId: string | null; beforeKey: string | null } | null>(
    null,
  );

  function select(item: RailItem) {
    if (item.kind === "channel") onSelectChannel(item.id);
    else onSelectAgent(item.id);
  }

  function ctx(e: MouseEvent, item: RailItem) {
    if (item.kind === "channel") onChannelCtx(e, item.id);
    else onAgentCtx(e, item.id);
  }

  function onDragStart(e: DragEvent, item: RailItem) {
    e.dataTransfer.setData("text/plain", item.key);
    e.dataTransfer.effectAllowed = "move";
    setDragKey(item.key);
  }

  function onDragEnd() {
    setDragKey(null);
    setDrop(null);
  }

  function parseDrag(e: DragEvent): { kind: Kind; id: string } | null {
    const raw = e.dataTransfer.getData("text/plain") || dragKey;
    return raw ? parseItemKey(raw) : null;
  }

  function markDrop(e: DragEvent, groupId: string | null, beforeKey: string | null) {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    const next = { groupId, beforeKey };
    if (drop?.groupId !== next.groupId || drop?.beforeKey !== next.beforeKey) {
      setDrop(next);
    }
  }

  function applyDrop(e: DragEvent, groupId: string | null, beforeKey: string | null) {
    e.preventDefault();
    e.stopPropagation();
    const parsed = parseDrag(e);
    setDragKey(null);
    setDrop(null);
    if (!parsed) return;
    if (beforeKey === itemKey(parsed.kind, parsed.id)) return;
    onMove(parsed.kind, parsed.id, groupId, beforeKey);
  }

  return (
    <aside>
      <div className="drag-top" data-tauri-drag-region />
      <div className="search-row">
        <input
          className="search"
          type="search"
          placeholder="검색"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
        />
        <button
          type="button"
          className="icon-btn"
          title="추가"
          aria-label="추가"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onCreateMenu(e);
          }}
        >
          +
        </button>
      </div>
      <div className="rail-lists">
        {empty ? (
          <div className="empty-rail">
            {agents.length || channels.length ? "검색 결과가 없습니다" : "대화가 없습니다"}
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
                    "rail-section" +
                    (drop?.groupId === group.id && !drop.beforeKey ? " drop-over" : "")
                  }
                  onDragOver={(e) => markDrop(e, group.id, null)}
                  onDrop={(e) => applyDrop(e, group.id, null)}
                >
                  <GroupHead
                    group={group}
                    renaming={renamingId === group.id}
                    searching={searching}
                    onToggle={() => onToggleGroup(group.id)}
                    onRename={(name) => {
                      onRenameGroup(group.id, name);
                      onRenameDone();
                    }}
                    onCancelRename={onRenameDone}
                    onContextMenu={(e) => onGroupCtx(e, group.id)}
                    onDragOver={(e) => markDrop(e, group.id, null)}
                    onDrop={(e) => applyDrop(e, group.id, null)}
                  />
                  {hidden ? null : showEmpty ? (
                    <div className="empty-rail">여기로 끌어다 놓으세요</div>
                  ) : (
                    items.map((item) => (
                      <ItemRow
                        key={item.key}
                        item={item}
                        active={selectedKind === item.kind && selected === item.id}
                        dragging={dragKey === item.key}
                        dropBefore={
                          drop?.groupId === group.id && drop.beforeKey === item.key
                        }
                        onSelect={() => select(item)}
                        onContextMenu={(e) => ctx(e, item)}
                        onPickAvatar={
                          item.kind === "agent" ? () => onPickAvatar(item.id) : undefined
                        }
                        onDragStart={(e) => onDragStart(e, item)}
                        onDragEnd={onDragEnd}
                        onDragOver={(e) => markDrop(e, group.id, item.key)}
                        onDrop={(e) => applyDrop(e, group.id, item.key)}
                      />
                    ))
                  )}
                </section>
              );
            })}
            {ungrouped.length || dragKey ? (
              <section
                className={
                  "rail-section" +
                  (drop && drop.groupId === null && !drop.beforeKey ? " drop-over" : "")
                }
                onDragOver={(e) => markDrop(e, null, null)}
                onDrop={(e) => applyDrop(e, null, null)}
              >
                {ungrouped.map((item) => (
                  <ItemRow
                    key={item.key}
                    item={item}
                    active={selectedKind === item.kind && selected === item.id}
                    dragging={dragKey === item.key}
                    dropBefore={drop?.groupId === null && drop.beforeKey === item.key}
                    onSelect={() => select(item)}
                    onContextMenu={(e) => ctx(e, item)}
                    onPickAvatar={
                      item.kind === "agent" ? () => onPickAvatar(item.id) : undefined
                    }
                    onDragStart={(e) => onDragStart(e, item)}
                    onDragEnd={onDragEnd}
                    onDragOver={(e) => markDrop(e, null, item.key)}
                    onDrop={(e) => applyDrop(e, null, item.key)}
                  />
                ))}
                {!ungrouped.length && dragKey ? (
                  <div className="empty-rail">그룹에서 빼기</div>
                ) : null}
              </section>
            ) : null}
          </>
        )}
      </div>
    </aside>
  );
}

function GroupHead({
  group,
  renaming,
  searching,
  onToggle,
  onRename,
  onCancelRename,
  onContextMenu,
  onDragOver,
  onDrop,
}: {
  group: Group;
  renaming: boolean;
  searching: boolean;
  onToggle: () => void;
  onRename: (name: string) => void;
  onCancelRename: () => void;
  onContextMenu: (e: MouseEvent) => void;
  onDragOver: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
}) {
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
      className={"group-head" + (!searching && group.collapsed ? " collapsed" : "")}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(e);
      }}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <button
        type="button"
        className="group-toggle"
        title={group.collapsed ? "펼치기" : "접기"}
        aria-label={group.collapsed ? "펼치기" : "접기"}
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
  active,
  dragging,
  dropBefore,
  onSelect,
  onContextMenu,
  onPickAvatar,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: {
  item: RailItem;
  active: boolean;
  dragging: boolean;
  dropBefore: boolean;
  onSelect: () => void;
  onContextMenu: (e: MouseEvent) => void;
  onPickAvatar?: () => void;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
}) {
  const a = item.agent;
  return (
    <button
      type="button"
      className={
        "rail-row" +
        (active ? " active" : "") +
        (onPickAvatar ? " has-avatar-action" : "") +
        (dragging ? " dragging" : "") +
        (dropBefore ? " drop-before" : "")
      }
      draggable
      onClick={onSelect}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(e);
      }}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <Avatar
        id={item.id}
        name={item.name}
        src={a?.avatar}
        shape={a?.avatar_shape}
        color={a?.avatar_color}
        letter={item.kind === "channel" ? "#" : undefined}
        badge={a?.status || undefined}
        status={a?.status}
        title={onPickAvatar ? "사진 변경" : undefined}
        onClick={
          onPickAvatar
            ? (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!active) onSelect();
                onPickAvatar();
              }
            : undefined
        }
      />
      <div className="rail-row-text">
        <div className="agent-name">{item.name}</div>
        {item.preview ? <div className="agent-preview">{item.preview}</div> : null}
      </div>
    </button>
  );
}
