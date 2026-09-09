import { useEffect, useRef, useState } from "react";
import { mentionLabel } from "../mentions";
import { useT } from "../LocaleContext";
import type { AgentInfo } from "../types";
import { Avatar } from "./Avatar";
import { Plus, X } from "../icons";

type Props = {
  agents: AgentInfo[];
  selected: string[];
  onChange: (ids: string[]) => void;
};

export function MemberPicker({ agents, selected, onChange }: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const chosen = new Set(selected);
  const picked = selected
    .map((id) => agents.find((a) => a.id === id))
    .filter((a): a is AgentInfo => !!a);
  const rest = agents.filter((a) => !chosen.has(a.id));

  useEffect(() => {
    if (!rest.length) setOpen(false);
  }, [rest.length]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!agents.length) {
    return <div className="member-empty">{t("channel.noBots")}</div>;
  }

  return (
    <div ref={boxRef} className={"member-picker" + (open ? " is-open" : "")}>
      <div className="member-picker-row">
        <button
          type="button"
          className={"attach-btn" + (open ? " is-open" : "")}
          title={t("channel.addMember")}
          aria-label={t("channel.addMember")}
          aria-expanded={open}
          disabled={!rest.length}
          onClick={() => setOpen((v) => !v)}
        >
          <Plus />
        </button>
        {picked.length ? (
          picked.map((a) => {
            const label = mentionLabel(a);
            return (
              <button
                key={a.id}
                type="button"
                className="mention-chip member-chip"
                title={t("channel.removeMember", { name: label })}
                aria-label={t("channel.removeMember", { name: label })}
                onClick={() => onChange(selected.filter((id) => id !== a.id))}
              >
                <Avatar
                  as="span"
                  className="mention-chip-avatar"
                  id={a.id}
                  name={label}
                  src={a.avatar}
                  shape={a.avatar_shape}
                  color={a.avatar_color}
                />
                <span className="mention-chip-name">{label}</span>
                <span className="member-chip-x" aria-hidden="true">
                  <X size={10} />
                </span>
              </button>
            );
          })
        ) : (
          <span className="member-picker-ph">{t("channel.addMember")}</span>
        )}
      </div>
      {open && rest.length ? (
        <div className="mention-menu" role="listbox">
          {rest.map((a) => {
            const label = mentionLabel(a);
            return (
              <button
                key={a.id}
                type="button"
                role="option"
                className="mention-item"
                onClick={() => {
                  onChange([...selected, a.id]);
                  if (rest.length <= 1) setOpen(false);
                }}
              >
                <Avatar
                  className="mention-avatar"
                  id={a.id}
                  name={label}
                  src={a.avatar}
                  shape={a.avatar_shape}
                  color={a.avatar_color}
                />
                <span className="mention-name">{label}</span>
                {a.name && a.name !== a.id ? (
                  <span className="mention-id">{a.id}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
