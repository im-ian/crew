import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { avatarColor, initialOf, resolveFace } from "../avatar";
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
  title?: string;
  overlay?: ReactNode;
  as?: "div" | "button";
  onClick?: (e: MouseEvent) => void;
};

export function Avatar({
  id,
  name,
  src,
  shape,
  color,
  letter,
  className,
  badge,
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
      {face ? <BotFace shape={face.shape} color={face.color} /> : null}
      {!showFace ? (
        <span className="avatar-letter">{letter || initialOf(name)}</span>
      ) : null}
      {badge ? <span className={`badge ${badge}`} /> : null}
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
  return (
    <div className={cls} style={style} title={title} onClick={onClick}>
      {body}
    </div>
  );
}
