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
  const visible = visibleMessages(messages);

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
        visible.map((m, i, list) => {
          const caret =
            streaming &&
            m.role === "assistant" &&
            i === list.length - 1;
          if (m.role === "system") {
            return (
              <SystemOrIncoming
                key={m.id}
                message={m}
                agents={agents}
                selectedKind={selectedKind}
              />
            );
          }
          return (
            <Bubble
              key={m.id}
              message={m}
              agents={agents}
              selectedKind={selectedKind}
              caret={caret}
            />
          );
        })
      )}
      {streaming &&
      visible.length > 0 &&
      visible[visible.length - 1]?.role !== "assistant" ? (
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
          status={agent.status}
        />
        <strong>{agent.name || agent.id}</strong>
        <span>메시지를 보내 대화를 시작하세요</span>
      </div>
    );
  }
  return <div className="empty-chat">대화를 선택하세요</div>;
}

function SystemOrIncoming({
  message: m,
  agents,
  selectedKind,
}: {
  message: ChatMessage;
  agents: AgentInfo[];
  selectedKind: Kind;
}) {
  if (m.from === "user") {
    return (
      <Bubble
        message={{ ...m, role: "user" }}
        agents={agents}
        selectedKind={selectedKind}
      />
    );
  }
  const agent = agents.find((a) => a.id === m.from) ?? null;
  if (agent || String(m.from || "").startsWith("#")) {
    return <Incoming message={m} agent={agent} who={displayWho(m, agent)} />;
  }
  return (
    <div className="sys">
      <div className="sys-from">{`루틴 · ${m.from || ""}`}</div>
      <div className="sys-text">{m.text || ""}</div>
    </div>
  );
}

function Incoming({
  message: m,
  agent,
  who,
  caret = false,
}: {
  message: ChatMessage;
  agent: AgentInfo | null;
  who: string;
  caret?: boolean;
}) {
  const html = renderMarkdown(m.text || "");
  const cls = "bubble md" + (caret ? " streaming" : "");
  return (
    <div className="row them">
      {agent ? (
        <Avatar
          className="msg-avatar"
          id={agent.id}
          name={agent.name || agent.id}
          src={agent.avatar}
          shape={agent.avatar_shape}
          color={agent.avatar_color}
          status={agent.status}
        />
      ) : null}
      <div className="channel-msg">
        <div className="sys-from channel-who">{who}</div>
        <div className={cls} dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  );
}

function Bubble({
  message: m,
  agents,
  selectedKind,
  caret = false,
}: {
  message: ChatMessage;
  agents: AgentInfo[];
  selectedKind: Kind;
  caret?: boolean;
}) {
  const text =
    m.role === "assistant" ? stripCrewMarkers(m.text || "") : m.text || "";
  if (selectedKind === "channel" && m.role !== "user") {
    const agent = agents.find((a) => a.id === m.from) ?? null;
    return (
      <Incoming
        message={{ ...m, text }}
        agent={agent}
        who={displayWho(m, agent)}
        caret={caret}
      />
    );
  }
  const html = renderMarkdown(text);
  const cls = "bubble md" + (caret ? " streaming" : "");
  return (
    <div className={"row " + (m.role === "user" ? "me" : "them")}>
      <div className={cls} dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

function displayWho(m: ChatMessage, agent: AgentInfo | null): string {
  if (agent) return agent.name || agent.id;
  return m.from || "";
}

function isCrewMarkerLine(line: string): boolean {
  const t = line.trim();
  return /^\[crew (from:[^\]]+|routine:[^\]]+|channel:[^\]]+|system)\]$/.test(t);
}

function stripCrewMarkers(text: string): string {
  return text
    .split("\n")
    .filter((line) => !isCrewMarkerLine(line))
    .join("\n")
    .trim();
}

function isEnvelopeEcho(raw: string, prev: ChatMessage | undefined): boolean {
  if (!/\[crew (from:|routine:|channel:|system)/.test(raw)) return false;
  const text = stripCrewMarkers(raw);
  if (!text) return true;
  if (!prev || (prev.role !== "user" && prev.role !== "system")) return false;
  const src = (prev.text || "").trim();
  if (!src) return false;
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .every((line) => line === src);
}

function visibleMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((m, i) => {
    if (m.role !== "assistant") return true;
    const raw = m.text || "";
    if (isEnvelopeEcho(raw, messages[i - 1])) return false;
    return stripCrewMarkers(raw).length > 0;
  });
}
