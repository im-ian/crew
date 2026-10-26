import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { resolveFace } from "../avatar";
import { splitBubbles } from "../bubbles";
import { useT } from "../LocaleContext";
import { messageDefinitions } from "../markdown";
import { Lock, X } from "../icons";
import { displayWho, peekMessages, subagentFace } from "../peek";
import { clampPeek, PEEK_MIN, peekMax } from "../peekWidth";
import type { AgentInfo, ChatMessage } from "../types";
import { Avatar } from "./Avatar";
import { JumpBottom, MsgActions, useStick } from "./ChatThread";
import { MdBody } from "./MdBody";
import { WhoButton, whoColor } from "./WhoButton";

type Props = {
  peerId: string;
  /** The run that was clicked: flashed. */
  focus?: string[];
  /** Open on `focus` instead of the bottom: a search hit. */
  openAtFocus?: boolean;
  self: AgentInfo;
  messages: ChatMessage[];
  agents: AgentInfo[];
  onClose: () => void;
};

export function PeekRoom({
  peerId,
  focus = [],
  openAtFocus = false,
  self,
  messages,
  agents,
  onClose,
}: Props) {
  const t = useT();
  const roomRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const [preferred, setPreferred] = useState<number | null>(null);
  const [mainW, setMainW] = useState(0);
  const [boxW, setBoxW] = useState(PEEK_MIN);
  const drag = useRef<{ startX: number; startW: number } | null>(null);
  const shown = preferred == null || mainW <= 0 ? null : clampPeek(preferred, mainW);

  function peekMain(): HTMLElement | null {
    const main = roomRef.current?.closest("main");
    return main instanceof HTMLElement ? main : null;
  }

  useLayoutEffect(() => {
    const room = roomRef.current;
    const main = peekMain();
    if (!room || !main) return;
    const apply = () => {
      setMainW(main.clientWidth);
      const w = Math.round(room.getBoundingClientRect().width);
      if (w > 0) setBoxW(w);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(main);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const main = peekMain();
    if (!main) return;
    if (shown == null) main.style.removeProperty("--peek-w");
    else main.style.setProperty("--peek-w", `${shown}px`);
    return () => {
      main.style.removeProperty("--peek-w");
    };
  }, [shown]);

  useEffect(() => {
    return () => document.documentElement.classList.remove("peek-resizing");
  }, []);

  function setWidth(next: number | null) {
    if (next == null) {
      setPreferred(null);
      return;
    }
    const main = peekMain()?.clientWidth ?? mainW;
    setPreferred(clampPeek(next, main));
  }

  function onResizePointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const startW = shown ?? roomRef.current?.getBoundingClientRect().width ?? PEEK_MIN;
    drag.current = { startX: e.clientX, startW };
    document.documentElement.classList.add("peek-resizing");
  }

  function onResizePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (!current) return;
    // The room sits on the right, so dragging left widens it.
    setWidth(current.startW - (e.clientX - current.startX));
  }

  function onResizePointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    drag.current = null;
    document.documentElement.classList.remove("peek-resizing");
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  }

  function onResizeKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    const step = e.shiftKey ? 32 : 16;
    const base = shown ?? roomRef.current?.getBoundingClientRect().width ?? boxW;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      setWidth(base + step);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      setWidth(base - step);
    } else if (e.key === "Home") {
      e.preventDefault();
      setWidth(PEEK_MIN);
    } else if (e.key === "End") {
      e.preventDefault();
      const main = peekMain()?.clientWidth ?? mainW;
      setWidth(peekMax(main));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setWidth(null);
    }
  }

  const agentIds = useMemo(
    () => new Set(agents.map((a) => a.id)),
    [agents],
  );
  const rows = useMemo(
    () => peekMessages(messages, peerId, self.id, agentIds),
    [messages, peerId, self.id, agentIds],
  );
  const peer =
    agents.find((a) => a.id === peerId) ?? subagentFace(peerId, t);
  const selfName = self.name || self.id;
  const peerName = displayWho(peerId, peer, t);

  // Beside the thread the reader may be partway up an old run when a new
  // note lands; only follow the tail if they were already at it.
  const atBottom = useRef(true);
  const { away, sync, jump } = useStick(threadRef, (stick) => {
    atBottom.current = stick;
  });
  const focusKey = focus.join(",");

  useEffect(() => {
    roomRef.current?.focus();
  }, [peerId]);

  // Every poll, not only a new note: an image grows its row when it loads,
  // after the scroll, and that moves no scroll position to report it.
  useEffect(() => {
    const el = threadRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
    sync();
  }, [rows]);

  // Each open starts at the bottom, where the next note lands. Opening on the
  // clicked run left the reader above the tail, so new notes landed out of
  // sight. A search hit is the one exception: the panel opens on it.
  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    const first = openAtFocus ? focus[0] : null;
    const at = first
      ? el.querySelector(`[data-msg-id="${CSS.escape(first)}"]`)
      : null;
    if (at) at.scrollIntoView({ block: "start" });
    else el.scrollTop = el.scrollHeight;
    // A switch keeps this panel mounted, and a scroll that moves nothing
    // fires no event, so the last bot's position would carry over.
    sync();
  }, [peerId, focusKey, openAtFocus]);

  // The flash ring is a static style under its animation, so it has to come
  // off on the same clock the thread uses or the run stays outlined.
  // `.peek-thread` runs `msg-flash` for 3s; drop the class just after.
  const [flashing, setFlashing] = useState(true);
  useEffect(() => {
    setFlashing(true);
    const id = window.setTimeout(() => setFlashing(false), 3100);
    return () => window.clearTimeout(id);
  }, [peerId, focusKey]);
  const flash = new Set(flashing ? focus : []);

  return (
    <div
      ref={roomRef}
      className="peek-room"
      role="complementary"
      aria-labelledby="peek-title"
      tabIndex={-1}
    >
      <div className="titlebar-align" data-tauri-drag-region />
      <header className="peek-head">
        <h2 id="peek-title" className="sr-only">
          {selfName} · {peerName}
        </h2>
        <div className="peek-pair">
          <WhoButton agent={self} who={selfName} />
          <span className="peek-swap" aria-hidden="true">
            {"\u2194"}
          </span>
          <WhoButton
            agent={peer}
            who={peerName}
            letter={peer ? undefined : "?"}
            fallbackId={peerId}
          />
        </div>
        <button
          type="button"
          className="head-action"
          title={t("thread.peekClose")}
          aria-label={t("thread.peekClose")}
          onClick={onClose}
        >
          <X />
        </button>
      </header>
      <div className="thread-wrap">
        <div className="thread peek-thread" ref={threadRef} onScroll={sync}>
          {rows.map((m) => {
            const agent =
              agents.find((a) => a.id === m.from) ??
              (m.from === self.id ? self : m.from === peerId ? peer : null);
            const who =
              m.from === "user" ? t("thread.you") : displayWho(m.from, agent, t);
            return (
              <PeekBubble
                key={m.id}
                message={m}
                agent={agent}
                who={who}
                agents={agents}
                flash={flash.has(m.id)}
              />
            );
          })}
        </div>
        {away ? <JumpBottom onClick={jump} /> : null}
      </div>
      <div className="peek-foot">
        <p className="peek-note">
          <Lock size={14} />
          <span>{t("thread.peekReadOnly")}</span>
        </p>
      </div>
      <div
        className="peek-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label={t("thread.peekResize")}
        aria-valuemin={PEEK_MIN}
        aria-valuemax={peekMax(mainW)}
        aria-valuenow={Math.round(shown ?? boxW)}
        tabIndex={0}
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerUp}
        onPointerCancel={onResizePointerUp}
        onDoubleClick={() => setWidth(null)}
        onKeyDown={onResizeKeyDown}
      />
    </div>
  );
}

function PeekBubble({
  message: m,
  agent,
  who,
  agents,
  flash = false,
}: {
  message: ChatMessage;
  agent: AgentInfo | null;
  who: string;
  agents: AgentInfo[];
  flash?: boolean;
}) {
  const color = agent
    ? whoColor(
        resolveFace(agent.id, agent.avatar_shape, agent.avatar_color).color,
      )
    : undefined;
  const parts = splitBubbles(m.text || "");
  const defs = useMemo(() => messageDefinitions(m.text || ""), [m.text]);
  return (
    <div
      className={"row them incoming" + (flash ? " flash" : "")}
      data-msg-id={m.id}
    >
      {agent ? (
        <Avatar
          className="msg-avatar"
          id={agent.id}
          name={agent.name || agent.id}
          src={agent.avatar}
          shape={agent.avatar_shape}
          color={agent.avatar_color}
          status={agent.status}
          title={who}
        />
      ) : null}
      <div className="channel-msg">
        <div
          className="channel-who"
          style={color ? { color } : undefined}
        >
          {who}
        </div>
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
            const copy = part.trim();
            return (
              <div
                key={m.id + "-" + i}
                className={"bubble-row" + (copy ? " has-actions" : "")}
              >
                <MdBody
                  className={"bubble md incoming" + stack}
                  text={part}
                  defs={defs}
                  agents={agents}
                  baseDir={agent?.cwd || undefined}
                />
                {copy ? <MsgActions copy={copy} ts={m.ts} /> : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
