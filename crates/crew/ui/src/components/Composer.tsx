import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentInfo, Kind } from "../types";
import { Avatar } from "./Avatar";

type Props = {
  agents: AgentInfo[];
  selected: string | null;
  selectedKind: Kind;
  placeholder: string;
  onSend: (raw: string) => Promise<void>;
};

type Mention = { start: number; query: string };

export function Composer({
  agents,
  selected,
  selectedKind,
  placeholder,
  onSend,
}: Props) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [mention, setMention] = useState<Mention | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);

  const matches = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    return agents
      .filter((a) => {
        if (selectedKind === "agent" && a.id === selected) return false;
        if (!q) return true;
        return (
          a.id.toLowerCase().includes(q) ||
          (a.name || "").toLowerCase().includes(q)
        );
      })
      .slice(0, 8);
  }, [agents, mention, selected, selectedKind]);

  function fit() {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  }

  function scanMention() {
    const el = inputRef.current;
    if (!el) return;
    const caret = el.selectionStart ?? el.value.length;
    const before = el.value.slice(0, caret);
    const m = before.match(/(^|[\s])@(\S*)$/);
    if (!m) {
      setMention(null);
      return;
    }
    const query = m[2];
    const start = before.length - query.length - 1;
    setMention((prev) => {
      if (prev && prev.start === start && prev.query === query) return prev;
      return { start, query };
    });
  }

  function pickMention(agent: AgentInfo) {
    const el = inputRef.current;
    if (!el || !mention) return;
    const caret = el.selectionStart ?? el.value.length;
    const label =
      agent.name && !/\s/.test(agent.name) ? agent.name : agent.id;
    const next =
      el.value.slice(0, mention.start) + "@" + label + " " + el.value.slice(caret);
    el.value = next;
    const pos = mention.start + label.length + 2;
    el.focus();
    el.setSelectionRange(pos, pos);
    setMention(null);
    fit();
  }

  useEffect(() => {
    fit();
  }, [placeholder]);

  useEffect(() => {
    setMentionIdx(0);
  }, [mention?.start, mention?.query]);

  useEffect(() => {
    if (mentionIdx >= matches.length) setMentionIdx(0);
  }, [mentionIdx, matches.length]);

  const mentionOpen = !!mention && matches.length > 0;

  return (
    <form
      className="composer"
      onSubmit={async (e) => {
        e.preventDefault();
        const el = inputRef.current;
        if (!el) return;
        const raw = el.value;
        if (!raw.trim()) return;
        el.value = "";
        setMention(null);
        fit();
        await onSend(raw);
      }}
    >
      <div className="composer-box">
        {mentionOpen ? (
          <div className="mention-menu" role="listbox">
            {matches.map((a, i) => (
              <button
                key={a.id}
                type="button"
                role="option"
                aria-selected={i === mentionIdx}
                className={
                  "mention-item" + (i === mentionIdx ? " active" : "")
                }
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickMention(a);
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
                <span className="mention-name">{a.name || a.id}</span>
                {a.name && a.name !== a.id ? (
                  <span className="mention-id">{a.id}</span>
                ) : null}
              </button>
            ))}
          </div>
        ) : null}
        <textarea
          ref={inputRef}
          rows={1}
          autoComplete="off"
          placeholder={placeholder}
          onInput={() => {
            fit();
            scanMention();
          }}
          onClick={scanMention}
          onKeyUp={scanMention}
          onKeyDown={(e) => {
            if (mentionOpen) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setMentionIdx((i) => (i + 1) % matches.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setMentionIdx((i) => (i - 1 + matches.length) % matches.length);
                return;
              }
              if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                e.preventDefault();
                const agent = matches[mentionIdx] ?? matches[0];
                if (agent) pickMention(agent);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setMention(null);
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              (e.currentTarget.form as HTMLFormElement | null)?.requestSubmit();
            }
          }}
        />
        <button type="submit" aria-label="보내기" disabled={!selected}>
          ↑
        </button>
      </div>
    </form>
  );
}
