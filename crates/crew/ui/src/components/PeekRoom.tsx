import { useEffect, useMemo, useRef } from "react";
import { resolveFace } from "../avatar";
import { splitBubbles } from "../bubbles";
import { useT } from "../LocaleContext";
import { Lock } from "../icons";
import { peekMessages } from "../peek";
import type { AgentInfo, ChannelInfo, ChatMessage } from "../types";
import { Avatar } from "./Avatar";
import { MdBody } from "./MdBody";
import { WhoButton, whoColor } from "./WhoButton";

type Props = {
  peerId: string;
  self: AgentInfo;
  messages: ChatMessage[];
  agents: AgentInfo[];
  channels?: ChannelInfo[];
  onClose: () => void;
};

export function PeekRoom({
  peerId,
  self,
  messages,
  agents,
  channels = [],
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

  useEffect(() => {
    roomRef.current?.focus();
  }, [peerId]);

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [tail]);

  return (
    <div
      ref={roomRef}
      className="peek-room"
      role="dialog"
      aria-modal="true"
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
      </header>
      <div className="thread peek-thread" ref={threadRef}>
        {rows.map((m) => {
          const agent =
            agents.find((a) => a.id === m.from) ??
            (m.from === self.id ? self : null);
          const who = agent?.name || agent?.id || m.from;
          return (
            <PeekBubble
              key={m.id}
              message={m}
              agent={agent}
              who={who}
              agents={agents}
              channels={channels}
            />
          );
        })}
      </div>
      <div className="peek-foot">
        <p className="peek-note">
          <Lock size={14} />
          <span>{t("thread.peekReadOnly")}</span>
        </p>
        <button type="button" className="peek-close" onClick={onClose}>
          {t("thread.peekClose")}
        </button>
      </div>
    </div>
  );
}

function PeekBubble({
  message: m,
  agent,
  who,
  agents,
  channels,
}: {
  message: ChatMessage;
  agent: AgentInfo | null;
  who: string;
  agents: AgentInfo[];
  channels: ChannelInfo[];
}) {
  const color = agent
    ? whoColor(
        resolveFace(agent.id, agent.avatar_shape, agent.avatar_color).color,
      )
    : undefined;
  const parts = splitBubbles(m.text || "");
  return (
    <div className="row them incoming" data-msg-id={m.id}>
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
              agents={agents}
              channels={channels}
              baseDir={agent?.cwd || undefined}
            />
          );
        })}
      </div>
    </div>
  );
}
