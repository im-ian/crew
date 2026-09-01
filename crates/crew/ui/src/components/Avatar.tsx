import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { avatarColor, avatarPhase, initialOf, resolveFace } from "../avatar";
import type { AgentStatus } from "../types";
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
