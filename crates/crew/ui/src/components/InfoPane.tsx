import { useEffect, useRef, useState } from "react";
import type { AvatarShape } from "../avatar";
import { cliFromCmd, EFFORTS } from "../options";
import type { AgentInfo } from "../types";
import { Avatar } from "./Avatar";
import { FacePicker } from "./FacePicker";
import { Field } from "./Field";
import { ModelSelect } from "./ModelSelect";
import { Seg } from "./Seg";

type Props = {
  open: boolean;
  agent: AgentInfo | null;
  onReset: () => void;
  onSetFace: (shape?: string | null, color?: string | null) => Promise<void>;
  onSave: (fields: {
    title: string;
    role: string;
    description: string;
    model: string;
    effort: string;
  }) => Promise<void>;
};

export function InfoPane({
  open,
  agent,
  onReset,
  onSetFace,
  onSave,
}: Props) {
  const [title, setTitle] = useState("");
  const [role, setRole] = useState("");
  const [description, setDescription] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
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

  return (
    <div className="form-stack">
      <div className="info-hero">
        <div className="avatar-row">
          <Avatar
            className="info-avatar"
            id={agent?.id}
            name={agent?.name || agent?.id}
            src={agent?.avatar}
            shape={agent?.avatar_shape}
            color={agent?.avatar_color}
            status={agent?.status}
          />
          <div className="avatar-row-meta">
            <strong className="info-name">
              {agent?.name || agent?.id || "봇"}
            </strong>
          </div>
        </div>
      </div>
      <FacePicker
        id={agent?.id}
        shape={agent?.avatar_shape}
        color={agent?.avatar_color}
        onShape={(next: AvatarShape) => {
          void onSetFace(next, undefined);
        }}
        onColor={(next) => {
          void onSetFace(undefined, next);
        }}
        onFace={(nextShape, nextColor) => {
          void onSetFace(nextShape, nextColor);
        }}
      />
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
          placeholder="이 봇을 어떻게 쓸지"
          value={description}
          onChange={(e) => {
            setDescription(e.target.value);
            scheduleSave({ description: e.target.value });
          }}
          onBlur={() => void flushSave()}
        />
      </Field>
      <Field label="모델" htmlFor="model">
        <ModelSelect
          id="model"
          cli={cliFromCmd(agent?.cmd)}
          value={model}
          onChange={(next) => {
            setModel(next);
            void flushSave({ model: next });
          }}
          active={open}
        />
      </Field>
      <Field label="생각">
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
        모델·생각·역할은 다음 대화부터 적용됩니다. 대화를 지우면 바로 새 설정으로
        시작됩니다.
      </p>
      <div className="actions">
        <button type="button" className="danger" onClick={onReset}>
          대화 지우기
        </button>
      </div>
    </div>
  );
}
