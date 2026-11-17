import { useBotLabel } from "../BotLabelContext";
import { useLocale, useT } from "../LocaleContext";
import { resolveFace } from "../avatar";
import { messageClockParts } from "../clock";
import { workDir } from "../fileRef";
import type { IdleCard as IdleCardData } from "../idleTypes";
import { displayWho } from "../peek";
import type { AgentInfo } from "../types";
import { Avatar } from "./Avatar";
import { MdBody } from "./MdBody";
import { whoColor } from "./WhoButton";

type Props = {
  card: IdleCardData;
  agent: AgentInfo | null;
  agents: AgentInfo[];
  /** A 1:1 room draws the face on the latest line only. */
  showFace: boolean;
  /** A 1:1 room leaves the name off. */
  showName: boolean;
  lookAtCaret?: boolean;
  onSelectAgent?: (id: string) => void;
};

/**
 * The stall reads as that bot talking. The bubble matches an ordinary incoming
 * line; the border is dashed and the fill is clear. It is not a transcript
 * message, so it has no copy button and no reply.
 */
export function IdleCard({
  card,
  agent,
  agents,
  showFace,
  showName,
  lookAtCaret = false,
  onSelectAgent,
}: Props) {
  const t = useT();
  const labelOf = useBotLabel();
  const who = agent ? displayWho(agent.id, agent, t, labelOf) : "";
  const color = agent
    ? whoColor(resolveFace(agent.id, agent.avatar_shape, agent.avatar_color).color)
    : undefined;
  const open =
    showName && onSelectAgent && agent ? () => onSelectAgent(agent.id) : undefined;
  return (
    <div
      className={
        "row them incoming" + (showFace && !showName ? " face-end" : "")
      }
      data-msg-id={card.id}
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
          lookAtCaret={lookAtCaret}
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
          <div className="channel-who" style={color ? { color } : undefined}>
            {who}
          </div>
        )}
        <div className="bubble-stack">
          <div className="bubble-row has-actions">
            <MdBody
              className="bubble md incoming idle"
              text={card.body}
              agents={agents}
              onMention={onSelectAgent}
              baseDir={workDir(agent)}
            />
            <IdleTime ts={card.activityTs} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** The same hover clock as a message, without copy or reply. */
function IdleTime({ ts }: { ts: number }) {
  const { locale } = useLocale();
  const { day, time } = messageClockParts(ts, locale);
  if (!time) return null;
  return (
    <div className="msg-actions">
      <time className="msg-time" dateTime={new Date(ts).toISOString()}>
        {day ? <span className="msg-time-day">{day}</span> : null}
        <span className="msg-time-clock">{time}</span>
      </time>
    </div>
  );
}
