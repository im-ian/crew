import { useEffect, useMemo, useRef, useState } from "react";
import { resolveFace } from "../avatar";
import { splitBubbles } from "../bubbles";
import { useT } from "../LocaleContext";
import { useBotLabel } from "../BotLabelContext";
import { messageDefinitions } from "../markdown";
import { Lock, X } from "../icons";
import { displayWho, peekMessages, subagentFace } from "../peek";
import type { AgentInfo, ChatMessage } from "../types";
import { Avatar } from "./Avatar";
import { JumpBottom, MsgActions, useResized, useStick } from "./ChatThread";
import { MdBody } from "./MdBody";
import { workDir } from "../fileRef";
import { SidePane } from "./SidePane";
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
  const labelOf = useBotLabel();
  const threadRef = useRef<HTMLDivElement>(null);

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
  const peerName = displayWho(peerId, peer, t, labelOf);

  // Beside the thread the reader may be partway up an old run when a new
  // note lands; only follow the tail if they were already at it.
  const atBottom = useRef(true);
  const { away, sync, jump, pin } = useStick(threadRef, (stick) => {
    atBottom.current = stick;
  });
  const focusKey = focus.join(",");

  // An image grows its row when it loads, after the scroll, and that moves
  // no scroll position to report it.
  const resized = useRef(() => {});
  resized.current = () => {
    if (atBottom.current) pin();
  };
  useResized(threadRef, resized, [peerId]);

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
    // Opened on a hit, the panel stays there. Only a move up turns following
    // off, and a jump down onto the hit is not one.
    atBottom.current = !at;
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
    <SidePane labelledBy="peek-title" focusKey={peerId}>
      <div className="titlebar-align" data-tauri-drag-region />
      <header className="peek-head" data-tauri-drag-region="deep">
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
              m.from === "user" ? t("thread.you") : displayWho(m.from, agent, t, labelOf);
            return (
              <PeekBubble
                key={m.id}
                message={m}
                agent={agent}
                who={who}
                agents={agents}
                own={m.from === self.id}
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
    </SidePane>
  );
}

function PeekBubble({
  message: m,
  agent,
  who,
  agents,
  own = false,
  flash = false,
}: {
  message: ChatMessage;
  agent: AgentInfo | null;
  who: string;
  agents: AgentInfo[];
  /** This room's bot. Its lines sit on the right: it is the one speaking. */
  own?: boolean;
  flash?: boolean;
}) {
  const color = agent
    ? whoColor(
        resolveFace(agent.id, agent.avatar_shape, agent.avatar_color).color,
      )
    : undefined;
  const parts = splitBubbles(m.text || "");
  const defs = useMemo(() => messageDefinitions(m.text || ""), [m.text]);
  const face = agent ? (
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
  ) : null;
  return (
    <div
      className={
        "row them incoming" + (own ? " own" : "") + (flash ? " flash" : "")
      }
      data-msg-id={m.id}
    >
      {own ? null : face}
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
                  baseDir={workDir(agent)}
                />
                {copy ? <MsgActions copy={copy} ts={m.ts} /> : null}
              </div>
            );
          })}
        </div>
      </div>
      {own ? face : null}
    </div>
  );
}
