import type { CSSProperties } from "react";
import { useBotLabel } from "../BotLabelContext";
import type { AgentInfo } from "../types";
import { Avatar } from "./Avatar";

/** The bots `@` offers. A mouse pick keeps the caret in the box it was typed in. */
export function MentionMenu({
  bots,
  active,
  onPick,
  className,
  style,
}: {
  bots: AgentInfo[];
  active: number;
  onPick: (agent: AgentInfo) => void;
  className?: string;
  style?: CSSProperties;
}) {
  const labelOf = useBotLabel();
  return (
    <div className={"mention-menu" + (className ? " " + className : "")} role="listbox" style={style}>
      {bots.map((a, i) => (
        <button
          key={a.id}
          type="button"
          role="option"
          aria-selected={i === active}
          className={"mention-item" + (i === active ? " active" : "")}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(a);
          }}
        >
          <Avatar
            className="mention-avatar"
            id={a.id}
            name={a.name || a.id}
            src={a.avatar}
            shape={a.avatar_shape}
            color={a.avatar_color}
          />
          <span className="mention-name">{labelOf(a)}</span>
          {/* A teammate's id is an account number; its server says more. */}
          {!a.remote && a.name && a.name !== a.id ? (
            <span className="mention-id">{a.id}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
