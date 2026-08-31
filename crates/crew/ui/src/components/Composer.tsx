import { useEffect, useRef } from "react";
import type { AgentInfo, Kind } from "../types";

type Props = {
  agents: AgentInfo[];
  selected: string | null;
  selectedKind: Kind;
  placeholder: string;
  toId: string;
  onTo: (id: string) => void;
  onSend: (raw: string) => Promise<void>;
};

export function Composer({
  agents,
  selected,
  selectedKind,
  placeholder,
  toId,
  onTo,
  onSend,
}: Props) {
  const inputRef = useRef<HTMLTextAreaElement>(null);

  function fit() {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  }

  useEffect(() => {
    fit();
  }, [placeholder]);

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
        fit();
        await onSend(raw);
      }}
    >
      <div className="composer-box">
        <label className="to-wrap" hidden={selectedKind === "channel"}>
          <span className="sr-only">받는 이</span>
          <select
            title="받는 이"
            value={toId}
            onChange={(e) => onTo(e.target.value)}
          >
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name || a.id}
              </option>
            ))}
          </select>
        </label>
        <textarea
          ref={inputRef}
          rows={1}
          autoComplete="off"
          placeholder={placeholder}
          onInput={fit}
          onKeyDown={(e) => {
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
