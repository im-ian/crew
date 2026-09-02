import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { avatarColor, avatarPhase, initialOf, resolveFace } from "../avatar";
import type { AgentInfo, AgentStatus, ChannelInfo } from "../types";
import { BotFace } from "./BotFace";

type Props = {
  id?: string | null;
  name?: string | null;
  src?: string | null;
  shape?: string | null;
  color?: string | null;
  letter?: string;
  className?: string;
  badge?: string | null;
  status?: AgentStatus | null;
  title?: string;
  overlay?: ReactNode;
  as?: "div" | "button" | "span";
  onClick?: (e: MouseEvent) => void;
};

function faceStatus(
  status?: AgentStatus | null,
  badge?: string | null,
): AgentStatus | null {
  const s = status || badge;
  if (s === "idle" || s === "working" || s === "blocked" || s === "exited") {
    return s;
  }
  return null;
}

function statusDot(badge?: string | null) {
  if (badge === "exited") {
    return <span className="badge exited" />;
  }
  return null;
}

function StatusOrbit({
  status,
  half,
}: {
  status: AgentStatus | null;
  half: "back" | "front";
}) {
  if (status !== "working" && status !== "blocked") return null;
  return (
    <span className={`avatar-orbit is-${status} is-${half}`} aria-hidden>
      <i>
        <b />
      </i>
      {status === "blocked" ? <u /> : null}
    </span>
  );
}

export function Avatar({
  id,
  name,
  src,
  shape,
  color,
  letter,
  className,
  badge,
  status,
  title,
  overlay,
  as = "div",
  onClick,
}: Props) {
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    setBroken(false);
  }, [src]);
  const showImg = !!src && !broken;
  const showFace = !showImg && !letter;
  const face = showFace ? resolveFace(id, shape, color) : null;
  const live = faceStatus(status, badge);
  const letterBg = id ? avatarColor(id) : "#3a3a3c";
  const cls = [
    "avatar",
    showImg ? "has-img" : "",
    showFace ? "has-face" : "",
    live === "working" ? "is-working" : "",
    live === "blocked" ? "is-blocked" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  const body = (
    <>
      <StatusOrbit status={live} half="back" />
      {showImg ? (
        <img
          className="avatar-img"
          src={src ?? ""}
          alt=""
          onError={() => setBroken(true)}
        />
      ) : null}
      {face ? (
        <BotFace
          id={id}
          shape={face.shape}
          color={face.color}
          status={live}
        />
      ) : null}
      {!showFace ? (
        <span className="avatar-letter">{letter || initialOf(name)}</span>
      ) : null}
      <StatusOrbit status={live} half="front" />
      {statusDot(badge)}
      {overlay}
    </>
  );
  const style = {
    ...(showFace ? null : { background: letterBg }),
    ["--avatar-phase" as string]: String(avatarPhase(id)),
  };
  if (as === "button") {
    return (
      <button
        type="button"
        className={cls}
        style={style}
        title={title}
        onClick={onClick}
      >
        {body}
      </button>
    );
  }
  const Tag = as === "span" ? "span" : "div";
  return (
    <Tag className={cls} style={style} title={title} onClick={onClick}>
      {body}
    </Tag>
  );
}

export function ChannelAvatar({
  channel,
  agents,
  className,
}: {
  channel: ChannelInfo;
  agents: AgentInfo[];
  className?: string;
}) {
  const members = channel.members
    .map((id) => agents.find((a) => a.id === id))
    .filter((a): a is AgentInfo => !!a);
  if (!members.length) {
    return (
      <Avatar
        className={className}
        id={channel.id}
        name={channel.name || channel.id}
        letter="#"
      />
    );
  }
  const shown = members.slice(0, 3);
  return (
    <span
      className={"channel-faces" + (className ? " " + className : "")}
      data-count={shown.length}
      title={channel.name || channel.id}
    >
      {shown.map((a) => (
        <Avatar
          key={a.id}
          as="span"
          className="channel-face"
          id={a.id}
          name={a.name || a.id}
          src={a.avatar}
          shape={a.avatar_shape}
          color={a.avatar_color}
        />
      ))}
    </span>
  );
}
