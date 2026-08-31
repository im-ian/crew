import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { avatarColor, initialOf, resolveFace } from "../avatar";
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
  if (badge === "working" || badge === "blocked" || badge === "exited") {
    return <span className={`badge ${badge}`} />;
  }
  return null;
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
  const letterBg = id ? avatarColor(id) : "#3a3a3c";
  const cls = `avatar${showImg ? " has-img" : ""}${showFace ? " has-face" : ""}${className ? ` ${className}` : ""}`;
  const body = (
    <>
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
          status={faceStatus(status, badge)}
        />
      ) : null}
      {!showFace ? (
        <span className="avatar-letter">{letter || initialOf(name)}</span>
      ) : null}
      {statusDot(badge)}
      {overlay}
    </>
  );
  const style = showFace ? undefined : { background: letterBg };
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
