import { useEffect, useRef, useState } from "react";
import type { AvatarShape } from "../avatar";
import { EFFORTS } from "../options";
import type { AgentInfo } from "../types";
import { Avatar } from "./Avatar";
import { FacePicker } from "./FacePicker";
import { Field } from "./Field";
import { Modal } from "./Modal";
import { Seg } from "./Seg";

type Props = {
  open: boolean;
  agent: AgentInfo | null;
  onClose: () => void;
  onReset: () => void;
  onPickAvatar: () => void;
  onClearAvatar: () => void;
  onSetFace: (shape?: string | null, color?: string | null) => Promise<void>;
  onSave: (fields: {
    title: string;
    role: string;
    description: string;
    model: string;
    effort: string;
  }) => Promise<void>;
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
  onSetFace,
  onSave,
  onLoadMemory,
  onSaveMemory,
}: Props) {
  const [title, setTitle] = useState("");
  const [role, setRole] = useState("");
  const [description, setDescription] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
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

  return (
    <Modal open={open} title="봇 정보" onClose={onClose} wide>
      <div className="info-hero">
        <div className="avatar-row">
          <Avatar
            as="button"
            className="info-avatar"
            id={agent?.id}
            name={agent?.name || agent?.id}
            src={agent?.avatar}
            shape={agent?.avatar_shape}
            color={agent?.avatar_color}
            status={agent?.status}
            title="사진 변경"
            onClick={onPickAvatar}
            overlay={<span className="info-avatar-overlay">사진 변경</span>}
          />
          <div className="avatar-row-meta">
            <strong className="info-name">
              {agent?.name || agent?.id || "봇"}
            </strong>
            {agent?.avatar ? (
              <button type="button" className="ghost" onClick={onClearAvatar}>
                기본으로
              </button>
            ) : null}
          </div>
        </div>
      </div>
      <div className="form-stack">
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
            <input
              id="model"
              className="textin"
              placeholder="비워 두면 기본값"
              value={model}
              onChange={(e) => {
                setModel(e.target.value);
                scheduleSave({ model: e.target.value });
              }}
              onBlur={() => void flushSave()}
            />
          </Field>
          <Field label="꼼꼼함">
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
            모델·꼼꼼함·역할은 다음 대화부터 적용됩니다. 대화를 지우면 바로 새 설정으로
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
                {memorySaved ? "저장됨" : "대화를 지워도 남습니다"}
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
        </div>
      <div className="actions spread">
        <button type="button" className="danger" onClick={onReset}>
          대화 지우기
        </button>
        <button type="button" className="ghost" onClick={onClose}>
          닫기
        </button>
      </div>
    </Modal>
  );
}
