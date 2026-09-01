import { useEffect, useRef, useState } from "react";
import type { AgentInfo, ChannelInfo } from "../types";
import { Field } from "./Field";

type Props = {
  open: boolean;
  channel: ChannelInfo | null;
  agents: AgentInfo[];
  onClose: () => void;
  onSave: (fields: {
    name: string;
    brief: string;
    members: string[];
  }) => Promise<void>;
};

export function ChannelPane({ open, channel, agents, onClose, onSave }: Props) {
  const [name, setName] = useState("");
  const [brief, setBrief] = useState("");
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const saveTimer = useRef<number | null>(null);
  const fieldsRef = useRef({ name, brief, checked });
  fieldsRef.current = { name, brief, checked };

  useEffect(() => {
    if (!open || !channel) return;
    setName(channel.name || channel.id || "");
    setBrief(channel.brief || "");
    const next: Record<string, boolean> = {};
    for (const a of agents) next[a.id] = channel.members.includes(a.id);
    setChecked(next);
  }, [open, channel?.id, agents.length]);

  function membersOf(map: Record<string, boolean>) {
    return Object.entries(map)
      .filter(([, on]) => on)
      .map(([id]) => id);
  }

  function scheduleSave(next?: Partial<typeof fieldsRef.current>) {
    const merged = { ...fieldsRef.current, ...next };
    fieldsRef.current = merged;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void onSave({
        name: merged.name,
        brief: merged.brief,
        members: membersOf(merged.checked),
      });
    }, 400);
  }

  async function flushSave(next?: Partial<typeof fieldsRef.current>) {
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const merged = { ...fieldsRef.current, ...next };
    fieldsRef.current = merged;
    await onSave({
      name: merged.name,
      brief: merged.brief,
      members: membersOf(merged.checked),
    });
  }

  return (
    <div
      className={"overlay" + (open ? " open" : "")}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="sheet agent-sheet">
        <div className="sheet-head">
          <h3>{channel?.name || channel?.id || "채널"}</h3>
          <button
            type="button"
            className="sheet-close"
            title="닫기"
            aria-label="닫기"
            onClick={onClose}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M4 4l8 8M12 4l-8 8"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
        <div className="sheet-body">
          <div className="form-stack">
            <Field label="이름" htmlFor="channel-name">
              <input
                id="channel-name"
                className="textin"
                placeholder="예: 프론트엔드"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  scheduleSave({ name: e.target.value });
                }}
                onBlur={() => void flushSave()}
              />
            </Field>
            <Field label="브리프" htmlFor="channel-brief">
              <textarea
                id="channel-brief"
                className="textin memory"
                placeholder="이 방에서 봇들이 기억할 일, 규칙, 배경"
                value={brief}
                onChange={(e) => {
                  setBrief(e.target.value);
                  scheduleSave({ brief: e.target.value });
                }}
                onBlur={() => void flushSave()}
              />
            </Field>
            <Field label="멤버">
              <div className="member-list">
                {!agents.length ? (
                  <div className="member-empty">봇이 없습니다</div>
                ) : (
                  agents.map((a) => (
                    <label key={a.id}>
                      <input
                        type="checkbox"
                        checked={!!checked[a.id]}
                        onChange={(e) => {
                          const next = { ...checked, [a.id]: e.target.checked };
                          setChecked(next);
                          void flushSave({ checked: next });
                        }}
                      />
                      <span>{a.name || a.id}</span>
                    </label>
                  ))
                )}
              </div>
            </Field>
            <p className="apply-note">멤버만 이 방 대화에 참여합니다.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
