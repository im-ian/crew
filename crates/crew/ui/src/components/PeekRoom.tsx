import { useEffect, useMemo, useRef, useState } from "react";
import { resolveFace } from "../avatar";
import { splitBubbles } from "../bubbles";
import { useT } from "../LocaleContext";
import { messageDefinitions } from "../markdown";
import { Lock, X } from "../icons";
import { peekMessages } from "../peek";
import type { AgentInfo, ChatMessage } from "../types";
import { Avatar } from "./Avatar";
import { MdBody } from "./MdBody";
import { WhoButton, whoColor } from "./WhoButton";

type Props = {
  peerId: string;
  /** The run that was clicked: scrolled to and flashed. */
  focus?: string[];
  self: AgentInfo;
  messages: ChatMessage[];
  agents: AgentInfo[];
  onClose: () => void;
};

export function PeekRoom({
  peerId,
  focus = [],
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
  const peer = agents.find((a) => a.id === peerId) ?? null;
  const selfName = self.name || self.id;
  const peerName = peer?.name || peerId;
  const tail =
    rows.length +
    ":" +
    (rows[rows.length - 1]?.id || "") +
    ":" +
    (rows[rows.length - 1]?.text || "");

  // Beside the thread the reader may be partway up an old run when a new
  // note lands; only follow the tail if they were already at it.
  const atBottom = useRef(true);
  const focusKey = focus.join(",");

  useEffect(() => {
    roomRef.current?.focus();
  }, [peerId]);

  useEffect(() => {
    const el = threadRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [tail]);

  useEffect(() => {
    const el = threadRef.current;
    const first = focus[0];
    if (!el || !first) return;
    el.querySelector(`[data-msg-id="${CSS.escape(first)}"]`)?.scrollIntoView({
      block: "start",
    });
  }, [peerId, focusKey]);

  // The flash ring is a static style under its animation, so it has to come
  // off on the same clock the thread uses or the run stays outlined.
  const [flashing, setFlashing] = useState(true);
  useEffect(() => {
    setFlashing(true);
    const id = window.setTimeout(() => setFlashing(false), 1600);
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
            letter={peer ? undefined : peerName.slice(0, 1) || "?"}
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
      <div
        className="thread peek-thread"
        ref={threadRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {rows.map((m) => {
          const agent =
            agents.find((a) => a.id === m.from) ??
            (m.from === self.id ? self : null);
          const who =
            agent?.name ||
            agent?.id ||
            (m.from === "user" ? t("thread.you") : m.from);
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
