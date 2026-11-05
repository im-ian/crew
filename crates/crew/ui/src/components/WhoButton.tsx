import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { resolveFace } from "../avatar";
import { useT } from "../LocaleContext";
import { NAME_CLICK_MS } from "../rename";
import type { AgentInfo } from "../types";
import { Avatar } from "./Avatar";
import { RenameField } from "./RenameField";

type Props = {
  agent: AgentInfo | null;
  who: string;
  color?: string;
  letter?: string;
  fallbackId?: string;
  title?: string;
  onClick?: () => void;
  /** Set for a local bot. A double-click on the name edits it in place. */
  onRename?: (name: string) => void;
};

export function WhoButton({
  agent,
  who,
  color,
  letter,
  fallbackId,
  title,
  onClick,
  onRename,
}: Props) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const openTimer = useRef<number | null>(null);
  const editingId = useRef(agent?.id);
  const face = agent || letter;

  useEffect(() => {
    setEditing(false);
  }, [agent?.id]);

  useEffect(
    () => () => {
      if (openTimer.current) window.clearTimeout(openTimer.current);
    },
    [],
  );

  function clearOpen() {
    if (!openTimer.current) return;
    window.clearTimeout(openTimer.current);
    openTimer.current = null;
  }

  function onNameClick(e: MouseEvent) {
    if (!onRename || !onClick) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.detail > 1) {
      clearOpen();
      return;
    }
    clearOpen();
    openTimer.current = window.setTimeout(() => {
      openTimer.current = null;
      onClick();
    }, NAME_CLICK_MS);
  }

  function onNameDoubleClick(e: MouseEvent) {
    if (!onRename) return;
    e.preventDefault();
    e.stopPropagation();
    clearOpen();
    editingId.current = agent?.id;
    setEditing(true);
  }
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
      {editing && onRename ? (
        <RenameField
          value={who}
          className="who-name-input"
          label={t("menu.rename")}
          onCommit={(name) => {
            const id = editingId.current;
            setEditing(false);
            if (id && id === agent?.id) onRename(name);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <span
          className="who-name"
          onClick={onRename ? onNameClick : undefined}
          onDoubleClick={onRename ? onNameDoubleClick : undefined}
        >
          {who}
        </span>
      )}
    </>
  );
  const style = resolved
    ? ({ "--who-color": resolved } as CSSProperties)
    : undefined;
  if (onClick && !editing) {
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
    <div
      className={"who-btn" + (editing ? " is-renaming" : " is-static")}
      style={style}
      title={editing ? undefined : title || who}
    >
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
