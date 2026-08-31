import type { CSSProperties } from "react";
import { resolveFace } from "../avatar";
import type { AgentInfo } from "../types";
import { Avatar } from "./Avatar";

type Props = {
  agent: AgentInfo | null;
  who: string;
  color?: string;
  letter?: string;
  fallbackId?: string;
  title?: string;
  onClick?: () => void;
};

export function WhoButton({
  agent,
  who,
  color,
  letter,
  fallbackId,
  title,
  onClick,
}: Props) {
  const face = agent || letter;
  const resolved =
    color ??
    (agent
      ? whoColor(resolveFace(agent.id, agent.avatar_shape, agent.avatar_color).color)
      : undefined);
  const inner = (
    <>
      {face ? (
        <Avatar
          as="div"
          className="who-avatar"
          id={agent?.id || fallbackId}
          name={who}
          src={agent?.avatar}
          shape={agent?.avatar_shape}
          color={agent?.avatar_color}
          letter={letter}
          status={agent?.status}
        />
      ) : null}
      <span className="who-name">{who}</span>
    </>
  );
  const style = resolved
    ? ({ "--who-color": resolved } as CSSProperties)
    : undefined;
  if (onClick) {
    return (
      <button
        type="button"
        className="who-btn"
        style={style}
        title={title || who}
        onClick={onClick}
      >
        {inner}
      </button>
    );
  }
  return (
    <div className="who-btn is-static" style={style}>
      {inner}
    </div>
  );
}

export function whoColor(hex: string): string {
  const n = hex.replace("#", "");
  if (n.length !== 6) return hex;
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  if (l >= 0.38) return hex;
  return `color-mix(in srgb, ${hex} 62%, white)`;
}
