import { useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useT } from "../LocaleContext";
import type { TFn } from "../i18n";
import type { ReplyTarget } from "../reply";
import { splitReply } from "../reply";
import type {
  AgentInfo,
  ChannelInfo,
  ChatMessage,
  ChoiceCard as ChoiceCardData,
  ChoiceOption,
  Kind,
} from "../types";
import { busyInChannel } from "../busy";
import { resolveFace } from "../avatar";
import { splitBubbles } from "../bubbles";
import { noteRef, sentTarget } from "../peek";
import { threadRows, toolArgs, toolSummary } from "../tools";
import { clockLabels } from "../clock";
import { ChevronDown, Reply, X } from "../icons";
import { Avatar, ChannelAvatar } from "./Avatar";
import { CopyButton } from "./CopyButton";
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
  onSelectChannel?: (id: string) => void;
  onApprove?: (allow: boolean, agentId?: string) => void;
  onAnswerChoice?: (
    agentId: string,
    messageId: string,
    answers: string[][],
    values: string[][],
    closed: boolean,
  ) => void | Promise<void>;
  highlightId?: string | null;
  onHighlightDone?: () => void;
  jumpSeq?: number;
  onReply?: (target: ReplyTarget) => void;
  onJump?: (id: string) => void;
  onPeek?: (peerId: string) => void;
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
  onSelectChannel,
  onApprove,
  onAnswerChoice,
  highlightId = null,
  onHighlightDone,
  jumpSeq = 0,
  onReply,
  onJump,
  onPeek,
}: Props) {
  const { locale, t } = useLocale();
  const ref = useRef<HTMLDivElement>(null);
  const [away, setAway] = useState(false);
  const visible = visibleMessages(messages);
  const rows = threadRows(visible, agents);
  // Keyed by message id, not by row index: a filter or an inserted row would
  // slide a parallel array one place and stamp every message with its
  // neighbour's time, silently.
  const clocks = useMemo(() => {
    // Only balloons carry a clock; a tool run or a folded note passes 0 so it
    // cannot swallow the stamp of the minute it sits in. The daemon writes a
    // human's `crew tell` as a system row from `user`, and that still draws as
    // a balloon.
    const stamped = rows.map((r) =>
      r.kind === "msg" && (r.msg.role !== "system" || r.msg.from === "user")
        ? r.msg
        : null,
    );
    const labels = clockLabels(
      stamped.map((m) => m?.ts ?? 0),
      locale,
    );
    const map = new Map<string, string>();
    stamped.forEach((m, i) => {
      if (m && labels[i]) map.set(m.id, labels[i]);
    });
    return map;
  }, [rows, locale]);
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

  // Bring the hit on screen. `messages` is a dependency because the row may
  // not be mounted yet when the id arrives.
  useEffect(() => {
    if (!highlightId) return;
    const root = ref.current;
    if (!root) return;
    const el = root.querySelector(
      `[data-msg-id="${CSS.escape(highlightId)}"]`,
    ) as HTMLElement | null;
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [highlightId, messages]);

  // Expiry is its own effect on its own clock. Sharing the one above meant a
  // streaming thread re-armed the timer on every tick, so a flashed note never
  // stopped flashing and the scroll kept snapping back.
  const doneRef = useRef(onHighlightDone);
  doneRef.current = onHighlightDone;
  useEffect(() => {
    if (!highlightId) return;
    const t = window.setTimeout(() => doneRef.current?.(), 1600);
    return () => window.clearTimeout(t);
  }, [highlightId]);

  return (
    <div className="thread-wrap">
      <div className="thread" ref={ref} onScroll={syncStick}>
        {!messages.length ? (
          <EmptyChat agent={currentAgent} channel={currentChannel} agents={agents} />
        ) : (
          rows.map((row) => {
            if (row.kind === "tools") {
              return (
                <ToolGroup
                  key={row.msgs[0].id}
                  items={row.msgs}
                  highlightId={highlightId}
                />
              );
            }
            if (row.kind === "notes") {
              return (
                <NoteGroup
                  key={row.msgs[0].id}
                  peerId={row.peerId}
                  items={row.msgs}
                  agents={agents}
                  channels={channels}
                  selectedKind={selectedKind}
                  onSelectAgent={openAgent}
                  onSelectChannel={onSelectChannel}
                  onReply={onReply}
                  onJump={onJump}
                  onPeek={onPeek}
                  highlightId={highlightId}
                />
              );
            }
            const m = row.msg;
            const caret =
              streaming &&
              m.role === "assistant" &&
              m.id === lastVisible?.id;
            const flash = highlightId === m.id;
            if (m.role === "system" && m.from !== "user") {
              return (
                <SystemOrIncoming
                  key={m.id}
                  message={m}
                  agents={agents}
                  channels={channels}
                  selectedKind={selectedKind}
                  onSelectAgent={openAgent}
                  onSelectChannel={onSelectChannel}
                  onReply={onReply}
                  onJump={onJump}
                  onPeek={onPeek}
                  flash={flash}
                />
              );
            }
            return (
              <Bubble
                key={m.id}
                clock={clocks.get(m.id)}
                message={m}
                agents={agents}
                channels={channels}
                selected={selected}
                selectedKind={selectedKind}
                currentAgent={currentAgent}
                caret={caret}
                onSelectAgent={openAgent}
                onSelectChannel={onSelectChannel}
                onApprove={
                  onApprove
                    ? (allow) => onApprove(allow, m.from)
                    : undefined
                }
                onAnswerChoice={
                  onAnswerChoice
                    ? (answers, values, closed) =>
                        onAnswerChoice(m.from, m.id, answers, values, closed)
                    : undefined
                }
                onReply={onReply}
                onJump={onJump}
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
            channels={channels}
            caret
            openName={selectedKind === "channel"}
            onSelectAgent={openAgent}
            onSelectChannel={onSelectChannel}
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
          title={t("thread.jumpBottom")}
          aria-label={t("thread.jumpBottom")}
          onClick={jumpBottom}
        >
          <ChevronDown size={18} />
        </button>
      ) : null}
    </div>
  );
}

function EmptyChat({
  agent,
  channel,
  agents,
}: {
  agent: AgentInfo | null;
  channel: ChannelInfo | null;
  agents: AgentInfo[];
}) {
  const t = useT();
  if (channel) {
    return (
      <div className="empty-chat">
        <ChannelAvatar channel={channel} agents={agents} />
        <strong>{channel.name || channel.id}</strong>
        <span>{t("thread.startChannel")}</span>
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
        <span>{t("thread.startChat")}</span>
      </div>
    );
  }
  return <div className="empty-chat">{t("thread.pickChat")}</div>;
}

function SystemOrIncoming({
  message: m,
  agents,
  channels,
  selectedKind,
  onSelectAgent,
  onSelectChannel,
  onReply,
  onJump,
  onPeek,
  flash = false,
}: {
  message: ChatMessage;
  agents: AgentInfo[];
  channels: ChannelInfo[];
  selectedKind: Kind;
  onSelectAgent?: (id: string) => void;
  onSelectChannel?: (id: string) => void;
  onReply?: (target: ReplyTarget) => void;
  onJump?: (id: string) => void;
  onPeek?: (peerId: string) => void;
  flash?: boolean;
}) {
  const t = useT();
  if (m.from === "user") {
    return (
      <Bubble
        message={{ ...m, role: "user" }}
        agents={agents}
        channels={channels}
        selected={null}
        selectedKind={selectedKind}
        currentAgent={null}
        onSelectAgent={onSelectAgent}
        onSelectChannel={onSelectChannel}
        onReply={onReply}
        onJump={onJump}
        flash={flash}
      />
    );
  }
  const from = String(m.from || "");
  if (from === "crew") {
    // A note the daemon wrote about the conversation itself, not a bot speaking.
    return (
      <div className={"sys-note" + (flash ? " flash" : "")} data-msg-id={m.id}>
        {displayText(m)}
      </div>
    );
  }
  const note = noteRef(m, agents);
  if (note) {
    return (
      <TransferNote
        kind={note.kind}
        otherId={note.otherId}
        message={{ ...m, text: displayText(m) }}
        agents={agents}
        channels={channels}
        onSelectAgent={onSelectAgent}
        onSelectChannel={onSelectChannel}
        onReply={onReply}
        onJump={onJump}
        onPeek={onPeek}
        flash={flash}
      />
    );
  }
  return (
    <div
      className={"sys" + (m.queued ? " queued" : "") + (flash ? " flash" : "")}
      data-msg-id={m.id}
    >
      <div className="sys-from">{t("thread.routineFrom", { from: m.from || "" })}</div>
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
  onSelectChannel,
  onReply,
  onJump,
  onPeek,
  flash = false,
}: {
  kind: "sent" | "received" | "handoff";
  otherId: string;
  message: ChatMessage;
  agents: AgentInfo[];
  channels: ChannelInfo[];
  onSelectAgent?: (id: string) => void;
  onSelectChannel?: (id: string) => void;
  onReply?: (target: ReplyTarget) => void;
  onJump?: (id: string) => void;
  onPeek?: (peerId: string) => void;
  flash?: boolean;
}) {
  const fromChannel = otherId.startsWith("#");
  const agent = agents.find((a) => a.id === otherId) ?? null;
  const who = fromChannel
    ? `#${channelDisplayName(otherId, channels)}`
    : displayWho({ ...m, from: otherId }, agent);
  const open =
    onSelectAgent && agent ? () => onSelectAgent(agent.id) : undefined;
  const t = useT();
  const [openBody, setOpenBody] = useState(false);
  const label =
    kind === "sent"
      ? t("thread.sent")
      : kind === "handoff"
        ? t("thread.handoff")
        : t("thread.received");
  const { reply, body } = splitReply(m.text || "");
  // A search hit has to be readable without a click.
  const show = openBody || flash;
  return (
    <div
      className={"xfer" + (m.queued ? " queued" : "") + (flash ? " flash" : "")}
      data-msg-id={m.id}
    >
      <div className="xfer-chip">
        {m.text ? (
          <button
            type="button"
            className="xfer-label is-toggle"
            aria-expanded={show}
            onClick={() => setOpenBody(!openBody)}
          >
            <span className="note-caret">{show ? "\u25be" : "\u25b8"}</span>
            {label}
          </button>
        ) : (
          <span className="xfer-label">{label}</span>
        )}
        <WhoButton
          agent={agent}
          who={who}
          fallbackId={otherId}
          onClick={open}
        />
      </div>
      {show ? (
        <>
          {/* `.msg-actions` is absolutely positioned, so it leads here to sit
              early in the tab order rather than behind every link in the body. */}
          <MsgActions
            copy={body.trim()}
            onReply={
              onReply && body.trim()
                ? () => onReply(makeReply({ ...m, from: otherId }, agents, t))
                : undefined
            }
          />
          {reply ? (
            <ReplyQuote reply={reply} agents={agents} onJump={onJump} />
          ) : null}
          {body ? (
            <XferBody
              text={body}
              agents={agents}
              channels={channels}
              onMention={onSelectAgent}
              onChannel={onSelectChannel}
              baseDir={agent?.cwd || undefined}
            />
          ) : null}
          {onPeek && agent ? (
            <button
              type="button"
              className="xfer-peek"
              onClick={() => onPeek(agent.id)}
            >
              {t("thread.viewFull")}
            </button>
          ) : null}
        </>
      ) : null}
      {m.queued ? <QueueWait /> : null}
    </div>
  );
}

function XferBody({
  text,
  agents,
  channels = [],
  onMention,
  onChannel,
  baseDir,
}: {
  text: string;
  agents: AgentInfo[];
  channels?: ChannelInfo[];
  onMention?: (id: string) => void;
  onChannel?: (id: string) => void;
  baseDir?: string;
}) {
  return (
    <div className="xfer-body">
      <MdBody
        className="xfer-text md"
        text={text}
        agents={agents}
        channels={channels}
        onMention={onMention}
        onChannel={onChannel}
        baseDir={baseDir}
      />
    </div>
  );
}

function Incoming({
  message: m,
  agent,
  who,
  agents,
  channels = [],
  caret = false,
  openName = true,
  onSelectAgent,
  onSelectChannel,
  onApprove,
  onAnswerChoice,
  onReply,
  onJump,
  flash = false,
  clock,
}: {
  message: ChatMessage;
  agent: AgentInfo | null;
  who: string;
  agents: AgentInfo[];
  channels?: ChannelInfo[];
  caret?: boolean;
  openName?: boolean;
  onSelectAgent?: (id: string) => void;
  onSelectChannel?: (id: string) => void;
  onApprove?: (allow: boolean) => void;
  onAnswerChoice?: (
    answers: string[][],
    values: string[][],
    closed: boolean,
  ) => void | Promise<void>;
  onReply?: (target: ReplyTarget) => void;
  onJump?: (id: string) => void;
  flash?: boolean;
  clock?: string;
}) {
  const color = agent
    ? whoColor(resolveFace(agent.id, agent.avatar_shape, agent.avatar_color).color)
    : undefined;
  const open =
    openName && onSelectAgent && agent
      ? () => onSelectAgent(agent.id)
      : undefined;
  const t = useT();
  const queued = !!m.queued;
  const { reply, body } = splitReply(m.text || "");
  const parts = splitBubbles(body);
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
        {reply ? <ReplyQuote reply={reply} agents={agents} onJump={onJump} /> : null}
        {parts.length
          ? parts.map((part, i) => {
              const last = i === parts.length - 1;
              const stack =
                parts.length > 1
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
                  channels={channels}
                  onMention={onSelectAgent}
                  onChannel={onSelectChannel}
                  baseDir={agent?.cwd || undefined}
                />
              );
            })
          : caret
            ? (
                <MdBody
                  className={
                    "bubble md incoming streaming" + (queued ? " queued" : "")
                  }
                  text=""
                  agents={agents}
                  channels={channels}
                  onMention={onSelectAgent}
                  onChannel={onSelectChannel}
                  baseDir={agent?.cwd || undefined}
                />
              )
            : null}
        {queued ? <QueueWait /> : null}
        {m.choice ? (
          <ChoiceCard
            key={m.choice.id}
            card={m.choice}
            onAnswer={onAnswerChoice}
          />
        ) : null}
        <ApprovalCard state={m.approval} onApprove={onApprove} />
        <MsgActions
          copy={body.trim()}
          onReply={
            onReply && body.trim()
              ? () => onReply(makeReply({ ...m, text: body }, agents, t))
              : undefined
          }
        />
      </div>
      {clock ? (
        <time className="msg-clock" dateTime={new Date(m.ts).toISOString()}>
          {clock}
        </time>
      ) : null}
    </div>
  );
}

function NoteGroup({
  peerId,
  items,
  agents,
  channels,
  selectedKind,
  onSelectAgent,
  onSelectChannel,
  onReply,
  onJump,
  onPeek,
  highlightId = null,
}: {
  peerId: string;
  items: ChatMessage[];
  agents: AgentInfo[];
  channels: ChannelInfo[];
  selectedKind: Kind;
  onSelectAgent?: (id: string) => void;
  onSelectChannel?: (id: string) => void;
  onReply?: (target: ReplyTarget) => void;
  onJump?: (id: string) => void;
  onPeek?: (peerId: string) => void;
  highlightId?: string | null;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const hit = items.some((m) => m.id === highlightId);
  // A search hit inside a folded run has to be on screen to be highlighted.
  const show = open || hit;
  // One note is not a run. The row is still a run so that a reply arriving
  // does not change the element type and remount the note under the reader.
  const folds = items.length > 1;
  const fromChannel = peerId.startsWith("#");
  const agent = agents.find((a) => a.id === peerId) ?? null;
  const who = fromChannel
    ? `#${channelDisplayName(peerId, channels)}`
    : displayWho({ from: peerId } as ChatMessage, agent);
  const queued = items.some((m) => m.queued);
  return (
    <div className={"note-run" + (queued ? " queued" : "")}>
      {folds ? (
        <div className="note-run-chip">
          <button
            type="button"
            className="note-run-head"
            aria-expanded={show}
            onClick={() => setOpen(!open)}
          >
            <span className="note-caret">{show ? "\u25be" : "\u25b8"}</span>
            {t("thread.noteRun", { n: items.length })}
          </button>
          <WhoButton
            agent={agent}
            who={who}
            fallbackId={peerId}
            onClick={
              onSelectAgent && agent ? () => onSelectAgent(agent.id) : undefined
            }
          />
        </div>
      ) : null}
      {folds && !show && queued ? <QueueWait /> : null}
      {!folds || show
        ? items.map((m) => (
            <SystemOrIncoming
              key={m.id}
              message={m}
              agents={agents}
              channels={channels}
              selectedKind={selectedKind}
              onSelectAgent={onSelectAgent}
              onSelectChannel={onSelectChannel}
              onReply={onReply}
              onJump={onJump}
              onPeek={onPeek}
              flash={highlightId === m.id}
            />
          ))
        : null}
    </div>
  );
}

function ToolGroup({
  items,
  highlightId = null,
}: {
  items: ChatMessage[];
  highlightId?: string | null;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const hit = items.some((m) => m.id === highlightId);
  // A search hit inside a folded run has to be on screen to be highlighted.
  const show = open || hit;
  return (
    <div className="tool-run">
      <button
        type="button"
        className="tool-run-head"
        aria-expanded={show}
        onClick={() => setOpen(!open)}
      >
        <span className="note-caret">{show ? "\u25be" : "\u25b8"}</span>
        {t("thread.toolUsed", { n: items.length })}
      </button>
      {show ? (
        <div className="tool-run-list">
          {items.map((m) => (
            <ToolRow key={m.id} message={m} flash={highlightId === m.id} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ToolRow({
  message,
  flash = false,
}: {
  message: ChatMessage;
  flash?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const name = message.from || "tool";
  const detail = displayText(message).trim();
  const args = toolArgs(detail);
  const summary = toolSummary(detail);
  return (
    <div
      className={"tool-row" + (flash ? " flash" : "")}
      data-msg-id={message.id}
    >
      <button
        type="button"
        className="tool-row-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="note-caret">{open ? "\u25be" : "\u25b8"}</span>
        <span className="tool-row-name">{name}</span>
        <span className="tool-row-summary">{open ? "" : summary}</span>
      </button>
      {open ? (
        <dl className="tool-args">
          {args.length ? (
            args.map((a, i) => (
              <div className="tool-arg" key={a.key || i}>
                {a.key ? <dt>{a.key}</dt> : null}
                <dd>{a.value}</dd>
              </div>
            ))
          ) : (
            <div className="tool-arg">
              <dd className="is-empty">{t("thread.toolEmpty")}</dd>
            </div>
          )}
        </dl>
      ) : null}
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
  const t = useT();
  if (!state) return null;
  if (state === "allowed") {
    return <div className="approval-status">{t("thread.allowed")}</div>;
  }
  if (state === "denied") {
    return <div className="approval-status is-denied">{t("thread.denied")}</div>;
  }
  if (!onApprove) return null;
  return (
    <div className="approval-card">
      <div className="approval-copy">
        {who ? t("thread.approveAskWho", { who }) : t("thread.approveAsk")}
      </div>
      <div className="approval-actions">
        <button type="button" className="approval-allow" onClick={() => onApprove(true)}>
          {t("thread.allowOnce")}
        </button>
        <button type="button" className="approval-deny" onClick={() => onApprove(false)}>
          {t("thread.deny")}
        </button>
      </div>
    </div>
  );
}

function ChoiceCard({
  card,
  onAnswer,
}: {
  card: ChoiceCardData;
  onAnswer?: (
    answers: string[][],
    values: string[][],
    closed: boolean,
  ) => void | Promise<void>;
}) {
  const t = useT();
  const questions = card.questions || [];
  const pending = card.state === "pending";
  const hasFields = questions.some((q) => (q.fields || []).length > 0);
  const needsSubmit =
    questions.length > 1 || questions.some((q) => q.multi) || hasFields;
  const [picks, setPicks] = useState<string[][]>(() =>
    questions.map((q) => q.selected || []),
  );
  const [values, setValues] = useState<string[][]>(() =>
    questions.map((q) => (q.fields || []).map((f) => f.value || "")),
  );
  const [sent, setSent] = useState(false);
  const open = pending && !sent;

  function toggle(qi: number, id: string, multi: boolean) {
    if (!open || !onAnswer) return;
    const next = picks.map((row, i) => {
      if (i !== qi) return row;
      if (multi) {
        return row.includes(id) ? row.filter((x) => x !== id) : [...row, id];
      }
      return [id];
    });
    setPicks(next);
    if (!needsSubmit && !multi) void send(next, values, false);
  }

  function setField(qi: number, fi: number, next: string) {
    if (!open || !onAnswer) return;
    setValues((prev) =>
      questions.map((q, i) => {
        const row = prev[i] || (q.fields || []).map((f) => f.value || "");
        if (i !== qi) return row;
        return (q.fields || []).map((f, j) =>
          j === fi ? next : row[j] || f.value || "",
        );
      }),
    );
  }

  function complete(nextPicks = picks, nextValues = values) {
    const allOk = questions.every((q, qi) => {
      const fields = q.fields || [];
      const fieldOk = fields.every((f, fi) => {
        if (f.required === false) return true;
        return (nextValues[qi]?.[fi] || "").trim() !== "";
      });
      const optOk = !(q.options || []).length || (nextPicks[qi] || []).length > 0;
      return fieldOk && optOk;
    });
    const any = questions.some((_, qi) => {
      const fields = questions[qi].fields || [];
      return (
        (nextPicks[qi] || []).length > 0 ||
        (nextValues[qi] || []).some((v) => v.trim()) ||
        (fields.length > 0 && fields.every((f) => f.required === false))
      );
    });
    return allOk && any;
  }

  function submit() {
    if (!open || !onAnswer) return;
    if (!complete()) return;
    void send(picks, values, false);
  }

  async function send(
    answers: string[][],
    fieldValues: string[][],
    closed: boolean,
  ) {
    if (!onAnswer) return;
    setSent(true);
    try {
      await onAnswer(answers, fieldValues, closed);
    } catch {
      setSent(false);
    }
  }

  return (
    <div className={"choice-card is-" + card.state}>
      {questions.map((q, qi) => {
        const header = (q.header || q.question || "").trim();
        const hint =
          (q.hint || "").trim() ||
          (q.header &&
          q.question &&
          q.header.trim() !== q.question.trim()
            ? q.question.trim()
            : "");
        const selected = pending ? picks[qi] || [] : q.selected || [];
        const fields = q.fields || [];
        const fieldValues = values[qi] || fields.map((f) => f.value || "");
        const showFields = fields.length > 0 && card.state !== "closed";
        const showList =
          (q.options || []).length > 0 &&
          (open ||
            (card.state === "answered" && (q.multi || questions.length > 1)));
        const picked = (q.options || []).filter((o) => selected.includes(o.id));
        return (
          <div className="choice-q" key={q.question + qi}>
            <div className="choice-head">
              <div className="choice-title">{header}</div>
              {open && onAnswer && !hasFields ? (
                <button
                  type="button"
                  className="choice-x"
                  title={t("thread.choiceClose")}
                  aria-label={t("thread.choiceClose")}
                  onClick={() => void send(picks, values, true)}
                >
                  <X size={14} />
                </button>
              ) : null}
              {card.state === "closed" ? (
                <span className="choice-closed">{t("thread.choiceClosed")}</span>
              ) : null}
            </div>
            {hint && card.state !== "closed" ? (
              <MdBody className="choice-hint md" text={hint} agents={[]} />
            ) : null}
            {showFields ? (
              <div className="choice-fields">
                {fields.map((f, fi) => {
                  const required = f.required !== false;
                  const id = `${card.id}-${qi}-${f.id || fi}`;
                  return (
                    <label className="choice-field" key={f.id || fi} htmlFor={id}>
                      <span className="choice-field-label">
                        {f.label}
                        {required ? (
                          <span className="choice-req"> *</span>
                        ) : null}
                      </span>
                      <input
                        id={id}
                        className="textin choice-input"
                        type={f.secret ? "password" : "text"}
                        value={fieldValues[fi] || ""}
                        disabled={!open || !onAnswer}
                        autoComplete="off"
                        onChange={(e) => setField(qi, fi, e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key !== "Enter" || e.nativeEvent.isComposing) {
                            return;
                          }
                          e.preventDefault();
                          submit();
                        }}
                      />
                    </label>
                  );
                })}
              </div>
            ) : null}
            {showList ? (
              <div className="choice-list">
                {(q.options || []).map((o, oi) => {
                  const view = optionView(o, oi);
                  const on = selected.includes(o.id);
                  return (
                    <button
                      type="button"
                      key={o.id}
                      className={"choice-option" + (on ? " is-on" : "")}
                      disabled={!open || !onAnswer}
                      onClick={() => toggle(qi, o.id, !!q.multi)}
                    >
                      <span className="choice-badge">{view.badge}</span>
                      {view.title || view.sub ? (
                        <span className="choice-copy">
                          {view.title ? (
                            <span className="choice-label">{view.title}</span>
                          ) : null}
                          {view.sub ? (
                            <span className="choice-desc">{view.sub}</span>
                          ) : null}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ) : picked.length ? (
              <div className="choice-picked">
                {picked.map((o, oi) => {
                  const view = optionView(o, oi);
                  return (
                    <div className="choice-option is-on" key={o.id}>
                      <span className="choice-badge">{view.badge}</span>
                      {view.title ? (
                        <span className="choice-copy">
                          <span className="choice-label">{view.title}</span>
                        </span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        );
      })}
      {open && needsSubmit && onAnswer ? (
        <div className={"choice-foot" + (hasFields ? " is-form" : "")}>
          <button
            type="button"
            className="choice-submit"
            disabled={!complete()}
            onClick={submit}
          >
            {t(hasFields ? "thread.choiceContinue" : "thread.choiceSubmit")}
          </button>
          {hasFields ? (
            <button
              type="button"
              className="choice-dismiss"
              onClick={() => void send(picks, values, true)}
            >
              {t("thread.choiceDismiss")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function optionView(o: ChoiceOption, i: number) {
  const label = (o.label || "").trim() || String.fromCharCode(65 + i);
  const desc = (o.description || "").trim();
  const short = label.length <= 3;
  const badge = short ? label : String.fromCharCode(65 + (i % 26));
  const title = short ? desc : label;
  const sub = !short && desc && desc !== label ? desc : null;
  return { badge, title, sub };
}

function Bubble({
  message: m,
  agents,
  channels = [],
  selected,
  selectedKind,
  currentAgent,
  caret = false,
  onSelectAgent,
  onSelectChannel,
  onApprove,
  onAnswerChoice,
  onReply,
  onJump,
  flash = false,
  clock,
}: {
  message: ChatMessage;
  agents: AgentInfo[];
  channels?: ChannelInfo[];
  selected: string | null;
  selectedKind: Kind;
  currentAgent: AgentInfo | null;
  caret?: boolean;
  onSelectAgent?: (id: string) => void;
  onSelectChannel?: (id: string) => void;
  onApprove?: (allow: boolean) => void;
  onAnswerChoice?: (
    answers: string[][],
    values: string[][],
    closed: boolean,
  ) => void | Promise<void>;
  onReply?: (target: ReplyTarget) => void;
  onJump?: (id: string) => void;
  flash?: boolean;
  clock?: string;
}) {
  const t = useT();
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
        channels={channels}
        caret={caret}
        openName={!self}
        onSelectAgent={onSelectAgent}
        onSelectChannel={onSelectChannel}
        onApprove={onApprove}
        onAnswerChoice={onAnswerChoice}
        onReply={onReply}
        onJump={onJump}
        flash={flash}
        clock={clock}
      />
    );
  }
  const queued = !!m.queued;
  const { reply, body } = splitReply(text);
  const cls =
    "bubble md" + (caret ? " streaming" : "") + (queued ? " queued" : "");
  return (
    <div
      className={"row me" + (queued ? " queued" : "") + (flash ? " flash" : "")}
      data-msg-id={m.id}
    >
      {clock ? (
        <time className="msg-clock" dateTime={new Date(m.ts).toISOString()}>
          {clock}
        </time>
      ) : null}
      <div className="me-msg">
        {reply ? <ReplyQuote reply={reply} agents={agents} onJump={onJump} /> : null}
        {body.trim() ? (
          <MdBody
            className={cls}
            text={body}
            agents={agents}
            channels={channels}
            onMention={onSelectAgent}
            onChannel={onSelectChannel}
            baseDir={currentAgent?.cwd || undefined}
          />
        ) : null}
        {queued ? <QueueWait /> : null}
        <MsgActions
          copy={body.trim()}
          onReply={
            onReply && body.trim()
              ? () => onReply(makeReply({ ...m, text: body }, agents, t))
              : undefined
          }
        />
      </div>
    </div>
  );
}

function QueueWait() {
  const t = useT();
  return (
    <div className="queue-wait" aria-label={t("thread.queueing")}>
      <span className="queue-wait-text">{t("thread.queueing")}</span>
      <span className="queue-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    </div>
  );
}

function makeReply(m: ChatMessage, agents: AgentInfo[], t: TFn): ReplyTarget {
  const text = splitReply(m.text || "").body.trim();
  const agent = agents.find((a) => a.id === m.from) ?? null;
  const who =
    m.role === "user" || m.from === "user"
      ? t("thread.you")
      : displayWho(m, agent);
  return { id: m.id, from: m.from || "user", who, text };
}

function quoteWho(from: string, agents: AgentInfo[], t: TFn): string {
  if (from === "user") return t("thread.you");
  const sent = sentTarget(from);
  if (sent) {
    const agent = agents.find((a) => a.id === sent);
    return agent ? agent.name || agent.id : sent;
  }
  const agent = agents.find((a) => a.id === from);
  return agent ? agent.name || agent.id : from;
}

function ReplyQuote({
  reply,
  agents,
  onJump,
}: {
  reply: { id: string; from: string; snippet: string };
  agents: AgentInfo[];
  onJump?: (id: string) => void;
}) {
  const t = useT();
  return (
    <button
      type="button"
      className="reply-quote"
      title={t("thread.jumpToReply")}
      onClick={() => onJump?.(reply.id)}
    >
      <span className="reply-quote-who">{quoteWho(reply.from, agents, t)}</span>
      <span className="reply-quote-text">{reply.snippet}</span>
    </button>
  );
}

function MsgActions({
  copy,
  onReply,
}: {
  copy?: string;
  onReply?: () => void;
}) {
  if (!copy && !onReply) return null;
  return (
    <div className="msg-actions">
      {onReply ? <ReplyButton onClick={onReply} /> : null}
      {copy ? <CopyButton text={copy} /> : null}
    </div>
  );
}

function ReplyButton({ onClick }: { onClick: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      className="copy-btn"
      title={t("thread.reply")}
      aria-label={t("thread.reply")}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <Reply size={13} />
    </button>
  );
}

function displayWho(m: ChatMessage, agent: AgentInfo | null): string {
  if (agent) return agent.name || agent.id;
  return m.from || "";
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

function displayText(m: ChatMessage): string {
  return stripCrewMarkers(m.text || "");
}

function visibleMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((m, i) => {
    if (m.role !== "assistant") return true;
    const raw = m.text || "";
    if (isEnvelopeEcho(raw, messages[i - 1])) return false;
    if (isPlainEcho(raw, messages, i)) return false;
    return stripCrewMarkers(raw).length > 0 || !!m.choice;
  });
}
