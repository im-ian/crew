import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { ARRIVE_MS, OPEN_SLACK_MS, playArrive, useArriving } from "../arrive";
import { useLocale, useT } from "../LocaleContext";
import type { TFn } from "../i18n";
import type { ReplyTarget } from "../reply";
import { splitReply } from "../reply";
import type {
  AgentInfo,
  ChatMessage,
  ChoiceCard as ChoiceCardData,
  Kind,
} from "../types";
import { resolveFace } from "../avatar";
import { isMediaBlock, splitBubbles } from "../bubbles";
import { messageDefinitions } from "../markdown";
import { displayWho, noteRef, sentTarget, subagentFace } from "../peek";
import {
  dotsAfter,
  momentStamp,
  rowTs,
  runPeer,
  threadRows,
  toolArgs,
  toolNames,
  toolSummary,
  type ThreadRow,
} from "../tools";
import { answeredOptionView, optionView, otherBadge, shortLabels } from "../choiceView";
import { routineSwitchName } from "../routineNote";
import { queueActions, shownInThread, userLineAppearance } from "../sendGate";
import { isSelfMentionDelivery } from "../mentions";
import { clockLabels, messageClockParts } from "../clock";
import type { CaretPoint } from "../caretPoint";
import { threadFaceId } from "../threadFace";
import {
  acceptHeight,
  anchorIndex,
  anchorShift,
  extraIndexes,
  flowWindow,
  mountedIndexes,
  ROW_ESTIMATE,
  ROW_GAP,
  rowOffsets,
  scrollForIndex,
  VIRTUAL_THRESHOLD,
} from "../virtualThread";
import { firstUnreadId } from "../readCursors";
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

function rowHas(row: ThreadRow, id: string): boolean {
  if (row.kind === "msg") return row.msg.id === id;
  return row.msgs.some((m) => m.id === id);
}

function indexOfRow(list: readonly ThreadRow[], id: string | null | undefined): number {
  if (!id) return -1;
  return list.findIndex((row) => rowHas(row, id));
}

/** A waiting user line is pulled under the reply. It is not part of the scrolled history. */
function isPinned(row: ThreadRow): boolean {
  return row.kind === "msg" && !!row.msg.queued;
}

function MsgSlot({
  id,
  start,
  typing = false,
  className,
  children,
}: {
  id: string;
  start: number | null;
  typing?: boolean;
  className?: string;
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
      className={"msg-slot" + (className ? " " + className : "")}
      data-typing-slot={typing ? "" : undefined}
      ref={ref}
    >
      <div className="msg-grow">{children}</div>
    </div>
  );
}

/**
 * One mounted row in a virtual thread. The start height is chosen once per
 * mount: a row that scrolls back into view does not play the entrance again,
 * and a strict-mode remount a moment later still does.
 */
function VirtualRow({
  id,
  top,
  pick,
  onHeight,
  children,
}: {
  id: string;
  top: number;
  pick: RefObject<(id: string) => number | null>;
  onHeight: RefObject<(id: string, height: number) => void>;
  children: (start: number | null) => ReactNode;
}) {
  const held = useRef<{ id: string; start: number | null } | null>(null);
  if (!held.current || held.current.id !== id) {
    held.current = { id, start: pick.current(id) };
  }
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const report = () => onHeight.current(id, el.offsetHeight);
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [id, onHeight]);
  return (
    <div ref={box} className="thread-row" style={{ top }}>
      {children(held.current.start)}
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
  onApprove?: (allow: boolean, agentId?: string, always?: boolean) => void;
  /** Take back the user's own message while it waits for the bot. */
  onCancelQueued?: (messageId: string) => void;
  /** Change it in the composer; it keeps its place in line. */
  onEditQueued?: (messageId: string, text: string, reply: ReplyTarget | null) => void;
  /** Send this waiting line without typing another one in front of it. */
  onSendQueued?: (messageId: string) => void;
  /** Waiting line the empty composer is pointing at. */
  queuePick?: string | null;
  onAnswerChoice?: (
    agentId: string,
    messageId: string,
    answers: string[][],
    values: string[][],
    others: string[],
    closed: boolean,
  ) => void | Promise<void>;
  highlightId?: string | null;
  onHighlightDone?: () => void;
  /** Where the reader had got to when this chat opened, and whether its lines are in. */
  openedRead?: { key: string; ts: number } | null;
  ready?: boolean;
  jumpSeq?: number;
  onReply?: (target: ReplyTarget) => void;
  onJump?: (id: string) => void;
  /** First id of the run open in the side panel, if any. */
  peekFocus?: string | null;
  onPeek?: (peerId: string, focus?: string[]) => void;
  showTools?: boolean;
  /** A routine run opens the routines pane instead of quoting its prompt. */
  onOpenRoutines?: () => void;
  /** Caret in the composer, while this bot is idle. */
  lookAt?: CaretPoint | null;
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
  onCancelQueued,
  onEditQueued,
  onSendQueued,
  queuePick,
  onAnswerChoice,
  highlightId = null,
  onHighlightDone,
  openedRead = null,
  ready = true,
  jumpSeq = 0,
  onReply,
  onJump,
  peekFocus = null,
  onPeek,
  showTools = false,
  onOpenRoutines,
  lookAt = null,
}: Props) {
  const { locale } = useLocale();
  const ref = useRef<HTMLDivElement>(null);
  // Opening on the first unread line holds the thread there. Reaching the
  // bottom, or any scroll that ends there, lets it follow new lines again.
  const [resume, setResume] = useState<{
    key: string;
    id: string | null;
    hold: boolean;
  } | null>(null);
  const holdRef = useRef(false);
  holdRef.current = !!resume?.hold;
  const { away, sync: syncStick, jump: jumpBottom } = useStick(ref, (at) => {
    if (at && holdRef.current && settledRef.current) {
      holdRef.current = false;
      setResume((r) => (r && r.hold ? { ...r, hold: false } : r));
    }
    onStick(at);
  });
  const settledRef = useRef(false);
  // The reader has taken the scroll over: stop putting the divider back.
  const movedRef = useRef(false);
  const visible = visibleMessages(messages, showTools, selected);
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

  // A new bot asks before any row exists, so the dots have to stand alone.
  // A side-only thread already has rows, and those dots stay in the side chat.
  const placeholders =
    direct || (streaming && messages.length === 0)
      ? workingPlaceholders()
      : [];
  const empty = !direct && placeholders.length === 0;
  const typingId = placeholders[0] ? "working-" + placeholders[0].id : null;
  const faceId =
    selectedKind === "agent" && selected
      ? threadFaceId(visible, selected, typingId)
      : null;
  // Only what is written after the chat opens plays the entrance. The thread
  // is not remounted per chat, so the moment is kept per chat key.
  const chatKey = `${selectedKind}:${selected ?? ""}`;
  const openedAt = useRef({ key: chatKey, at: Date.now() });
  if (openedAt.current.key !== chatKey) {
    openedAt.current = { key: chatKey, at: Date.now() };
  }
  const resumeId = resume?.key === chatKey ? resume.id : null;
  const resumeHold = resume?.key === chatKey && resume.hold && !!resumeId;
  // Once per chat, when its own lines are in.
  useLayoutEffect(() => {
    if (!ready || !selected) return;
    if (resume?.key === chatKey) return;
    if (openedRead?.key !== chatKey) return;
    settledRef.current = false;
    movedRef.current = false;
    const id = firstUnreadId(
      rows.map((row) => ({
        id: rowKey(row),
        ts: rowTs(row),
        mine:
          row.kind === "msg" &&
          (row.msg.role === "user" || row.msg.from === "user"),
      })),
      openedRead.ts,
    );
    setResume({ key: chatKey, id, hold: !!id });
  }, [ready, chatKey, openedRead, rows.length]);
  const writtenAt = new Map(rows.map((row) => [rowKey(row), rowTs(row)]));
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
    (id) => {
      const ts = writtenAt.get(id);
      // No stamp: nothing says it is old, so it moves as before.
      if (!ts) return true;
      return ts >= openedAt.current.at - OPEN_SLACK_MS;
    },
  );

  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);
  const [unpinned, setUnpinned] = useState(false);
  const [heightRev, setHeightRev] = useState(0);
  const [gap, setGap] = useState(ROW_GAP);
  const heightsRef = useRef(new Map<string, number>());
  const heightRaf = useRef(0);
  const prevOffsets = useRef<number[] | null>(null);
  const born = useRef(new Map<string, number>());
  const opened = useRef(new Map<string, number>());
  const unpinnedRef = useRef(false);
  const stickRef = useRef(stick);
  const offsetsRef = useRef<number[]>([]);
  const flowLenRef = useRef(0);
  const rowsLenRef = useRef(0);
  const rangeRef = useRef({ start: 0, end: 0 });
  const viewportRef = useRef(0);
  const followRef = useRef(true);
  const pickRef = useRef<(id: string) => number | null>(() => null);
  const onHeightRef = useRef<(id: string, height: number) => void>(() => {});
  stickRef.current = stick;
  unpinnedRef.current = unpinned;

  for (const id of arrive.keys()) {
    if (!born.current.has(id)) born.current.set(id, performance.now());
  }

  // Past the threshold, waiting lines stay mounted at the bottom (the flex
  // order that pins them) and the rest of the history is a measured window.
  const virtual = rows.length > VIRTUAL_THRESHOLD;
  const flow = virtual ? rows.filter((row) => !isPinned(row)) : rows;
  const pinned = virtual ? rows.filter(isPinned) : [];
  const offsets = virtual
    ? rowOffsets(
        flow.length,
        (i) => heightsRef.current.get(rowKey(flow[i])) ?? ROW_ESTIMATE,
        gap,
      )
    : [];
  offsetsRef.current = offsets;
  flowLenRef.current = flow.length;
  rowsLenRef.current = rows.length;
  const followBottom = stick && !unpinned && !highlightId && !resumeHold;
  const focusId = highlightId ?? (resumeHold ? resumeId : null);
  const focusIndex = virtual ? indexOfRow(flow, focusId) : -1;
  const flowTotal = offsets[flow.length] ?? 0;
  const win = virtual
    ? flowWindow({
        count: flow.length,
        scrollTop,
        viewport,
        offsets,
        stick: followBottom,
      })
    : { start: 0, end: rows.length, virtual: false };
  rangeRef.current = { start: win.start, end: win.end };
  viewportRef.current = viewport;
  followRef.current = followBottom;
  const wanted: number[] = [];
  if (virtual) {
    if (focusIndex >= 0) wanted.push(focusIndex);
    const picked = indexOfRow(flow, queuePick);
    if (picked >= 0) wanted.push(picked);
  }
  const mounted = virtual
    ? mountedIndexes(
        win.start,
        win.end,
        extraIndexes(flow.length, win.start, win.end, wanted),
      )
    : [];
  const offsetsKey = `${heightRev}:${flow.length}:${flowTotal}:${gap}`;

  // A row plays its entrance the first time it mounts. Scrolling back to it
  // later must not play it again. A remount in the same instant (strict mode)
  // still does.
  pickRef.current = (id: string) => {
    const fresh = arrive.get(id);
    if (fresh === undefined) return null;
    const now = performance.now();
    const bornAt = born.current.get(id) ?? now;
    const seen = opened.current.get(id);
    if (seen !== undefined && now - seen > 50) return null;
    opened.current.set(id, now);
    if (now - bornAt > ARRIVE_MS) return null;
    return fresh;
  };
  onHeightRef.current = (id: string, height: number) => {
    if (!acceptHeight(heightsRef.current.get(id), height)) return;
    heightsRef.current.set(id, height);
    if (heightRaf.current) return;
    heightRaf.current = requestAnimationFrame(() => {
      heightRaf.current = 0;
      setHeightRev((n) => n + 1);
    });
  };

  useEffect(
    () => () => {
      if (heightRaf.current) cancelAnimationFrame(heightRaf.current);
    },
    [],
  );

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = () => {
      const next = el.clientHeight;
      setViewport((v) => (Math.abs(v - next) < 1 ? v : next));
      const n = parseFloat(getComputedStyle(el).getPropertyValue("--space-14"));
      if (Number.isFinite(n) && n > 0) setGap((g) => (g === n ? g : n));
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [selected, selectedKind]);

  useEffect(() => {
    unpinnedRef.current = false;
    setUnpinned(false);
  }, [selected, selectedKind]);

  useEffect(() => {
    const el = ref.current;
    if (el && stick && !highlightId && !resumeHold) el.scrollTop = el.scrollHeight;
    syncStick();
  }, [
    messages,
    stick,
    selected,
    selectedKind,
    streaming,
    highlightId,
    showTools,
    heightRev,
    resumeHold,
  ]);

  // The entrance grows the row after this commit. Follow it to the bottom
  // unless the reader has already moved up.
  useLayoutEffect(() => {
    if (!stick || highlightId || resumeHold || arrive.size === 0) return;
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
  }, [arrive, stick, highlightId, resumeHold]);

  // A measured row above the viewport would shove what the reader is looking
  // at. Move scrollTop by the same amount before paint. Stuck to the bottom,
  // follow the new height instead.
  useLayoutEffect(() => {
    if (!virtual) {
      prevOffsets.current = null;
      return;
    }
    const el = ref.current;
    const before = prevOffsets.current;
    if (el && followBottom) {
      const next = el.scrollHeight;
      if (Math.abs(el.scrollTop - next) > 1) el.scrollTop = next;
    } else if (el && before && before.length === offsets.length) {
      const anchor = anchorIndex(before, el.scrollTop, flow.length);
      const shift = anchorShift(before, offsets, anchor);
      if (shift) el.scrollTop += shift;
    }
    prevOffsets.current = offsets;
  }, [virtual, offsetsKey, followBottom, flow.length]);

  useEffect(() => {
    if (!jumpSeq) return;
    jumpBottom();
  }, [jumpSeq]);

  // Put the window on the hit before paint, so the rows around it mount.
  // `focusReady` flips when the row appears; a later token must not scroll
  // the reader back.
  const focusReady = focusIndex >= 0;
  useLayoutEffect(() => {
    if (!virtual || !focusId || focusIndex < 0) return;
    const el = ref.current;
    if (!el) return;
    const top = scrollForIndex(
      offsets,
      focusIndex,
      el.clientHeight,
      offsets[flow.length] ?? 0,
    );
    if (Math.abs(el.scrollTop - top) > 1) el.scrollTop = top;
    setScrollTop(top);
    if (el.clientHeight > 0) setViewport(el.clientHeight);
  }, [focusId, focusReady, virtual]);

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

  // Open on the divider: the first line the reader has not seen at the top.
  // Once there, a scroll that reaches the bottom is the reader's own.
  useLayoutEffect(() => {
    if (!resumeHold || highlightId || movedRef.current) return;
    const root = ref.current;
    const el = root?.querySelector("[data-resume-divider]");
    if (!root || !(el instanceof HTMLElement)) return;
    const top =
      el.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
    root.scrollTop = Math.max(0, top - 8);
    // A thread that still ends in view has nothing below to hold for.
    settledRef.current = true;
    syncStick();
  }, [resumeHold, resumeId, highlightId, virtual, heightRev]);

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

  useEffect(() => {
    if (!queuePick) return;
    const root = ref.current;
    if (!root) return;
    const el = root.querySelector(
      `[data-msg-id="${CSS.escape(queuePick)}"]`,
    ) as HTMLElement | null;
    el?.scrollIntoView({ block: "nearest" });
  }, [queuePick]);

  function startOf(row: ThreadRow): number | null {
    const start = arrive.get(rowKey(row));
    return start === undefined ? null : start;
  }

  function oneRow(row: ThreadRow, start: number | null) {
    const id = rowKey(row);
    let node: ReactNode;
    if (row.kind === "tools") {
      node = <ToolGroup items={row.msgs} highlightId={highlightId} />;
    } else if (row.kind === "notes") {
      node = (
        <NoteGroup
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
        streaming && m.role === "assistant" && m.id === lastVisible?.id;
      const flash = highlightId === m.id;
      const revise = queueActions(m);
      node =
        m.role === "system" && m.from !== "user" ? (
          <SystemOrIncoming
            message={m}
            agents={agents}
            selectedKind={selectedKind}
            onSelectAgent={openAgent}
            onReply={onReply}
            onJump={onJump}
            peekFocus={peekFocus}
            onPeek={onPeek}
            flash={flash}
            onOpenRoutines={onOpenRoutines}
          />
        ) : (
          <Bubble
            message={m}
            agents={agents}
            selected={selected}
            selectedKind={selectedKind}
            currentAgent={currentAgent}
            caret={caret}
            onSelectAgent={openAgent}
            onApprove={
              onApprove
                ? (allow, always) => onApprove(allow, m.from, always)
                : undefined
            }
            onAnswerChoice={
              onAnswerChoice
                ? (answers, values, others, closed) =>
                    onAnswerChoice(m.from, m.id, answers, values, others, closed)
                : undefined
            }
            onCancel={
              revise.cancel && onCancelQueued
                ? () => onCancelQueued(m.id)
                : undefined
            }
            onEdit={
              revise.edit && onEditQueued
                ? (text, reply) => onEditQueued(m.id, text, reply)
                : undefined
            }
            onSend={
              revise.cancel && onSendQueued
                ? () => onSendQueued(m.id)
                : undefined
            }
            picked={queuePick === m.id}
            onReply={onReply}
            onJump={onJump}
            flash={flash}
            faceId={faceId}
            lookAt={lookAt}
          />
        );
    }
    const time = clocks.get(id);
    const pin = row.kind === "msg" && row.msg.queued;
    return (
      <MsgSlot
        key={id}
        id={id}
        className={pin ? "pin-bottom" : undefined}
        start={start}
      >
        {time ? <ThreadTime ts={time.ts} label={time.label} /> : null}
        {resumeId === id ? <NewFromHere /> : null}
        {node}
      </MsgSlot>
    );
  }

  function takeOver() {
    movedRef.current = true;
  }

  function onThreadScroll() {
    syncStick();
    const el = ref.current;
    if (!el || rowsLenRef.current <= VIRTUAL_THRESHOLD) return;
    const nextTop = el.scrollTop;
    const nextView = el.clientHeight;
    const gapPx = el.scrollHeight - nextTop - nextView;
    const atBottom = gapPx < STICK_PX;
    if (atBottom) {
      if (unpinnedRef.current) {
        unpinnedRef.current = false;
        setUnpinned(false);
      }
    } else if (stickRef.current && !unpinnedRef.current) {
      unpinnedRef.current = true;
      setUnpinned(true);
    }
    const follow = atBottom && stickRef.current && !highlightId && !holdRef.current;
    const next = flowWindow({
      count: flowLenRef.current,
      scrollTop: nextTop,
      viewport: nextView,
      offsets: offsetsRef.current,
      stick: follow,
    });
    const changed =
      next.start !== rangeRef.current.start ||
      next.end !== rangeRef.current.end ||
      Math.abs(nextView - viewportRef.current) > 1 ||
      follow !== followRef.current;
    if (!changed) return;
    rangeRef.current = { start: next.start, end: next.end };
    viewportRef.current = nextView;
    followRef.current = follow;
    setScrollTop(nextTop);
    setViewport(nextView);
  }

  return (
    <div className="thread-wrap">
      <div
        className="thread"
        ref={ref}
        onScroll={onThreadScroll}
        onWheel={takeOver}
        onPointerDown={takeOver}
        onTouchMove={takeOver}
        onKeyDown={takeOver}
      >
        {virtual ? (
          flow.length > 0 ? (
            <div className="thread-window" style={{ height: flowTotal }}>
              {mounted.map((i) => {
                const row = flow[i];
                const id = rowKey(row);
                return (
                  <VirtualRow
                    key={id}
                    id={id}
                    top={offsets[i] ?? 0}
                    pick={pickRef}
                    onHeight={onHeightRef}
                  >
                    {(start) => oneRow(row, start)}
                  </VirtualRow>
                );
              })}
            </div>
          ) : null
        ) : (
          rows.map((row) => oneRow(row, startOf(row)))
        )}
        {pinned.map((row) => oneRow(row, startOf(row)))}
        {empty ? <EmptyChat agent={currentAgent} lookAt={lookAt} /> : null}
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
                showName={false}
                showFace
                lookAt={lookAt}
                onSelectAgent={openAgent}
              />
            </MsgSlot>
          );
        })}

      </div>
      {away ? <JumpBottom onClick={jumpBottom} /> : null}
    </div>
  );
}

/**
 * Whether a thread is at its bottom, for the thread and the side chat alike.
 * The side chat once kept its own copy without the button, and new notes
 * piled up out of sight there with nothing to say so.
 */
export function useStick(
  ref: RefObject<HTMLDivElement | null>,
  onStick: (stick: boolean) => void,
) {
  const [away, setAway] = useState(false);

  function sync() {
    const el = ref.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    const overflow = el.scrollHeight - el.clientHeight > 8;
    onStick(gap < STICK_PX);
    setAway(overflow && gap >= STICK_PX);
  }

  function jump() {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    onStick(true);
    setAway(false);
  }

  return { away, sync, jump };
}

export function JumpBottom({ onClick }: { onClick: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      className="jump-bottom"
      title={t("thread.jumpBottom")}
      aria-label={t("thread.jumpBottom")}
      onClick={onClick}
    >
      <ChevronDown size={18} />
    </button>
  );
}

function EmptyChat({
  agent,
  lookAt = null,
}: {
  agent: AgentInfo | null;
  lookAt?: CaretPoint | null;
}) {
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
          lookAt={lookAt}
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
  showChip = true,
  onOpenRoutines,
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
  /** A lone note's run already names it, so a second chip would repeat it. */
  showChip?: boolean;
  onOpenRoutines?: () => void;
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
    const text = displayText(m);
    // Switching a routine in the sheet leaves this sentence. It opens that sheet.
    if (routineSwitchName(text) && onOpenRoutines) {
      return (
        <button
          type="button"
          className={"sys-note" + (flash ? " flash" : "")}
          data-msg-id={m.id}
          title={t("thread.routineOpen")}
          onClick={() => onOpenRoutines()}
        >
          {text}
        </button>
      );
    }
    return (
      <div className={"sys-note" + (flash ? " flash" : "")} data-msg-id={m.id}>
        {text}
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
        showChip={showChip}
      />
    );
  }
  return (
    <div
      className={"sys" + (m.queued ? " queued" : "") + (flash ? " flash" : "")}
      data-msg-id={m.id}
    >
      <button
        type="button"
        className="sys-routine"
        title={t("thread.routineOpen")}
        onClick={() => onOpenRoutines?.()}
      >
        {t("thread.routineFrom", { from: m.from || "" })}
      </button>
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
  showChip = true,
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
  showChip?: boolean;
}) {
  const agent = agents.find((a) => a.id === otherId) ?? null;
  const t = useT();
  const who = displayWho(otherId, agent, t);
  const open =
    onSelectAgent && agent ? () => onSelectAgent(agent.id) : undefined;
  // Starts open when there is no chip of its own. A later note adds the chip
  // without resetting this, so the body the reader had open stays open.
  const [openBody, setOpenBody] = useState(!showChip);
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
  // A search hit has to be readable without a click. A note with no chip of
  // its own is already open: the run header is that chip.
  const show = !showChip || (!side && openBody) || flash;
  const actions = (
    <MsgActions
      copy={body.trim()}
      ts={m.ts}
      onReply={
        onReply && body.trim()
          ? () => onReply(makeReply({ ...m, from: otherId }, agents, t))
          : undefined
      }
    />
  );
  return (
    <div
      className={"xfer" + (m.queued ? " queued" : "") + (flash ? " flash" : "")}
      data-msg-id={m.id}
    >
      {showChip ? (
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
            agent={agent ?? subagentFace(otherId, t)}
            who={who}
            fallbackId={otherId}
            onClick={open}
          />
          {actions}
        </div>
      ) : (
        actions
      )}
      {show ? (
        <>
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
  showFace = true,
  showName = true,
  lookAt = null,
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
  /** The bot's face. A 1:1 room draws it on the latest line only. */
  showFace?: boolean;
  /** The name beside a message. A 1:1 room leaves it off. */
  showName?: boolean;
  lookAt?: CaretPoint | null;
  onSelectAgent?: (id: string) => void;
  onApprove?: (allow: boolean, always?: boolean) => void;
  onAnswerChoice?: (
    answers: string[][],
    values: string[][],
    others: string[],
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
  const pendingAsk = m.approval === "pending";
  const { reply, body } = splitReply(m.text || "");
  const defs = useMemo(() => messageDefinitions(body), [body]);
  // The wait dots get a bubble of their own under the text, not a tail on it.
  // Closing that bubble keeps it mounted for the shrink, so the thread does
  // not jump when the turn ends.
  const dots = useDotsLeave(caret);
  const raw = dots.show ? [...splitBubbles(body), ""] : splitBubbles(body);
  const media = raw.filter((part) => isMediaBlock(part));
  const parts = raw.filter((part) => !isMediaBlock(part));
  return (
    <div
      className={
        "row them incoming" +
        (queued ? " queued" : "") +
        (flash ? " flash" : "") +
        (showFace && !showName ? " face-end" : "")
      }
      data-msg-id={m.id}
    >
      {agent && showFace ? (
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
          lookAt={lookAt}
        />
      ) : agent ? (
        <div className="msg-avatar" aria-hidden="true" />
      ) : null}
      <div className="channel-msg">
        {!showName ? null : open ? (
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
        {media.length ? (
          <div className="msg-media">
            {media.map((part, i) => (
              <MdBody
                key={m.id + "-media-" + i}
                className="md"
                text={part}
                defs={defs}
                agents={agents}
                onMention={onSelectAgent}
                baseDir={agent?.cwd || undefined}
              />
            ))}
          </div>
        ) : null}
        {parts.length && !pendingAsk ? (
          <div className="bubble-stack">
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
            const copy = part.trim();
            const bubble = (
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
            );
            return (
              <div
                key={m.id + "-" + i}
                className={
                  "bubble-row" +
                  (copy ? " has-actions" : "") +
                  (closing ? " dots-leave" : "")
                }
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
                {copy ? (
                  <MsgActions
                    copy={copy}
                    ts={m.ts}
                    onReply={
                      onReply
                        ? () => onReply(makeReply({ ...m, text: copy }, agents, t))
                        : undefined
                    }
                  />
                ) : null}
              </div>
            );
          })}
          </div>
        ) : null}
        {queued ? <QueueWait /> : null}
        {m.choice ? (
          <ChoiceCard
            key={m.choice.id}
            card={m.choice}
            onAnswer={onAnswerChoice}
          />
        ) : null}
        <ApprovalCard
          state={m.approval}
          detail={pendingAsk ? body.trim() : ""}
          onApprove={onApprove}
        />
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
  // One note wears the same chip as many. The row stays a run, so opening it
  // keeps this mounted and the note inside keeps its body when the next arrives.
  const who = displayWho(peerId, agent, t);
  const queued = items.some((m) => m.queued);
  return (
    <div className={"note-run" + (queued ? " queued" : "")}>
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
          agent={agent ?? subagentFace(peerId, t)}
          who={who}
          fallbackId={peerId}
          onClick={
            onSelectAgent && agent ? () => onSelectAgent(agent.id) : undefined
          }
        />
      </div>
      {!show && queued ? <QueueWait /> : null}
      {show
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
                showChip={items.length > 1}
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
  detail,
  onApprove,
}: {
  state?: ChatMessage["approval"];
  who?: string;
  detail?: string;
  onApprove?: (allow: boolean, always?: boolean) => void;
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
  const work = (detail || "").trim();
  return (
    <div className="approval-card">
      <div className="approval-kicker">
        {who ? t("thread.approveAskWho", { who }) : t("thread.approveAsk")}
      </div>
      {work ? <div className="approval-detail">{work}</div> : null}
      <div className="approval-actions">
        <button type="button" className="approval-allow" onClick={() => onApprove(true, false)}>
          {t("thread.allowOnce")}
        </button>
        <button type="button" className="approval-deny" onClick={() => onApprove(false, false)}>
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
    others: string[],
    closed: boolean,
  ) => void | Promise<void>;
}) {
  const t = useT();
  const questions = card.questions || [];
  const pending = card.state === "pending";
  const hasFields = questions.some((q) => (q.fields || []).length > 0);
  const [picks, setPicks] = useState<string[][]>(() =>
    questions.map((q) => q.selected || []),
  );
  const [values, setValues] = useState<string[][]>(() =>
    questions.map((q) => (q.fields || []).map((f) => f.value || "")),
  );
  const [others, setOthers] = useState<string[]>(() =>
    questions.map((q) => q.other || ""),
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
    // One answer per single pick: an option replaces what was typed. Picking
    // only selects; the answer goes out on the submit button.
    if (!multi) setOthers(others.map((v, i) => (i === qi ? "" : v)));
  }

  function setOther(qi: number, next: string) {
    if (!open || !onAnswer) return;
    setOthers((prev) => questions.map((_, i) => (i === qi ? next : prev[i] || "")));
    // Typing is the answer on a single pick, so the option it replaces lets go.
    if (!questions[qi]?.multi && next.trim()) {
      setPicks((prev) => prev.map((row, i) => (i === qi ? [] : row)));
    }
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

  function complete(nextPicks = picks, nextValues = values, nextOthers = others) {
    const allOk = questions.every((q, qi) => {
      const fields = q.fields || [];
      const fieldOk = fields.every((f, fi) => {
        if (f.required === false) return true;
        return (nextValues[qi]?.[fi] || "").trim() !== "";
      });
      const optOk =
        !(q.options || []).length ||
        (nextPicks[qi] || []).length > 0 ||
        (nextOthers[qi] || "").trim() !== "";
      return fieldOk && optOk;
    });
    const any = questions.some((_, qi) => {
      const fields = questions[qi].fields || [];
      return (
        (nextPicks[qi] || []).length > 0 ||
        (nextOthers[qi] || "").trim() !== "" ||
        (nextValues[qi] || []).some((v) => v.trim()) ||
        (fields.length > 0 && fields.every((f) => f.required === false))
      );
    });
    return allOk && any;
  }

  function submit() {
    if (!open || !onAnswer) return;
    if (!complete()) return;
    void send(picks, values, others, false);
  }

  async function send(
    answers: string[][],
    fieldValues: string[][],
    typed: string[],
    closed: boolean,
  ) {
    if (!onAnswer) return;
    setSent(true);
    try {
      await onAnswer(answers, fieldValues, typed, closed);
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
        const other = pending ? others[qi] || "" : q.other || "";
        // Below the options: an answer the bot did not list.
        const badge = otherBadge(q.options || []);
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
                  onClick={() => void send(picks, values, others, true)}
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
            {q.multi && open && (q.options || []).length ? (
              <div className="choice-multi">{t("thread.choiceMulti")}</div>
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
                {open || other.trim() ? (
                  <label
                    className={
                      "choice-option choice-other" + (other.trim() ? " is-on" : "")
                    }
                  >
                    <span className="choice-badge">{badge}</span>
                    <input
                      className="choice-other-input"
                      type="text"
                      value={other}
                      placeholder={t("thread.choiceOther")}
                      disabled={!open || !onAnswer}
                      autoComplete="off"
                      onChange={(e) => setOther(qi, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key !== "Enter" || e.nativeEvent.isComposing) {
                          return;
                        }
                        e.preventDefault();
                        submit();
                      }}
                    />
                  </label>
                ) : null}
              </div>
            ) : picked.length || other.trim() ? (
              <div className="choice-picked">
                {picked.map((o) => {
                  const view = answeredOptionView(q.options || [], o);
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
                {other.trim() ? (
                  <div className="choice-option is-on">
                    <span className="choice-badge">{badge}</span>
                    <span className="choice-copy">
                      <span className="choice-label">{other.trim()}</span>
                    </span>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
      {open && onAnswer ? (
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
              onClick={() => void send(picks, values, others, true)}
            >
              {t("thread.choiceDismiss")}
            </button>
          ) : null}
        </div>
      ) : null}
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
  onAnswerChoice,
  onCancel,
  onEdit,
  onSend,
  picked = false,
  onReply,
  onJump,
  flash = false,
  faceId = null,
  lookAt = null,
}: {
  message: ChatMessage;
  agents: AgentInfo[];
  selected: string | null;
  selectedKind: Kind;
  currentAgent: AgentInfo | null;
  caret?: boolean;
  onSelectAgent?: (id: string) => void;
  onApprove?: (allow: boolean, always?: boolean) => void;
  onAnswerChoice?: (
    answers: string[][],
    values: string[][],
    others: string[],
    closed: boolean,
  ) => void | Promise<void>;
  onCancel?: () => void;
  onEdit?: (text: string, reply: ReplyTarget | null) => void;
  onSend?: () => void;
  picked?: boolean;
  onReply?: (target: ReplyTarget) => void;
  onJump?: (id: string) => void;
  flash?: boolean;
  faceId?: string | null;
  lookAt?: CaretPoint | null;
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
        showName={!self}
        showFace={!self || m.id === faceId}
        lookAt={self && m.id === faceId ? lookAt : null}
        onSelectAgent={onSelectAgent}
        onApprove={onApprove}
        onAnswerChoice={onAnswerChoice}
        onReply={onReply}
        onJump={onJump}
        flash={flash}
      />
    );
  }
  const appearance = userLineAppearance(m);
  // Not accepted yet: drawing it here would be a sent bubble ahead of the daemon.
  if (appearance === "hold") return null;
  const queued = appearance === "waiting";
  const { reply, body } = splitReply(text);
  const parts = splitBubbles(body);
  const media = parts.filter((part) => isMediaBlock(part));
  const prose = parts.filter((part) => !isMediaBlock(part)).join("\n\n");
  const cls =
    "bubble md" + (caret ? " streaming" : "") + (queued ? " queued" : "");
  return (
    <div
      className={
        "row me" +
        (queued ? " queued" : "") +
        (flash ? " flash" : "") +
        (picked ? " queue-picked" : "")
      }
      aria-selected={picked || undefined}
      data-msg-id={m.id}
    >
      <div className="me-msg">
        {reply ? <ReplyQuote reply={reply} agents={agents} onJump={onJump} /> : null}
        {media.length ? (
          <div className="msg-media">
            {media.map((part, i) => (
              <MdBody
                key={m.id + "-media-" + i}
                className="md"
                text={part}
                agents={agents}
                onMention={onSelectAgent}
                baseDir={currentAgent?.cwd || undefined}
              />
            ))}
          </div>
        ) : null}
        {prose.trim() ? (
          <div className="bubble-row">
            <MdBody
              className={cls}
              text={prose}
              agents={agents}
              onMention={onSelectAgent}
              baseDir={currentAgent?.cwd || undefined}
            />
            <MsgActions
              copy={prose.trim()}
              ts={m.ts}
              onReply={
                onReply
                  ? () => onReply(makeReply({ ...m, text: prose }, agents, t))
                  : undefined
              }
            />
          </div>
        ) : null}
        {queued ? (
          <QueueWait
            onCancel={onCancel}
            onSend={onSend}
            onEdit={
              onEdit
                ? () =>
                    onEdit(
                      body,
                      reply && {
                        id: reply.id,
                        from: reply.from,
                        who: quoteWho(reply.from, agents, t),
                        text: reply.snippet,
                      },
                    )
                : undefined
            }
          />
        ) : null}
      </div>
    </div>
  );
}

function QueueWait({
  onCancel,
  onEdit,
  onSend,
}: {
  onCancel?: () => void;
  onEdit?: () => void;
  onSend?: () => void;
}) {
  const t = useT();
  return (
    <div className="queue-wait" aria-label={t("thread.queueing")}>
      <span className="queue-wait-text">{t("thread.queueing")}</span>
      <span className="queue-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {onSend ? (
        <button type="button" className="queue-cancel" onClick={onSend}>
          {t("thread.sendQueued")}
        </button>
      ) : null}
      {onEdit ? (
        <button type="button" className="queue-cancel" onClick={onEdit}>
          {t("thread.editQueued")}
        </button>
      ) : null}
      {onCancel ? (
        <button type="button" className="queue-cancel" onClick={onCancel}>
          {t("thread.cancelQueued")}
        </button>
      ) : null}
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

function NewFromHere() {
  const t = useT();
  return (
    <div className="thread-new" data-resume-divider role="separator">
      <span>{t("thread.newFromHere")}</span>
    </div>
  );
}

function ThreadTime({ ts, label }: { ts: number; label: string }) {
  return (
    <time className="thread-time" dateTime={new Date(ts).toISOString()}>
      {label}
    </time>
  );
}

export function MsgActions({
  copy,
  ts = 0,
  onReply,
}: {
  copy?: string;
  ts?: number;
  onReply?: () => void;
}) {
  const { locale } = useLocale();
  const { day, time } = messageClockParts(ts, locale);
  if (!copy && !onReply) return null;
  return (
    <div className="msg-actions">
      {time ? (
        <time className="msg-time" dateTime={new Date(ts).toISOString()}>
          {day ? <span className="msg-time-day">{day}</span> : null}
          <span className="msg-time-clock">{time}</span>
        </time>
      ) : null}
      {copy ? <CopyButton text={copy} /> : null}
      {onReply ? <ReplyButton onClick={onReply} /> : null}
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
  selfId: string | null = null,
): string | null {
  const rows = threadRows(visibleMessages(messages, false, selfId), agents);
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
  selfId: string | null = null,
): ChatMessage[] {
  return messages.filter((m, i) => {
    if (isSelfMentionDelivery(m, selfId)) return false;
    if (!shownInThread(m)) return false;
    if (m.kind === "tool") return showTools;
    if (m.role !== "assistant") return true;
    const raw = m.text || "";
    if (isEnvelopeEcho(raw, messages[i - 1])) return false;
    if (isPlainEcho(raw, messages, i)) return false;
    return stripCrewMarkers(raw).length > 0 || !!m.choice;
  });
}
