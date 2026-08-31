import { useEffect, useRef, useState } from "react";
import type { AgentInfo, ChannelInfo, ChatMessage, Kind } from "../types";
import { Avatar } from "./Avatar";
import { MdBody } from "./MdBody";

const STICK_PX = 24;

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
  onSelectAgent?: (id: string) => void;
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
  onSelectAgent,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [away, setAway] = useState(false);
  const visible = visibleMessages(messages);
  const openAgent =
    onSelectAgent &&
    ((id: string) => {
      if (selectedKind === "agent" && selected === id) return;
      onSelectAgent(id);
    });

  function syncStick() {
    const el = ref.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    const overflow = el.scrollHeight - el.clientHeight > 8;
    onStick(gap < STICK_PX);
    setAway(overflow && gap >= STICK_PX);
  }

  function jumpBottom() {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    onStick(true);
    setAway(false);
  }

  useEffect(() => {
    const el = ref.current;
    if (el && stick) el.scrollTop = el.scrollHeight;
    syncStick();
  }, [messages, stick, selected, selectedKind, streaming]);

  return (
    <div className="thread-wrap">
      <div className="thread" ref={ref} onScroll={syncStick}>
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
                  onSelectAgent={openAgent}
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
                onSelectAgent={openAgent}
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
      {away ? (
        <button
          type="button"
          className="jump-bottom"
          title="맨 아래로"
          aria-label="맨 아래로"
          onClick={jumpBottom}
        >
          ↓
        </button>
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
  onSelectAgent,
}: {
  message: ChatMessage;
  agents: AgentInfo[];
  selectedKind: Kind;
  onSelectAgent?: (id: string) => void;
}) {
  if (m.from === "user") {
    return (
      <Bubble
        message={{ ...m, role: "user" }}
        agents={agents}
        selectedKind={selectedKind}
        onSelectAgent={onSelectAgent}
      />
    );
  }
  const agent = agents.find((a) => a.id === m.from) ?? null;
  if (agent || String(m.from || "").startsWith("#")) {
    return (
      <Incoming
        message={m}
        agent={agent}
        who={displayWho(m, agent)}
        agents={agents}
        onSelectAgent={onSelectAgent}
      />
    );
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
  agents,
  caret = false,
  onSelectAgent,
}: {
  message: ChatMessage;
  agent: AgentInfo | null;
  who: string;
  agents: AgentInfo[];
  caret?: boolean;
  onSelectAgent?: (id: string) => void;
}) {
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
        <MdBody
          className={cls}
          text={m.text || ""}
          agents={agents}
          onMention={onSelectAgent}
        />
      </div>
    </div>
  );
}

function Bubble({
  message: m,
  agents,
  selectedKind,
  caret = false,
  onSelectAgent,
}: {
  message: ChatMessage;
  agents: AgentInfo[];
  selectedKind: Kind;
  caret?: boolean;
  onSelectAgent?: (id: string) => void;
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
        agents={agents}
        caret={caret}
        onSelectAgent={onSelectAgent}
      />
    );
  }
  const cls = "bubble md" + (caret ? " streaming" : "");
  return (
    <div className={"row " + (m.role === "user" ? "me" : "them")}>
      <MdBody
        className={cls}
        text={text}
        agents={agents}
        onMention={onSelectAgent}
      />
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

function isPlainEcho(raw: string, messages: ChatMessage[], index: number): boolean {
  const text = stripCrewMarkers(raw);
  if (!text) return false;
  for (let i = index - 1; i >= 0; i--) {
    const prev = messages[i];
    if (prev.role === "user" || prev.role === "system") {
      return text === (prev.text || "").trim();
    }
  }
  return false;
}

function visibleMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((m, i) => {
    if (m.role !== "assistant") return true;
    const raw = m.text || "";
    if (isEnvelopeEcho(raw, messages[i - 1])) return false;
    if (isPlainEcho(raw, messages, i)) return false;
    return stripCrewMarkers(raw).length > 0;
  });
}
