import { useEffect, useRef } from "react";
import type { AgentInfo, ChannelInfo, ChatMessage, Kind } from "../types";
import { renderMarkdown } from "../markdown";
import { Avatar } from "./Avatar";

type Props = {
  messages: ChatMessage[];
  agents: AgentInfo[];
  selected: string | null;
  selectedKind: Kind;
  currentAgent: AgentInfo | null;
  currentChannel: ChannelInfo | null;
  stick: boolean;
  onStick: (stick: boolean) => void;
  streaming?: boolean;
};

export function ChatThread({
  messages,
  agents,
  selected,
  selectedKind,
  currentAgent,
  currentChannel,
  stick,
  onStick,
  streaming = false,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el && stick) el.scrollTop = el.scrollHeight;
  }, [messages, stick, selected, selectedKind, streaming]);

  return (
    <div
      className="thread"
      ref={ref}
      onScroll={() => {
        const el = ref.current;
        if (!el) return;
        onStick(el.scrollHeight - el.scrollTop - el.clientHeight < 48);
      }}
    >
      {!messages.length ? (
        <EmptyChat agent={currentAgent} channel={currentChannel} />
      ) : (
        messages.map((m, i) =>
          m.role === "system" ? (
            <SystemLine
              key={m.id}
              message={m}
              agents={agents}
              selected={selected}
              selectedKind={selectedKind}
            />
          ) : (
            <Bubble
              key={m.id}
              message={m}
              selectedKind={selectedKind}
              caret={
                streaming &&
                m.role === "assistant" &&
                i === messages.length - 1
              }
            />
          ),
        )
      )}
      {streaming &&
      messages.length > 0 &&
      messages[messages.length - 1]?.role !== "assistant" ? (
        <div className="row them">
          <div className="bubble md streaming" />
        </div>
      ) : null}
    </div>
  );
}

function EmptyChat({
  agent,
  channel,
}: {
  agent: AgentInfo | null;
  channel: ChannelInfo | null;
}) {
  if (channel) {
    return (
      <div className="empty-chat">
        <Avatar id={channel.id} name={channel.name || channel.id} letter="#" />
        <strong>{channel.name || channel.id}</strong>
        <span>채널에 메시지를 보내 대화를 시작하세요</span>
      </div>
    );
  }
  if (agent) {
    return (
      <div className="empty-chat">
        <Avatar
          id={agent.id}
          name={agent.name || agent.id}
          src={agent.avatar}
          shape={agent.avatar_shape}
          color={agent.avatar_color}
        />
        <strong>{agent.name || agent.id}</strong>
        <span>메시지를 보내 대화를 시작하세요</span>
      </div>
    );
  }
  return <div className="empty-chat">대화를 선택하세요</div>;
}

function SystemLine({
  message: m,
  agents,
  selected,
  selectedKind,
}: {
  message: ChatMessage;
  agents: AgentInfo[];
  selected: string | null;
  selectedKind: Kind;
}) {
  const known =
    m.from === "user" ||
    agents.some((a) => a.id === m.from) ||
    String(m.from || "").startsWith("#");
  const who = known
    ? selectedKind === "channel"
      ? m.from || ""
      : `${m.from} → ${selected}`
    : `루틴 · ${m.from || ""}`;
  return (
    <div className="sys">
      <div className="sys-from">{who}</div>
      <div className="sys-text">{m.text || ""}</div>
    </div>
  );
}

function Bubble({
  message: m,
  selectedKind,
  caret = false,
}: {
  message: ChatMessage;
  selectedKind: Kind;
  caret?: boolean;
}) {
  const html = renderMarkdown(m.text || "");
  const cls = "bubble md" + (caret ? " streaming" : "");
  if (selectedKind === "channel" && m.role !== "user") {
    return (
      <div className="row them">
        <div className="channel-msg">
          <div className="sys-from channel-who">{m.from || ""}</div>
          <div className={cls} dangerouslySetInnerHTML={{ __html: html }} />
        </div>
      </div>
    );
  }
  return (
    <div className={"row " + (m.role === "user" ? "me" : "them")}>
      <div className={cls} dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
