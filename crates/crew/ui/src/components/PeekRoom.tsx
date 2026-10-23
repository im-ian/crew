import { useEffect, useMemo, useRef, useState } from "react";
import { resolveFace } from "../avatar";
import { splitBubbles } from "../bubbles";
import { useT } from "../LocaleContext";
import { messageDefinitions } from "../markdown";
import { Lock, X } from "../icons";
import { displayWho, peekMessages, subagentType } from "../peek";
import type { AgentInfo, ChatMessage } from "../types";
import { Avatar } from "./Avatar";
import { JumpBottom, useStick } from "./ChatThread";
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
  const agentIds = useMemo(
    () => new Set(agents.map((a) => a.id)),
    [agents],
  );
  const rows = useMemo(
    () => peekMessages(messages, peerId, self.id, agentIds),
    [messages, peerId, self.id, agentIds],
  );
  // A subagent is on no roster, but its id still gives it a face of its own.
  const peer =
    agents.find((a) => a.id === peerId) ??
    (subagentType(peerId)
      ? ({ id: peerId, name: displayWho(peerId, null, t) } as AgentInfo)
      : null);
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
          return (
            <MdBody
              key={m.id + "-" + i}
              className={"bubble md incoming" + stack}
              text={part}
              defs={defs}
              agents={agents}
              baseDir={agent?.cwd || undefined}
            />
          );
        })}
      </div>
    </div>
  );
}
