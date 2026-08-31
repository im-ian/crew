import { useEffect, useRef, useState } from "react";
import type { AgentInfo, ChannelInfo, ChatMessage, Kind } from "../types";
import { resolveFace } from "../avatar";
import { Avatar } from "./Avatar";
import { MdBody } from "./MdBody";

const STICK_PX = 24;

type Props = {
  messages: ChatMessage[];
  agents: AgentInfo[];
  channels?: ChannelInfo[];
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
  channels = [],
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
                  channels={channels}
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
                selected={selected}
                selectedKind={selectedKind}
                currentAgent={currentAgent}
                caret={caret}
                onSelectAgent={openAgent}
              />
            );
          })
        )}
        {streaming &&
        visible.length > 0 &&
        visible[visible.length - 1]?.role !== "assistant" ? (
          <Incoming
            message={{
              id: "streaming",
              role: "assistant",
              from: currentAgent?.id || "",
              text: "",
              ts: 0,
            }}
            agent={currentAgent}
            who={currentAgent?.name || currentAgent?.id || ""}
            agents={agents}
            caret
            openName={false}
            onSelectAgent={openAgent}
          />
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
  channels,
  selectedKind,
  onSelectAgent,
}: {
  message: ChatMessage;
  agents: AgentInfo[];
  channels: ChannelInfo[];
  selectedKind: Kind;
  onSelectAgent?: (id: string) => void;
}) {
  if (m.from === "user") {
    return (
      <Bubble
        message={{ ...m, role: "user" }}
        agents={agents}
        selected={null}
        selectedKind={selectedKind}
        currentAgent={null}
        onSelectAgent={onSelectAgent}
      />
    );
  }
  const from = String(m.from || "");
  const sentId = sentTarget(from);
  if (sentId) {
    return (
      <TransferNote
        kind="sent"
        otherId={sentId}
        message={m}
        agents={agents}
        channels={channels}
        onSelectAgent={onSelectAgent}
      />
    );
  }
  const agent = agents.find((a) => a.id === m.from) ?? null;
  const fromChannel = from.startsWith("#");
  if (agent || fromChannel) {
    return (
      <TransferNote
        kind="received"
        otherId={from}
        message={m}
        agents={agents}
        channels={channels}
        onSelectAgent={onSelectAgent}
      />
    );
  }
  return (
    <div className={"sys" + (m.queued ? " queued" : "")}>
      <div className="sys-from">{`루틴 · ${m.from || ""}`}</div>
      <div className="sys-text">{m.text || ""}</div>
      {m.queued ? <QueueWait /> : null}
    </div>
  );
}

function TransferNote({
  kind,
  otherId,
  message: m,
  agents,
  channels,
  onSelectAgent,
}: {
  kind: "sent" | "received";
  otherId: string;
  message: ChatMessage;
  agents: AgentInfo[];
  channels: ChannelInfo[];
  onSelectAgent?: (id: string) => void;
}) {
  const fromChannel = otherId.startsWith("#");
  const agent = agents.find((a) => a.id === otherId) ?? null;
  const who = fromChannel
    ? `#${channelDisplayName(otherId, channels)}`
    : displayWho({ ...m, from: otherId }, agent);
  const color = agent
    ? whoColor(resolveFace(agent.id, agent.avatar_shape, agent.avatar_color).color)
    : undefined;
  const open =
    onSelectAgent && agent ? () => onSelectAgent(agent.id) : undefined;
  const label = kind === "sent" ? "보낸 메시지" : "받은 메시지";
  return (
    <div className={"xfer" + (m.queued ? " queued" : "")}>
      <div className="xfer-chip">
        <span className="xfer-label">{label}</span>
        {agent || fromChannel ? (
          <Avatar
            as={open ? "button" : "div"}
            className="xfer-avatar"
            id={agent?.id || otherId}
            name={who}
            src={agent?.avatar}
            shape={agent?.avatar_shape}
            color={agent?.avatar_color}
            letter={fromChannel ? "#" : undefined}
            status={agent?.status}
            title={who}
            onClick={open}
          />
        ) : null}
        {open ? (
          <button
            type="button"
            className="xfer-who"
            style={color ? { color } : undefined}
            onClick={open}
          >
            {who}
          </button>
        ) : (
          <span className="xfer-who" style={color ? { color } : undefined}>
            {who}
          </span>
        )}
      </div>
      {m.text ? (
        <MdBody
          className="xfer-text md"
          text={m.text}
          agents={agents}
          onMention={onSelectAgent}
        />
      ) : null}
      {m.queued ? <QueueWait /> : null}
    </div>
  );
}

function Incoming({
  message: m,
  agent,
  who,
  agents,
  caret = false,
  openName = true,
  onSelectAgent,
}: {
  message: ChatMessage;
  agent: AgentInfo | null;
  who: string;
  agents: AgentInfo[];
  caret?: boolean;
  openName?: boolean;
  onSelectAgent?: (id: string) => void;
}) {
  const color = agent
    ? whoColor(resolveFace(agent.id, agent.avatar_shape, agent.avatar_color).color)
    : undefined;
  const open =
    openName && onSelectAgent && agent
      ? () => onSelectAgent(agent.id)
      : undefined;
  const queued = !!m.queued;
  const cls =
    "bubble md incoming" +
    (caret ? " streaming" : "") +
    (queued ? " queued" : "");
  return (
    <div className={"row them incoming" + (queued ? " queued" : "")}>
      {agent ? (
        <Avatar
          as={open ? "button" : "div"}
          className="msg-avatar"
          id={agent.id}
          name={agent.name || agent.id}
          src={agent.avatar}
          shape={agent.avatar_shape}
          color={agent.avatar_color}
          status={agent.status}
          title={who}
          onClick={open}
        />
      ) : null}
      <div className="channel-msg">
        {open ? (
          <button
            type="button"
            className="channel-who"
            style={color ? { color } : undefined}
            onClick={open}
          >
            {who}
          </button>
        ) : (
          <div
            className="channel-who"
            style={color ? { color } : undefined}
          >
            {who}
          </div>
        )}
        <MdBody
          className={cls}
          text={m.text || ""}
          agents={agents}
          onMention={onSelectAgent}
        />
        {queued ? <QueueWait /> : null}
      </div>
    </div>
  );
}

function Bubble({
  message: m,
  agents,
  selected,
  selectedKind,
  currentAgent,
  caret = false,
  onSelectAgent,
}: {
  message: ChatMessage;
  agents: AgentInfo[];
  selected: string | null;
  selectedKind: Kind;
  currentAgent: AgentInfo | null;
  caret?: boolean;
  onSelectAgent?: (id: string) => void;
}) {
  const text =
    m.role === "assistant" ? stripCrewMarkers(m.text || "") : m.text || "";
  if (m.role !== "user") {
    const agent =
      agents.find((a) => a.id === m.from) ?? currentAgent ?? null;
    const self = selectedKind === "agent" && !!agent && agent.id === selected;
    return (
      <Incoming
        message={{ ...m, text }}
        agent={agent}
        who={displayWho(m, agent)}
        agents={agents}
        caret={caret}
        openName={!self}
        onSelectAgent={onSelectAgent}
      />
    );
  }
  const queued = !!m.queued;
  const cls =
    "bubble md" + (caret ? " streaming" : "") + (queued ? " queued" : "");
  return (
    <div className={"row me" + (queued ? " queued" : "")}>
      <div className="me-msg">
        <MdBody
          className={cls}
          text={text}
          agents={agents}
          onMention={onSelectAgent}
        />
        {queued ? <QueueWait /> : null}
      </div>
    </div>
  );
}

function QueueWait() {
  return (
    <div className="queue-wait" aria-label="줄 서는 중">
      <span className="queue-wait-text">줄 서는 중</span>
      <span className="queue-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    </div>
  );
}

function displayWho(m: ChatMessage, agent: AgentInfo | null): string {
  if (agent) return agent.name || agent.id;
  return m.from || "";
}

function sentTarget(from: string): string | null {
  return from.startsWith("to:") ? from.slice(3) : null;
}

function whoColor(hex: string): string {
  const n = hex.replace("#", "");
  if (n.length !== 6) return hex;
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  if (l >= 0.38) return hex;
  return `color-mix(in srgb, ${hex} 62%, white)`;
}

function channelDisplayName(from: string, channels: ChannelInfo[]): string {
  const id = from.startsWith("#") ? from.slice(1) : from;
  const ch = channels.find((c) => c.id === id);
  return (ch?.name || ch?.id || id).replace(/^#/, "");
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
