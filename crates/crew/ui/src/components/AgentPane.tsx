import { useEffect, useState } from "react";
import type { AgentInfo, PaneTab, Routine } from "../types";
import { Field } from "./Field";
import { InfoPane } from "./InfoPane";
import { RoutinesModal } from "./RoutinesModal";

const TABS: { id: PaneTab; label: string }[] = [
  { id: "info", label: "봇 정보" },
  { id: "routines", label: "루틴" },
  { id: "memory", label: "메모리" },
];

type Props = {
  open: boolean;
  tab: PaneTab;
  agent: AgentInfo | null;
  onTab: (tab: PaneTab) => void;
  onClose: () => void;
  onReset: () => void;
  onSetFace: (shape?: string | null, color?: string | null) => Promise<void>;
  onSave: (fields: {
    title: string;
    role: string;
    description: string;
    model: string;
    effort: string;
  }) => Promise<void>;
  onAddRoutine: (name: string, schedule: string, prompt: string) => Promise<void>;
  onToggleRoutine: (r: Routine) => Promise<void>;
  onDeleteRoutine: (r: Routine) => Promise<void>;
  onLoadMemory: (id: string) => Promise<string>;
  onSaveMemory: (text: string) => Promise<void>;
};

export function AgentPane({
  open,
  tab,
  agent,
  onTab,
  onClose,
  onReset,
  onSetFace,
  onSave,
  onAddRoutine,
  onToggleRoutine,
  onDeleteRoutine,
  onLoadMemory,
  onSaveMemory,
}: Props) {
  return (
    <div
      className={"overlay" + (open ? " open" : "")}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="sheet agent-sheet">
        <div className="sheet-head">
          <h3>{agent?.name || agent?.id || "봇"}</h3>
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
        <div className="pane-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={tab === t.id ? "on" : ""}
              onClick={() => onTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="sheet-body">
          <div hidden={tab !== "info"}>
            <InfoPane
              open={open}
              agent={agent}
              onReset={onReset}
              onSetFace={onSetFace}
              onSave={onSave}
            />
          </div>
          <div hidden={tab !== "routines"}>
            <RoutinesModal
              open={open}
              agent={agent}
              onAdd={onAddRoutine}
              onToggle={onToggleRoutine}
              onDelete={onDeleteRoutine}
            />
          </div>
          <div hidden={tab !== "memory"}>
            <MemoryTab
              open={open}
              agent={agent}
              onLoad={onLoadMemory}
              onSave={onSaveMemory}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function MemoryTab({
  open,
  agent,
  onLoad,
  onSave,
}: {
  open: boolean;
  agent: AgentInfo | null;
  onLoad: (id: string) => Promise<string>;
  onSave: (text: string) => Promise<void>;
}) {
  const [memory, setMemory] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!open || !agent) return;
    setMemory("");
    setSaved(false);
    void onLoad(agent.id).then((text) => {
      setMemory(text);
      setSaved(false);
    });
  }, [open, agent?.id]);

  return (
    <div className="form-stack">
      <p className="apply-note">이 봇이 대화를 지워도 기억할 내용입니다.</p>
      <Field label="기억" htmlFor="pane-memory">
        <textarea
          id="pane-memory"
          className="textin memory"
          placeholder="이름, 취향, 자주 하는 일처럼 오래 남을 메모"
          value={memory}
          onChange={(e) => {
            setMemory(e.target.value);
            setSaved(false);
          }}
        />
      </Field>
      <div className="actions spread">
        <span className="apply-note">{saved ? "저장됨" : "저장해야 반영됩니다"}</span>
        <button
          type="button"
          className="primary"
          onClick={async () => {
            await onSave(memory);
            setSaved(true);
          }}
        >
          저장
        </button>
      </div>
    </div>
  );
}
