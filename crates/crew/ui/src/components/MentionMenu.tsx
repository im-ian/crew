import { Fragment, useEffect, useRef, type CSSProperties } from "react";
import { useBotLabel } from "../BotLabelContext";
import { useT } from "../LocaleContext";
import type { AgentInfo } from "../types";
import { Avatar } from "./Avatar";

/**
 * The bots `@` offers. A mouse pick keeps the caret in the box it was typed in.
 * The first `near` share the open chat's group; a labelled line sets the
 * others apart, and each half is named.
 */
export function MentionMenu({
  bots,
  near = 0,
  active,
  onPick,
  className,
  style,
}: {
  bots: AgentInfo[];
  near?: number;
  active: number;
  onPick: (agent: AgentInfo) => void;
  className?: string;
  style?: CSSProperties;
}) {
  const labelOf = useBotLabel();
  const t = useT();
  // Both halves are there, so each gets its label.
  const split = near > 0 && near < bots.length;
  const menuRef = useRef<HTMLDivElement>(null);
  // The labels make the list taller than the menu, so the arrow keys bring
  // the row they land on into view.
  useEffect(() => {
    menuRef.current
      ?.querySelector<HTMLElement>(".mention-item.active")
      ?.scrollIntoView?.({ block: "nearest" });
  }, [active, bots]);
  return (
    <div
      ref={menuRef}
      className={"mention-menu" + (className ? " " + className : "")}
      role="listbox"
      style={style}
    >
      {bots.map((a, i) => (
        <Fragment key={a.id}>
          {split && i === 0 ? (
            <div className="mention-head" role="presentation">
              {t("mention.sameGroup")}
            </div>
          ) : null}
          {split && i === near ? (
            <div className="mention-head mention-sep" role="presentation">
              {t("mention.otherGroups")}
            </div>
          ) : null}
          <button
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
          </button>
        </Fragment>
      ))}
    </div>
  );
}
