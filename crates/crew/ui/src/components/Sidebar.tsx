import type { MouseEvent } from "react";
import type { AgentInfo, ChannelInfo, Kind } from "../types";
import { Avatar } from "./Avatar";

type Props = {
  agents: AgentInfo[];
  channels: ChannelInfo[];
  selected: string | null;
  selectedKind: Kind;
  query: string;
  onQuery: (q: string) => void;
  onSelectAgent: (id: string) => void;
  onSelectChannel: (id: string) => void;
  onNewBot: () => void;
  onNewChannel: () => void;
  onAgentCtx: (e: MouseEvent, id: string) => void;
  onChannelCtx: (e: MouseEvent, id: string) => void;
  onPickAvatar: (id: string) => void;
};

function matches(parts: Array<string | null | undefined>, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return parts.filter(Boolean).join(" ").toLowerCase().includes(q);
}

export function Sidebar({
  agents,
  channels,
  selected,
  selectedKind,
  query,
  onQuery,
  onSelectAgent,
  onSelectChannel,
  onNewBot,
  onNewChannel,
  onAgentCtx,
  onChannelCtx,
  onPickAvatar,
}: Props) {
  const shownAgents = agents.filter((a) =>
    matches([a.name, a.id, a.title, a.role, a.preview], query),
  );
  const shownChannels = channels.filter((c) =>
    matches([c.name, c.id, (c.members || []).join(" "), c.preview], query),
  );

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
      </div>
      <div className="rail-lists">
        <section className="rail-section">
          <div className="rail-head">
            <div className="rail-label">에이전트</div>
            <button
              type="button"
              className="icon-btn"
              title="새 봇"
              aria-label="새 봇"
              onClick={onNewBot}
            >
              +
            </button>
          </div>
          {!shownAgents.length ? (
            <div className="empty-rail">
              {agents.length ? "검색 결과가 없습니다" : "에이전트가 없습니다"}
            </div>
          ) : (
            shownAgents.map((a) => (
              <RailRow
                key={a.id}
                id={a.id}
                name={a.name || a.id}
                preview={a.preview}
                active={selectedKind === "agent" && a.id === selected}
                src={a.avatar}
                shape={a.avatar_shape}
                color={a.avatar_color}
                badge={a.status || ""}
                onClick={() => onSelectAgent(a.id)}
                onContextMenu={(e) => onAgentCtx(e, a.id)}
                onAvatarClick={(e) => {
                  if (selectedKind !== "agent" || selected !== a.id) {
                    onSelectAgent(a.id);
                  }
                  onPickAvatar(a.id);
                  e.preventDefault();
                }}
              />
            ))
          )}
        </section>
        <section className="rail-section">
          <div className="rail-head">
            <div className="rail-label">채널</div>
            <button
              type="button"
              className="icon-btn"
              title="새 채널"
              aria-label="새 채널"
              onClick={onNewChannel}
            >
              +
            </button>
          </div>
          {!shownChannels.length ? (
            <div className="empty-rail">
              {channels.length ? "검색 결과가 없습니다" : "채널이 없습니다"}
            </div>
          ) : (
            shownChannels.map((c) => (
              <RailRow
                key={c.id}
                id={c.id}
                name={c.name || c.id}
                preview={c.preview || (c.members || []).join(", ")}
                active={selectedKind === "channel" && c.id === selected}
                letter="#"
                onClick={() => onSelectChannel(c.id)}
                onContextMenu={(e) => onChannelCtx(e, c.id)}
              />
            ))
          )}
        </section>
      </div>
    </aside>
  );
}

function RailRow({
  id,
  name,
  preview,
  active,
  letter,
  src,
  shape,
  color,
  badge,
  onClick,
  onContextMenu,
  onAvatarClick,
}: {
  id: string;
  name: string;
  preview?: string | null;
  active: boolean;
  letter?: string;
  src?: string | null;
  shape?: string | null;
  color?: string | null;
  badge?: string | null;
  onClick: () => void;
  onContextMenu: (e: MouseEvent) => void;
  onAvatarClick?: (e: MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      className={
        "rail-row" +
        (active ? " active" : "") +
        (onAvatarClick ? " has-avatar-action" : "")
      }
      onClick={onClick}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(e);
      }}
    >
      <Avatar
        id={id}
        name={name}
        src={src}
        shape={shape}
        color={color}
        letter={letter}
        badge={badge || undefined}
        title={onAvatarClick ? "사진 변경" : undefined}
        onClick={
          onAvatarClick
            ? (e) => {
                e.preventDefault();
                e.stopPropagation();
                onAvatarClick(e);
              }
            : undefined
        }
      />
      <div className="rail-row-text">
        <div className="agent-name">{name}</div>
        {preview ? <div className="agent-preview">{preview}</div> : null}
      </div>
    </button>
  );
}
