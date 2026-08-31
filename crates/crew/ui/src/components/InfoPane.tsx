import { useEffect, useRef, useState } from "react";
import { EFFORTS } from "../options";
import type { AgentInfo, Routine } from "../types";
import { Avatar } from "./Avatar";
import { Field } from "./Field";
import { Seg } from "./Seg";

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
  onLoadMemory: (id: string) => Promise<string>;
  onSaveMemory: (text: string) => Promise<void>;
};

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
  onLoadMemory,
  onSaveMemory,
}: Props) {
  const [title, setTitle] = useState("");
  const [role, setRole] = useState("");
  const [description, setDescription] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [routineName, setRoutineName] = useState("");
  const [routineCron, setRoutineCron] = useState("");
  const [routinePrompt, setRoutinePrompt] = useState("");
  const [memory, setMemory] = useState("");
  const [memorySaved, setMemorySaved] = useState(false);
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
    setMemory("");
    setMemorySaved(false);
    void onLoadMemory(agent.id).then((text) => {
      setMemory(text);
      setMemorySaved(false);
    });
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
          <div className="avatar-row">
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
            <div className="avatar-row-meta">
              <h3>{agent?.name || agent?.id || "에이전트"}</h3>
              {agent?.avatar ? (
                <button type="button" className="ghost" onClick={onClearAvatar}>
                  기본으로
                </button>
              ) : null}
            </div>
          </div>
        </div>
        <div className="form-stack">
          <Field label="직함" htmlFor="info-title">
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
          </Field>
          <Field label="역할" htmlFor="info-role">
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
          </Field>
          <Field label="설명" htmlFor="info-description">
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
          </Field>
          <Field label="모델" htmlFor="model">
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
          </Field>
          <Field label="노력">
            <Seg
              value={effort}
              options={EFFORTS}
              onChange={(next) => {
                setEffort(next);
                void flushSave({ effort: next });
              }}
            />
          </Field>
          <p className="apply-note">
            모델·노력·역할은 다음 세션부터 적용됩니다. 히스토리를 지우면 바로 새 설정으로
            시작됩니다.
          </p>
          <Field label="기억" htmlFor="info-memory">
            <textarea
              id="info-memory"
              className="textin memory"
              placeholder="이 봇이 세션을 넘어 기억할 내용"
              value={memory}
              onChange={(e) => {
                setMemory(e.target.value);
                setMemorySaved(false);
              }}
            />
            <div className="actions spread">
              <span className="apply-note">
                {memorySaved ? "저장됨" : "리셋 후에도 남습니다"}
              </span>
              <button
                type="button"
                className="primary"
                onClick={async () => {
                  await onSaveMemory(memory);
                  setMemorySaved(true);
                }}
              >
                저장
              </button>
            </div>
          </Field>
          <Field label="루틴">
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
          </Field>
          <div className="form-stack">
            <Field label="이름" htmlFor="routine-name">
              <input
                id="routine-name"
                className="textin"
                placeholder="아침 브리핑"
                value={routineName}
                onChange={(e) => setRoutineName(e.target.value)}
              />
            </Field>
            <Field label="cron" htmlFor="routine-cron">
              <input
                id="routine-cron"
                className="textin"
                placeholder="*/5 * * * *"
                value={routineCron}
                onChange={(e) => setRoutineCron(e.target.value)}
              />
            </Field>
            <Field label="프롬프트" htmlFor="routine-prompt">
              <textarea
                id="routine-prompt"
                className="textin"
                placeholder="에이전트에 넣을 내용"
                value={routinePrompt}
                onChange={(e) => setRoutinePrompt(e.target.value)}
              />
            </Field>
            <div className="actions">
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
        </div>
        <div className="actions spread">
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
