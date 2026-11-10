import { Fragment, type CSSProperties } from "react";
import { useBotLabel } from "../BotLabelContext";
import { useT } from "../LocaleContext";
import type { AgentInfo } from "../types";
import { Avatar } from "./Avatar";

/**
 * The bots `@` offers. A mouse pick keeps the caret in the box it was typed in.
 * The first `near` share the open chat's group; a labelled line sets the others apart, and each half is named.
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
  return (
    <div className={"mention-menu" + (className ? " " + className : "")} role="listbox" style={style}>
      {bots.map((a, i) => (
        <Fragment key={a.id}>
          {split && i === 0 ? <div className="mention-head">{t("mention.sameGroup")}</div> : null}
          {split && i === near ? (
            <div className="mention-head mention-sep" role="separator">
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
            {/* A teammate's id is an account number; its server says more. */}
            {!a.remote && a.name && a.name !== a.id ? (
              <span className="mention-id">{a.id}</span>
            ) : null}
          </button>
        </Fragment>
      ))}
    </div>
  );
}
