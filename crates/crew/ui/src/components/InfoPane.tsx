import { useEffect, useRef, useState } from "react";
import type { AgentInfo, Routine } from "../types";
import { Avatar } from "./Avatar";

type Props = {
  open: boolean;
  agent: AgentInfo | null;
  onClose: () => void;
  onReset: () => void;
  onPickAvatar: () => void;
  onClearAvatar: () => void;
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
};

const EFFORTS: { value: string; label: string }[] = [
  { value: "", label: "기본" },
  { value: "low", label: "낮음" },
  { value: "medium", label: "보통" },
  { value: "high", label: "높음" },
];

export function InfoPane({
  open,
  agent,
  onClose,
  onReset,
  onPickAvatar,
  onClearAvatar,
  onSave,
  onAddRoutine,
  onToggleRoutine,
  onDeleteRoutine,
}: Props) {
  const [title, setTitle] = useState("");
  const [role, setRole] = useState("");
  const [description, setDescription] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [routineName, setRoutineName] = useState("");
  const [routineCron, setRoutineCron] = useState("");
  const [routinePrompt, setRoutinePrompt] = useState("");
  const saveTimer = useRef<number | null>(null);
  const fieldsRef = useRef({ title, role, description, model, effort });
  fieldsRef.current = { title, role, description, model, effort };

  useEffect(() => {
    if (!open || !agent) return;
    setTitle(agent.title || "");
    setRole(agent.role || "");
    setDescription(agent.description || "");
    setModel(agent.model || "");
    setEffort(agent.effort || "");
  }, [open, agent?.id]);

  function scheduleSave(next?: Partial<typeof fieldsRef.current>) {
    const merged = { ...fieldsRef.current, ...next };
    fieldsRef.current = merged;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void onSave(merged);
    }, 400);
  }

  async function flushSave(next?: Partial<typeof fieldsRef.current>) {
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const merged = { ...fieldsRef.current, ...next };
    fieldsRef.current = merged;
    await onSave(merged);
  }

  const routines = (agent && agent.routines) || [];

  return (
    <div
      className={"overlay" + (open ? " open" : "")}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="sheet">
        <div className="info-hero">
          <Avatar
            as="button"
            className="info-avatar"
            id={agent?.id}
            name={agent?.name || agent?.id}
            src={agent?.avatar}
            title="사진 변경"
            onClick={onPickAvatar}
            overlay={<span className="info-avatar-overlay">사진 변경</span>}
          />
          <h3>{agent?.name || agent?.id || "에이전트"}</h3>
          <button
            type="button"
            className="ghost"
            hidden={!agent?.avatar}
            onClick={onClearAvatar}
          >
            기본으로
          </button>
        </div>
        <label className="field" htmlFor="info-title">
          직함
        </label>
        <input
          id="info-title"
          className="textin"
          placeholder="예: 프로덕트 매니저"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            scheduleSave({ title: e.target.value });
          }}
          onBlur={() => void flushSave()}
        />
        <label className="field" htmlFor="info-role">
          역할
        </label>
        <input
          id="info-role"
          className="textin"
          placeholder="예: 계획을 잡고 일을 나눈다"
          value={role}
          onChange={(e) => {
            setRole(e.target.value);
            scheduleSave({ role: e.target.value });
          }}
          onBlur={() => void flushSave()}
        />
        <label className="field" htmlFor="info-description">
          설명
        </label>
        <textarea
          id="info-description"
          className="textin"
          placeholder="페르소나 / 설명"
          value={description}
          onChange={(e) => {
            setDescription(e.target.value);
            scheduleSave({ description: e.target.value });
          }}
          onBlur={() => void flushSave()}
        />
        <label className="field" htmlFor="model">
          모델
        </label>
        <input
          id="model"
          className="textin"
          placeholder="CLI 기본값"
          value={model}
          onChange={(e) => {
            setModel(e.target.value);
            scheduleSave({ model: e.target.value });
          }}
          onBlur={() => void flushSave()}
        />
        <label className="field">노력</label>
        <div className="seg">
          {EFFORTS.map((opt) => (
            <button
              key={opt.value || "default"}
              type="button"
              className={effort === opt.value ? "on" : ""}
              onClick={() => {
                setEffort(opt.value);
                void flushSave({ effort: opt.value });
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <p className="apply-note">
          모델·노력·역할은 다음 세션부터 적용됩니다. 히스토리를 지우면 바로 새 설정으로 시작됩니다.
        </p>
        <label className="field">루틴</label>
        <div className="routine-list">
          {!routines.length ? (
            <div className="empty-routines">등록된 루틴이 없습니다</div>
          ) : (
            routines.map((r) => (
              <div className="routine" key={r.id || r.name}>
                <div>
                  <div className="routine-name">{r.name || r.id}</div>
                  <div className="routine-meta">
                    {r.schedule || ""} · {r.enabled === false ? "꺼짐" : "켜짐"}
                  </div>
                </div>
                <div className="routine-actions">
                  <button type="button" onClick={() => void onToggleRoutine(r)}>
                    {r.enabled === false ? "재개" : "일시정지"}
                  </button>
                  <button type="button" onClick={() => void onDeleteRoutine(r)}>
                    삭제
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
        <div className="routine-add">
          <label className="field" htmlFor="routine-name">
            이름
          </label>
          <input
            id="routine-name"
            className="textin"
            placeholder="아침 브리핑"
            value={routineName}
            onChange={(e) => setRoutineName(e.target.value)}
          />
          <label className="field" htmlFor="routine-cron">
            cron
          </label>
          <input
            id="routine-cron"
            className="textin"
            placeholder="*/5 * * * *"
            value={routineCron}
            onChange={(e) => setRoutineCron(e.target.value)}
          />
          <label className="field" htmlFor="routine-prompt">
            프롬프트
          </label>
          <textarea
            id="routine-prompt"
            className="textin"
            placeholder="에이전트에 넣을 내용"
            value={routinePrompt}
            onChange={(e) => setRoutinePrompt(e.target.value)}
          />
          <div className="sheet-actions">
            <span />
            <button
              type="button"
              className="primary"
              onClick={async () => {
                await onAddRoutine(routineName, routineCron, routinePrompt);
                setRoutineName("");
                setRoutineCron("");
                setRoutinePrompt("");
              }}
            >
              추가
            </button>
          </div>
        </div>
        <div className="sheet-actions">
          <button type="button" className="danger" onClick={onReset}>
            히스토리 지우기
          </button>
          <button type="button" className="ghost" onClick={onClose}>
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}
