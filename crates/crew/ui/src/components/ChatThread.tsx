import { useEffect, useRef, useState } from "react";
import type { AgentInfo, ChannelInfo, ChatMessage, Kind } from "../types";
import { busyInChannel } from "../busy";
import { resolveFace } from "../avatar";
import { splitBubbles } from "../bubbles";
import { Avatar } from "./Avatar";
import { MdBody } from "./MdBody";
import { WhoButton, whoColor } from "./WhoButton";

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
  onApprove?: (allow: boolean, agentId?: string) => void;
  highlightId?: string | null;
  onHighlightDone?: () => void;
  jumpSeq?: number;
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
  onApprove,
  highlightId = null,
  onHighlightDone,
  jumpSeq = 0,
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
  const lastVisible = visible[visible.length - 1];
  function workingPlaceholders(): AgentInfo[] {
    const live = currentChannel
      ? busyInChannel(agents, currentChannel.id).filter((a) => a.status === "working")
      : streaming && currentAgent
        ? [currentAgent]
        : [];
    return live.filter((a) => {
      if (lastVisible?.role === "assistant" && lastVisible.from === a.id) {
        return false;
      }
      return true;
    });
  }
  function blockedCards(): AgentInfo[] {
    const live = currentChannel
      ? busyInChannel(agents, currentChannel.id).filter((a) => a.status === "blocked")
      : currentAgent?.status === "blocked"
        ? [currentAgent]
        : [];
    return live.filter(
      (a) => !messages.some((m) => m.from === a.id && m.approval === "pending"),
    );
  }

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
    if (el && stick && !highlightId) el.scrollTop = el.scrollHeight;
    syncStick();
  }, [messages, stick, selected, selectedKind, streaming, highlightId]);

  useEffect(() => {
    if (!jumpSeq) return;
    jumpBottom();
  }, [jumpSeq]);

  useEffect(() => {
    if (!highlightId) return;
    const root = ref.current;
    if (!root) return;
    const el = root.querySelector(
      `[data-msg-id="${CSS.escape(highlightId)}"]`,
    ) as HTMLElement | null;
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    const t = window.setTimeout(() => onHighlightDone?.(), 1600);
    return () => window.clearTimeout(t);
  }, [highlightId, messages, onHighlightDone]);

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
            const flash = highlightId === m.id;
            if (m.role === "system") {
              return (
                <SystemOrIncoming
                  key={m.id}
                  message={m}
                  agents={agents}
                  channels={channels}
                  selectedKind={selectedKind}
                  onSelectAgent={openAgent}
                  flash={flash}
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
                onApprove={
                  onApprove
                    ? (allow) => onApprove(allow, m.from)
                    : undefined
                }
                flash={flash}
              />
            );
          })
        )}
        {workingPlaceholders().map((agent) => (
          <Incoming
            key={"working-" + agent.id}
            message={{
              id: "working-" + agent.id,
              role: "assistant",
              from: agent.id,
              text: "",
              ts: 0,
            }}
            agent={agent}
            who={agent.name || agent.id}
            agents={agents}
            caret
            openName={selectedKind === "channel"}
            onSelectAgent={openAgent}
          />
        ))}
        {blockedCards().map((agent) => (
          <ApprovalCard
            key={"block-" + agent.id}
            state="pending"
            who={agent.name || agent.id}
            onApprove={
              onApprove ? (allow) => onApprove(allow, agent.id) : undefined
            }
          />
        ))}
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
  flash = false,
}: {
  message: ChatMessage;
  agents: AgentInfo[];
  channels: ChannelInfo[];
  selectedKind: Kind;
  onSelectAgent?: (id: string) => void;
  flash?: boolean;
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
        flash={flash}
      />
    );
  }
  const from = String(m.from || "");
  const classKind = rowClass(m, agents);
  if (classKind === "sent" || sentTarget(from)) {
    return (
      <TransferNote
        kind="sent"
        otherId={sentTarget(from) || from}
        message={{ ...m, text: displayText(m) }}
        agents={agents}
        channels={channels}
        onSelectAgent={onSelectAgent}
        flash={flash}
      />
    );
  }
  if (classKind === "tool" || m.kind === "tool") {
    return (
      <ToolCardRow
        name={from || "tool"}
        detail={displayText(m)}
        id={m.id}
        flash={flash}
      />
    );
  }
  if (classKind === "handoff") {
    return (
      <TransferNote
        kind="handoff"
        otherId={from}
        message={{ ...m, text: displayText(m) }}
        agents={agents}
        channels={channels}
        onSelectAgent={onSelectAgent}
        flash={flash}
      />
    );
  }
  const agent = agents.find((a) => a.id === from) ?? null;
  const fromChannel = from.startsWith("#");
  if (classKind === "received" || agent || fromChannel) {
    return (
      <TransferNote
        kind="received"
        otherId={from}
        message={{ ...m, text: displayText(m) }}
        agents={agents}
        channels={channels}
        onSelectAgent={onSelectAgent}
        flash={flash}
      />
    );
  }
  return (
    <div
      className={"sys" + (m.queued ? " queued" : "") + (flash ? " flash" : "")}
      data-msg-id={m.id}
    >
      <div className="sys-from">{`루틴 · ${m.from || ""}`}</div>
      <div className="sys-text">{displayText(m)}</div>
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
  flash = false,
}: {
  kind: "sent" | "received" | "handoff";
  otherId: string;
  message: ChatMessage;
  agents: AgentInfo[];
  channels: ChannelInfo[];
  onSelectAgent?: (id: string) => void;
  flash?: boolean;
}) {
  const fromChannel = otherId.startsWith("#");
  const agent = agents.find((a) => a.id === otherId) ?? null;
  const who = fromChannel
    ? `#${channelDisplayName(otherId, channels)}`
    : displayWho({ ...m, from: otherId }, agent);
  const open =
    onSelectAgent && agent ? () => onSelectAgent(agent.id) : undefined;
  const label =
    kind === "sent" ? "보낸 메시지" : kind === "handoff" ? "핸드오프" : "받은 메시지";
  return (
    <div
      className={"xfer" + (m.queued ? " queued" : "") + (flash ? " flash" : "")}
      data-msg-id={m.id}
    >
      <div className="xfer-chip">
        <span className="xfer-label">{label}</span>
        <WhoButton
          agent={agent}
          who={who}
          letter={fromChannel ? "#" : undefined}
          fallbackId={otherId}
          onClick={open}
        />
      </div>
      {m.text ? (
        <XferBody
          text={m.text}
          agents={agents}
          onMention={onSelectAgent}
          baseDir={agent?.cwd || undefined}
        />
      ) : null}
      {m.queued ? <QueueWait /> : null}
    </div>
  );
}

const XFER_CLAMP_CHARS = 110;
const XFER_CLAMP_LINES = 2;

function isLongXfer(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length > XFER_CLAMP_CHARS) return true;
  return trimmed.split(/\n+/).filter(Boolean).length > XFER_CLAMP_LINES;
}

function XferBody({
  text,
  agents,
  onMention,
  baseDir,
}: {
  text: string;
  agents: AgentInfo[];
  onMention?: (id: string) => void;
  baseDir?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const long = isLongXfer(text);
  const clamped = long && !expanded;
  return (
    <div className="xfer-body">
      {clamped ? (
        <div className="xfer-text is-clamped">{text.trim()}</div>
      ) : (
        <MdBody
          className="xfer-text md"
          text={text}
          agents={agents}
          onMention={onMention}
          baseDir={baseDir}
        />
      )}
      {long ? (
        <button
          type="button"
          className="xfer-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "접기" : "더 보기"}
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <path
              d="M2.2 3.6 5 6.4 7.8 3.6"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      ) : null}
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
  onApprove,
  flash = false,
}: {
  message: ChatMessage;
  agent: AgentInfo | null;
  who: string;
  agents: AgentInfo[];
  caret?: boolean;
  openName?: boolean;
  onSelectAgent?: (id: string) => void;
  onApprove?: (allow: boolean) => void;
  flash?: boolean;
}) {
  const color = agent
    ? whoColor(resolveFace(agent.id, agent.avatar_shape, agent.avatar_color).color)
    : undefined;
  const open =
    openName && onSelectAgent && agent
      ? () => onSelectAgent(agent.id)
      : undefined;
  const queued = !!m.queued;
  const parts = splitBubbles(m.text || "");
  const bubbles = parts.length ? parts : [""];
  return (
    <div
      className={
        "row them incoming" + (queued ? " queued" : "") + (flash ? " flash" : "")
      }
      data-msg-id={m.id}
    >
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
        {bubbles.map((part, i) => {
          const last = i === bubbles.length - 1;
          const stack =
            bubbles.length > 1
              ? i === 0
                ? " stack-first"
                : last
                  ? " stack-last"
                  : " stack-mid"
              : "";
          return (
            <MdBody
              key={m.id + "-" + i}
              className={
                "bubble md incoming" +
                stack +
                (caret && last ? " streaming" : "") +
                (queued ? " queued" : "")
              }
              text={part}
              agents={agents}
              onMention={onSelectAgent}
              baseDir={agent?.cwd || undefined}
            />
          );
        })}
        {queued ? <QueueWait /> : null}
        <ApprovalCard state={m.approval} onApprove={onApprove} />
      </div>
    </div>
  );
}

function ToolCardRow({
  name,
  detail,
  id,
  flash = false,
}: {
  name: string;
  detail: string;
  id?: string;
  flash?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className={"tool-card" + (flash ? " flash" : "")}
      data-msg-id={id}
    >
      <button type="button" className="tool-card-head" onClick={() => setOpen((v) => !v)}>
        <span className="tool-card-name">{name}</span>
        <span className="tool-card-chevron">{open ? "▾" : "▸"}</span>
      </button>
      {open && detail ? <div className="tool-card-body">{detail}</div> : null}
    </div>
  );
}

function ApprovalCard({
  state,
  who,
  onApprove,
}: {
  state?: ChatMessage["approval"];
  who?: string;
  onApprove?: (allow: boolean) => void;
}) {
  if (!state) return null;
  if (state === "allowed") {
    return <div className="approval-status">한 번 허용함</div>;
  }
  if (state === "denied") {
    return <div className="approval-status is-denied">거부함</div>;
  }
  if (!onApprove) return null;
  return (
    <div className="approval-card">
      <div className="approval-copy">
        {who ? `${who} · 이 작업을 진행할까요?` : "이 작업을 진행할까요?"}
      </div>
      <div className="approval-actions">
        <button type="button" className="approval-allow" onClick={() => onApprove(true)}>
          한 번 허용
        </button>
        <button type="button" className="approval-deny" onClick={() => onApprove(false)}>
          거부
        </button>
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
  onApprove,
  flash = false,
}: {
  message: ChatMessage;
  agents: AgentInfo[];
  selected: string | null;
  selectedKind: Kind;
  currentAgent: AgentInfo | null;
  caret?: boolean;
  onSelectAgent?: (id: string) => void;
  onApprove?: (allow: boolean) => void;
  flash?: boolean;
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
        onApprove={onApprove}
        flash={flash}
      />
    );
  }
  const queued = !!m.queued;
  const cls =
    "bubble md" + (caret ? " streaming" : "") + (queued ? " queued" : "");
  return (
    <div
      className={"row me" + (queued ? " queued" : "") + (flash ? " flash" : "")}
      data-msg-id={m.id}
    >
      <div className="me-msg">
        <MdBody
          className={cls}
          text={text}
          agents={agents}
          onMention={onSelectAgent}
          baseDir={currentAgent?.cwd || undefined}
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

function rowClass(
  m: ChatMessage,
  agents: AgentInfo[],
): "sent" | "received" | "routine" | "handoff" | "tool" | "user" | "assistant" | "hidden" {
  if (
    m.kind === "sent" ||
    m.kind === "received" ||
    m.kind === "routine" ||
    m.kind === "handoff" ||
    m.kind === "tool"
  ) {
    return m.kind;
  }
  if (m.role === "user") return "user";
  if (m.role === "assistant") return "assistant";
  const from = String(m.from || "");
  if (from.startsWith("to:")) return "sent";
  if (from.startsWith("#") || agents.some((a) => a.id === from)) return "received";
  return "routine";
}

function displayText(m: ChatMessage): string {
  return stripCrewMarkers(m.text || "");
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
