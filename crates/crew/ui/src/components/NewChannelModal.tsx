import { useEffect, useRef, useState } from "react";
import type { AgentInfo } from "../types";
import { Field } from "./Field";
import { Modal } from "./Modal";

type Props = {
  open: boolean;
  agents: AgentInfo[];
  onClose: () => void;
  onCreate: (name: string, members: string[]) => Promise<void>;
};

export function NewChannelModal({ open, agents, onClose, onCreate }: Props) {
  const [name, setName] = useState("");
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const agentsRef = useRef(agents);
  agentsRef.current = agents;

  useEffect(() => {
    if (!open) return;
    setName("");
    const next: Record<string, boolean> = {};
    for (const a of agentsRef.current) next[a.id] = true;
    setChecked(next);
    setBusy(false);
    const t = window.setTimeout(() => nameRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [open]);

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed) {
      nameRef.current?.focus();
      await onCreate("", []);
      return;
    }
    const members = Object.entries(checked)
      .filter(([, on]) => on)
      .map(([id]) => id);
    setBusy(true);
    try {
      await onCreate(trimmed, members);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} title="새 채널" onClose={onClose}>
      <div className="form-stack">
        <Field label="이름" htmlFor="new-channel-name">
          <input
            id="new-channel-name"
            ref={nameRef}
            className="textin"
            placeholder="예: 프론트엔드"
            autoComplete="off"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submit();
              }
            }}
          />
        </Field>
        <Field label="멤버">
          <div className="member-list">
            {!agents.length ? (
              <div className="member-empty">에이전트가 없습니다</div>
            ) : (
              agents.map((a) => (
                <label key={a.id}>
                  <input
                    type="checkbox"
                    checked={!!checked[a.id]}
                    onChange={(e) =>
                      setChecked((prev) => ({ ...prev, [a.id]: e.target.checked }))
                    }
                  />
                  <span>{a.name || a.id}</span>
                </label>
              ))
            )}
          </div>
        </Field>
      </div>
      <div className="actions spread">
        <button type="button" className="ghost" onClick={onClose}>
          취소
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => void submit()}
        >
          만들기
        </button>
      </div>
    </Modal>
  );
}
