import type { MouseEvent } from "react";
import type { AgentInfo, ChannelInfo, Kind } from "../types";
import { Avatar } from "./Avatar";

type Props = {
  agents: AgentInfo[];
  channels: ChannelInfo[];
  selected: string | null;
  selectedKind: Kind;
  query: string;
  connected: boolean | null;
  connDetail: string;
  onQuery: (q: string) => void;
  onSelectAgent: (id: string) => void;
  onSelectChannel: (id: string) => void;
  onNewBot: () => void;
  onNewChannel: () => void;
  onAgentCtx: (e: MouseEvent, id: string) => void;
  onChannelCtx: (e: MouseEvent, id: string) => void;
  onPickAvatar: (id: string) => void;
};

function matchesQuery(a: AgentInfo, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const blob = [a.name, a.id, a.title, a.role, a.preview]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return blob.includes(q);
}

function matchesChannel(c: ChannelInfo, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const blob = [c.name, c.id, (c.members || []).join(" "), c.preview]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return blob.includes(q);
}

export function Sidebar({
  agents,
  channels,
  selected,
  selectedKind,
  query,
  connected,
  connDetail,
  onQuery,
  onSelectAgent,
  onSelectChannel,
  onNewBot,
  onNewChannel,
  onAgentCtx,
  onChannelCtx,
  onPickAvatar,
}: Props) {
  const shownAgents = agents.filter((a) => matchesQuery(a, query));
  const shownChannels = channels.filter((c) => matchesChannel(c, query));
  const connClass =
    connected === null ? "conn-dot" : connected ? "conn-dot ok" : "conn-dot bad";

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
          className="new-bot-btn"
          title="새 봇"
          aria-label="새 봇"
          onClick={onNewBot}
        >
          +
        </button>
        <span className={connClass} title={connDetail} />
      </div>
      <div className="rail-lists">
        <div>
          {!shownAgents.length ? (
            <div className="empty-rail">
              {agents.length ? "검색 결과가 없습니다" : "에이전트가 없습니다"}
            </div>
          ) : (
            shownAgents.map((a) => (
              <button
                key={a.id}
                type="button"
                className={
                  "agent" +
                  (selectedKind === "agent" && a.id === selected ? " active" : "")
                }
                onClick={() => onSelectAgent(a.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onAgentCtx(e, a.id);
                }}
              >
                <Avatar
                  id={a.id}
                  name={a.name || a.id}
                  src={a.avatar}
                  badge={a.status || ""}
                  title="사진 변경"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (selectedKind !== "agent" || selected !== a.id) {
                      onSelectAgent(a.id);
                    }
                    onPickAvatar(a.id);
                  }}
                />
                <div>
                  <div className="agent-name">{a.name || a.id}</div>
                  {a.preview ? <div className="agent-preview">{a.preview}</div> : null}
                </div>
              </button>
            ))
          )}
        </div>
        <div className="rail-section">
          <div className="rail-head">
            <div className="rail-label">채널</div>
            <button
              type="button"
              className="rail-add"
              title="새 채널"
              aria-label="새 채널"
              onClick={onNewChannel}
            >
              +
            </button>
          </div>
          <div>
            {!shownChannels.length ? (
              <div className="empty-rail">
                {channels.length ? "검색 결과가 없습니다" : "없음"}
              </div>
            ) : (
              shownChannels.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={
                    "channel" +
                    (selectedKind === "channel" && c.id === selected ? " active" : "")
                  }
                  onClick={() => onSelectChannel(c.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onChannelCtx(e, c.id);
                  }}
                >
                  <Avatar id={c.id} name={c.name || c.id} letter="#" />
                  <div>
                    <div className="agent-name">{c.name || c.id}</div>
                    {c.preview || (c.members || []).join(", ") ? (
                      <div className="agent-preview">
                        {c.preview || (c.members || []).join(", ")}
                      </div>
                    ) : null}
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      </div>
      <div className="foot">
        <div className="account">
          <div className="avatar">C</div>
          <div className="account-name">Crew</div>
        </div>
      </div>
    </aside>
  );
}
