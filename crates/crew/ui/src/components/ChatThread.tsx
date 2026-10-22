import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ARRIVE_MS, playArrive, useArriving } from "../arrive";
import { useLocale, useT } from "../LocaleContext";
import type { TFn } from "../i18n";
import type { ReplyTarget } from "../reply";
import { splitReply } from "../reply";
import type {
  AgentInfo,
  ChatMessage,
  ChoiceCard as ChoiceCardData,
  ChoiceOption,
  Kind,
} from "../types";
import { resolveFace } from "../avatar";
import { splitBubbles } from "../bubbles";
import { messageDefinitions } from "../markdown";
import { displayWho, noteRef, sentTarget } from "../peek";
import {
  dotsAfter,
  momentStamp,
  runPeer,
  threadRows,
  toolArgs,
  toolNames,
  toolSummary,
  type ThreadRow,
} from "../tools";
import { clockLabels } from "../clock";
import { ChevronDown, Reply, X } from "../icons";
import { Avatar } from "./Avatar";
import { CopyButton } from "./CopyButton";
import { MdBody } from "./MdBody";
import { WhoButton, whoColor } from "./WhoButton";

const STICK_PX = 24;

function rowKey(row: ThreadRow): string {
  if (row.kind === "msg") return row.msg.id;
  return row.msgs[0].id;
}

function MsgSlot({
  id,
  start,
  typing = false,
  children,
}: {
  id: string;
  start: number | null;
  typing?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (start === null || !el) return;
    return playArrive(el, start);
  }, [id, start]);
  return (
    <div
      className="msg-slot"
      data-typing-slot={typing ? "" : undefined}
      ref={ref}
    >
      <div className="msg-grow">{children}</div>
    </div>
  );
}

type Props = {
  messages: ChatMessage[];
  agents: AgentInfo[];
  selected: string | null;
  selectedKind: Kind;
  currentAgent: AgentInfo | null;
  stick: boolean;
  onStick: (stick: boolean) => void;
  streaming?: boolean;
  onSelectAgent?: (id: string) => void;
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
  /** First id of the run open in the side panel, if any. */
  peekFocus?: string | null;
  onPeek?: (peerId: string, focus?: string[]) => void;
  showTools?: boolean;
};

export function ChatThread({
  messages,
  agents,
  selected,
  selectedKind,
  currentAgent,
  stick,
  onStick,
  streaming = false,
  onSelectAgent,
  onApprove,
  onAnswerChoice,
  highlightId = null,
  onHighlightDone,
  jumpSeq = 0,
  onReply,
  onJump,
  peekFocus = null,
  onPeek,
  showTools = false,
}: Props) {
  const { locale, t } = useLocale();
  const ref = useRef<HTMLDivElement>(null);
  const [away, setAway] = useState(false);
  const visible = visibleMessages(messages, showTools);
  const all = threadRows(visible, agents);
  // A bot that has only talked with other bots has no conversation here: the
  // thread stays empty, and its side chat opens beside it (`sideOnlyPeer`).
  const direct = all.some((row) => row.kind === "msg");
  const rows = direct ? all : [];
  // Keyed by row id, not by index: a filter or an inserted row would slide a
  // parallel array and stamp the wrong stretch.
  const clocks = useMemo(() => {
    const stamps = rows.map(momentStamp);
    const labels = clockLabels(stamps, locale);
    const map = new Map<string, { ts: number; label: string }>();
    rows.forEach((row, i) => {
      if (labels[i]) map.set(rowKey(row), { ts: stamps[i], label: labels[i] });
    });
    return map;
  }, [rows, locale]);
  const openAgent =
    onSelectAgent &&
    ((id: string) => {
      if (selectedKind === "agent" && selected === id) return;
      onSelectAgent(id);
    });
  const lastVisible = dotsAfter(visible);
  function workingPlaceholders(): AgentInfo[] {
    const live = streaming && currentAgent ? [currentAgent] : [];
    return live.filter((a) => {
      // A reply folded beside the thread has no bubble here to carry the dots.
      if (
        lastVisible?.role === "assistant" &&
        lastVisible.from === a.id &&
        !runPeer(lastVisible, agents)
      ) {
        return false;
      }
      return true;
    });
  }
  function blockedCards(): AgentInfo[] {
    const live =
      currentAgent?.status === "blocked" ? [currentAgent] : [];
    return live.filter(
      (a) => !messages.some((m) => m.from === a.id && m.approval === "pending"),
    );
  }

  // Without a conversation here, a turn can only be for a side chat.
  const placeholders = direct ? workingPlaceholders() : [];
  const blocked = blockedCards();
  // An approval card means it is waiting on the reader here, and "start a
  // chat" would contradict it.
  const empty = !direct && !blocked.length;
  const arrive = useArriving(
    [
      ...rows.map(rowKey),
      ...placeholders.map((agent) => "working-" + agent.id),
    ],
    () => {
      // Still on screen during this render, so this is the height the reader
      // sees, including a typing row that has only partly opened.
      const live = ref.current?.querySelector("[data-typing-slot]");
      return live instanceof HTMLElement ? live.getBoundingClientRect().height : 0;
    },
  );

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
  }, [
    messages,
    stick,
    selected,
    selectedKind,
    streaming,
    highlightId,
    showTools,
  ]);

  // The entrance grows the row after this commit. Follow it to the bottom
  // unless the reader has already moved up.
  useLayoutEffect(() => {
    if (!stick || highlightId || arrive.size === 0) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const el = ref.current;
    if (!el) return;
    const until = performance.now() + ARRIVE_MS;
    let locked = el.scrollTop;
    let raf = 0;
    const tick = (now: number) => {
      const node = ref.current;
      if (!node || now >= until) return;
      if (node.scrollTop < locked - 1) return;
      node.scrollTop = node.scrollHeight;
      locked = node.scrollTop;
      raf = requestAnimationFrame(tick);
    };
    el.scrollTop = el.scrollHeight;
    locked = el.scrollTop;
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [arrive, stick, highlightId]);

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
        {rows.map((row) => {
          const id = rowKey(row);
          let node: ReactNode;
          if (row.kind === "tools") {
            node = (
              <ToolGroup
                key={id}
                items={row.msgs}
                highlightId={highlightId}
              />
            );
          } else if (row.kind === "notes") {
            node = (
              <NoteGroup
                key={id}
                peerId={row.peerId}
                items={row.msgs}
                agents={agents}
                selectedKind={selectedKind}
                onSelectAgent={openAgent}
                onReply={onReply}
                onJump={onJump}
                peekFocus={peekFocus}
                onPeek={onPeek}
                highlightId={highlightId}
              />
            );
          } else {
            const m = row.msg;
            // Dots sit under the reply that is arriving, from the first
            // tokens until the turn ends.
            const caret =
              streaming &&
              m.role === "assistant" &&
              m.id === lastVisible?.id;
            const flash = highlightId === m.id;
            node =
              m.role === "system" && m.from !== "user" ? (
                <SystemOrIncoming
                  key={id}
                  message={m}
                  agents={agents}
                  selectedKind={selectedKind}
                  onSelectAgent={openAgent}
                  onReply={onReply}
                  onJump={onJump}
                  peekFocus={peekFocus}
                  onPeek={onPeek}
                  flash={flash}
                />
              ) : (
                <Bubble
                  key={id}
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
          }
          const time = clocks.get(id);
          const start = arrive.get(id);
          return (
            <MsgSlot
              key={id}
              id={id}
              start={start === undefined ? null : start}
            >
              {time ? <ThreadTime ts={time.ts} label={time.label} /> : null}
              {node}
            </MsgSlot>
          );
        })}
        {empty ? <EmptyChat agent={currentAgent} /> : null}
        {placeholders.map((agent) => {
          const id = "working-" + agent.id;
          const start = arrive.get(id);
          return (
            <MsgSlot
              key={id}
              id={id}
              start={start === undefined ? null : start}
              typing
            >
              <Incoming
                message={{
                  id,
                  role: "assistant",
                  from: agent.id,
                  text: "",
                  ts: 0,
                }}
                agent={agent}
                who={agent.name || agent.id}
                agents={agents}
                caret
                openName={false}
                onSelectAgent={openAgent}
              />
            </MsgSlot>
          );
        })}
        {blocked.map((agent) => (
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

function EmptyChat({ agent }: { agent: AgentInfo | null }) {
  const t = useT();
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
  selectedKind,
  onSelectAgent,
  onReply,
  onJump,
  peekFocus = null,
  onPeek,
  flash = false,
}: {
  message: ChatMessage;
  agents: AgentInfo[];
  selectedKind: Kind;
  onSelectAgent?: (id: string) => void;
  onReply?: (target: ReplyTarget) => void;
  onJump?: (id: string) => void;
  peekFocus?: string | null;
  onPeek?: (peerId: string, focus?: string[]) => void;
  flash?: boolean;
}) {
  const t = useT();
  if (m.from === "user") {
    return (
      <Bubble
        message={{ ...m, role: "user" }}
        agents={agents}
        selected={null}
        selectedKind={selectedKind}
        currentAgent={null}
        onSelectAgent={onSelectAgent}
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
        onSelectAgent={onSelectAgent}
        onReply={onReply}
        onJump={onJump}
        peeking={peekFocus === m.id}
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
  onSelectAgent,
  onReply,
  onJump,
  peeking = false,
  onPeek,
  flash = false,
}: {
  kind: "sent" | "received" | "handoff";
  otherId: string;
  message: ChatMessage;
  agents: AgentInfo[];
  onSelectAgent?: (id: string) => void;
  onReply?: (target: ReplyTarget) => void;
  onJump?: (id: string) => void;
  peeking?: boolean;
  onPeek?: (peerId: string, focus?: string[]) => void;
  flash?: boolean;
}) {
  const agent = agents.find((a) => a.id === otherId) ?? null;
  const t = useT();
  const who = displayWho(otherId, agent, t);
  const open =
    onSelectAgent && agent ? () => onSelectAgent(agent.id) : undefined;
  const [openBody, setOpenBody] = useState(false);
  const label =
    kind === "sent"
      ? t("thread.sent")
      : kind === "handoff"
        ? t("thread.handoff")
        : t("thread.received");
  const { reply, body } = splitReply(m.text || "");
  // A bot, deleted or not, opens beside the thread; a room still unfolds here.
  const side =
    onPeek && !otherId.startsWith("#") ? () => onPeek(otherId, [m.id]) : null;
  // A search hit has to be readable without a click.
  const show = (!side && openBody) || flash;
  return (
    <div
      className={"xfer" + (m.queued ? " queued" : "") + (flash ? " flash" : "")}
      data-msg-id={m.id}
    >
      <div className="xfer-chip">
        {m.text ? (
          <button
            type="button"
            className={"xfer-label is-toggle" + (peeking ? " is-peeking" : "")}
            aria-expanded={side ? peeking : show}
            onClick={side ?? (() => setOpenBody(!openBody))}
          >
            <ChevronDown className="note-caret" size={12} />
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
              onMention={onSelectAgent}
              baseDir={agent?.cwd || undefined}
            />
          ) : null}
          {side ? (
            <button type="button" className="xfer-peek" onClick={side}>
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
  onMention,
  baseDir,
}: {
  text: string;
  agents: AgentInfo[];
  onMention?: (id: string) => void;
  baseDir?: string;
}) {
  return (
    <div className="xfer-body">
      <MdBody
        className="xfer-text md"
        text={text}
        agents={agents}
        onMention={onMention}
        baseDir={baseDir}
      />
    </div>
  );
}

/** Keep the dots bubble mounted long enough for its height to close. */
function useDotsLeave(caret: boolean): {
  show: boolean;
  leaving: boolean;
  finish: () => void;
} {
  const track = useRef({ caret: false, leave: false });
  const [, bump] = useState(0);
  if (caret) {
    track.current = { caret: true, leave: false };
  } else if (track.current.caret) {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    track.current = { caret: false, leave: !reduce };
  }
  const finish = () => {
    if (!track.current.leave) return;
    track.current = { caret: false, leave: false };
    bump((n) => n + 1);
  };
  useEffect(() => {
    if (caret || !track.current.leave) return;
    const t = window.setTimeout(finish, ARRIVE_MS + 40);
    return () => window.clearTimeout(t);
  }, [caret]);
  return {
    show: caret || track.current.leave,
    leaving: track.current.leave && !caret,
    finish,
  };
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
  onAnswerChoice,
  onReply,
  onJump,
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
  onAnswerChoice?: (
    answers: string[][],
    values: string[][],
    closed: boolean,
  ) => void | Promise<void>;
  onReply?: (target: ReplyTarget) => void;
  onJump?: (id: string) => void;
  flash?: boolean;
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
  const defs = useMemo(() => messageDefinitions(body), [body]);
  // The wait dots get a bubble of their own under the text, not a tail on it.
  // Closing that bubble keeps it mounted for the shrink, so the thread does
  // not jump when the turn ends.
  const dots = useDotsLeave(caret);
  const parts = dots.show ? [...splitBubbles(body), ""] : splitBubbles(body);
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
        {parts.map((part, i) => {
          const last = i === parts.length - 1;
          const stack =
            parts.length > 1
              ? i === 0
                ? " stack-first"
                : last
                  ? " stack-last"
                  : " stack-mid"
              : "";
          const closing = dots.leaving && last;
          const bubble = (
            <>
              <MdBody
                className={
                  "bubble md incoming" +
                  stack +
                  ((caret || closing) && last ? " streaming" : "") +
                  (queued ? " queued" : "")
                }
                text={part}
                defs={defs}
                agents={agents}
                onMention={onSelectAgent}
                baseDir={agent?.cwd || undefined}
              />
              <MsgActions
                copy={part}
                onReply={
                  onReply && part
                    ? () => onReply(makeReply({ ...m, text: part }, agents, t))
                    : undefined
                }
              />
            </>
          );
          return (
            <div
              key={m.id + "-" + i}
              className={"bubble-row" + (closing ? " dots-leave" : "")}
              onAnimationEnd={
                closing
                  ? (e) => {
                      if (
                        e.animationName !== "dots-leave" ||
                        e.target !== e.currentTarget
                      ) {
                        return;
                      }
                      dots.finish();
                    }
                  : undefined
              }
            >
              {closing ? <div className="dots-clip">{bubble}</div> : bubble}
            </div>
          );
        })}
        {queued ? <QueueWait /> : null}
        {m.choice ? (
          <ChoiceCard
            key={m.choice.id}
            card={m.choice}
            onAnswer={onAnswerChoice}
          />
        ) : null}
        <ApprovalCard state={m.approval} onApprove={onApprove} />
      </div>
    </div>
  );
}

function NoteGroup({
  peerId,
  items,
  agents,
  selectedKind,
  onSelectAgent,
  onReply,
  onJump,
  peekFocus = null,
  onPeek,
  highlightId = null,
}: {
  peerId: string;
  items: ChatMessage[];
  agents: AgentInfo[];
  selectedKind: Kind;
  onSelectAgent?: (id: string) => void;
  onReply?: (target: ReplyTarget) => void;
  onJump?: (id: string) => void;
  peekFocus?: string | null;
  onPeek?: (peerId: string, focus?: string[]) => void;
  highlightId?: string | null;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const hit = items.some((m) => m.id === highlightId);
  const agent = agents.find((a) => a.id === peerId) ?? null;
  const side =
    onPeek && !peerId.startsWith("#")
      ? () => onPeek(peerId, items.map((m) => m.id))
      : null;
  const peeking = peekFocus === items[0].id;
  // A search hit inside a folded run has to be on screen to be highlighted.
  const show = (!side && open) || hit;
  // One note is not a run. The row is still a run so that a reply arriving
  // does not change the element type and remount the note under the reader.
  // A reply that belongs to the exchange is not a note, so it folds even alone.
  const folds = items.length > 1 || !noteRef(items[0], agents);
  const who = displayWho(peerId, agent, t);
  const queued = items.some((m) => m.queued);
  return (
    <div className={"note-run" + (queued ? " queued" : "")}>
      {folds ? (
        <div className="note-run-chip">
          <button
            type="button"
            className={"note-run-head" + (peeking ? " is-peeking" : "")}
            aria-expanded={side ? peeking : show}
            onClick={side ?? (() => setOpen(!open))}
          >
            <ChevronDown className="note-caret" size={12} />
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
        ? items.map((m) =>
            m.role === "assistant" ? (
              <Bubble
                key={m.id}
                message={m}
                agents={agents}
                selected={null}
                selectedKind={selectedKind}
                currentAgent={null}
                onSelectAgent={onSelectAgent}
                onReply={onReply}
                onJump={onJump}
                flash={highlightId === m.id}
              />
            ) : (
              <SystemOrIncoming
                key={m.id}
                message={m}
                agents={agents}
                selectedKind={selectedKind}
                onSelectAgent={onSelectAgent}
                onReply={onReply}
                onJump={onJump}
                peekFocus={peekFocus}
                onPeek={onPeek}
                flash={highlightId === m.id}
              />
            ),
          )
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
  const { names, more } = toolNames(items);
  return (
    <div className="tool-run">
      <button
        type="button"
        className="tool-run-head"
        aria-expanded={show}
        onClick={() => setOpen(!open)}
      >
        <ChevronDown className="note-caret" size={12} />
        {t("thread.toolUsed", { n: items.length })}
        <span aria-hidden="true">·</span>
        <span className="tool-run-names">
          {names.join(" · ")}
          {more ? ` +${more}` : ""}
        </span>
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
        <ChevronDown className="note-caret" size={12} />
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
        // Per question, not per option: "A" beside "백오프" as a badge reads as
        // two kinds of answer.
        const short = shortLabels(q.options || []);
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
                  const view = optionView(o, oi, short);
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
                  const view = optionView(o, oi, short);
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

function shortLabels(options: ChoiceOption[]): boolean {
  return options.every((o) => (o.label || "").trim().length <= 3);
}

function optionView(o: ChoiceOption, i: number, short: boolean) {
  const label = (o.label || "").trim() || String.fromCharCode(65 + i);
  const desc = (o.description || "").trim();
  const badge = short ? label : String.fromCharCode(65 + (i % 26));
  const title = short ? desc : label;
  const sub = !short && desc && desc !== label ? desc : null;
  return { badge, title, sub };
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
  onAnswerChoice,
  onReply,
  onJump,
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
  onAnswerChoice?: (
    answers: string[][],
    values: string[][],
    closed: boolean,
  ) => void | Promise<void>;
  onReply?: (target: ReplyTarget) => void;
  onJump?: (id: string) => void;
  flash?: boolean;
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
        who={displayWho(m.from, agent, t)}
        agents={agents}
        caret={caret}
        openName={!self}
        onSelectAgent={onSelectAgent}
        onApprove={onApprove}
        onAnswerChoice={onAnswerChoice}
        onReply={onReply}
        onJump={onJump}
        flash={flash}
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
      <div className="me-msg">
        {reply ? <ReplyQuote reply={reply} agents={agents} onJump={onJump} /> : null}
        {body.trim() ? (
          <div className="bubble-row">
            <MdBody
              className={cls}
              text={body}
              agents={agents}
              onMention={onSelectAgent}
              baseDir={currentAgent?.cwd || undefined}
            />
            <MsgActions
              copy={body.trim()}
              onReply={
                onReply
                  ? () => onReply(makeReply({ ...m, text: body }, agents, t))
                  : undefined
              }
            />
          </div>
        ) : null}
        {queued ? <QueueWait /> : null}
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
      : displayWho(m.from, agent, t);
  return { id: m.id, from: m.from || "user", who, text };
}

function quoteWho(from: string, agents: AgentInfo[], t: TFn): string {
  if (from === "user") return t("thread.you");
  const id = sentTarget(from) ?? from;
  return displayWho(id, agents.find((a) => a.id === id) ?? null, t);
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

function ThreadTime({ ts, label }: { ts: number; label: string }) {
  return (
    <time className="thread-time" dateTime={new Date(ts).toISOString()}>
      {label}
    </time>
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

/**
 * The bot to show beside the thread when this chat has only side chats: the
 * one whose run holds `hit`, else the one it spoke with last. `null` once
 * the reader has a conversation here.
 */
export function sideOnlyPeer(
  messages: ChatMessage[],
  agents: AgentInfo[],
  hit: string | null = null,
): string | null {
  const rows = threadRows(visibleMessages(messages, false), agents);
  if (rows.some((row) => row.kind === "msg")) return null;
  let peer: string | null = null;
  for (const row of rows) {
    if (row.kind !== "notes" || row.peerId.startsWith("#")) continue;
    if (row.msgs.some((m) => m.id === hit)) return row.peerId;
    peer = row.peerId;
  }
  return peer;
}

function visibleMessages(
  messages: ChatMessage[],
  showTools: boolean,
): ChatMessage[] {
  return messages.filter((m, i) => {
    if (m.kind === "tool") return showTools;
    if (m.role !== "assistant") return true;
    const raw = m.text || "";
    if (isEnvelopeEcho(raw, messages[i - 1])) return false;
    if (isPlainEcho(raw, messages, i)) return false;
    return stripCrewMarkers(raw).length > 0 || !!m.choice;
  });
}
