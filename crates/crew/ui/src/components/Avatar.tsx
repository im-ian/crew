import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { avatarColor, initialOf } from "../avatar";

type Props = {
  id?: string | null;
  name?: string | null;
  src?: string | null;
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
  const color = id ? avatarColor(id) : "#3a3a3c";
  const cls = `avatar${showImg ? " has-img" : ""}${className ? ` ${className}` : ""}`;
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
      <span className="avatar-letter">{letter || initialOf(name)}</span>
      {badge ? <span className={`badge ${badge}`} /> : null}
      {overlay}
    </>
  );
  if (as === "button") {
    return (
      <button
        type="button"
        className={cls}
        style={{ background: color }}
        title={title}
        onClick={onClick}
      >
        {body}
      </button>
    );
  }
  return (
    <div className={cls} style={{ background: color }} title={title} onClick={onClick}>
      {body}
    </div>
  );
}
