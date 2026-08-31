import { useEffect, useRef, useState } from "react";
import { hashedFace, type AvatarShape } from "../avatar";
import { CLIS, EFFORTS } from "../options";
import type { CliKind } from "../types";
import { Avatar } from "./Avatar";
import { FacePicker } from "./FacePicker";
import { Field } from "./Field";
import { Modal } from "./Modal";
import { Seg } from "./Seg";

type Props = {
  open: boolean;
  onClose: () => void;
  onCreate: (args: {
    name: string;
    persona: string;
    cli: CliKind;
    model: string;
    effort: string;
    shape: string | null;
    color: string | null;
  }) => Promise<void>;
};

export function NewBotModal({
  open,
  onClose,
  onCreate,
}: Props) {
  const [name, setName] = useState("");
  const [persona, setPersona] = useState("");
  const [model, setModel] = useState("");
  const [cli, setCli] = useState<CliKind>("grok");
  const [effort, setEffort] = useState("");
  const [shape, setShape] = useState<AvatarShape | "">("");
  const [color, setColor] = useState("");
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setPersona("");
    setModel("");
    setCli("grok");
    setEffort("");
    const face = hashedFace(crypto.randomUUID());
    setShape(face.shape);
    setColor(face.color);
    setBusy(false);
    const t = window.setTimeout(() => nameRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [open]);

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed) {
      nameRef.current?.focus();
      await onCreate({
        name: "",
        persona,
        cli,
        model,
        effort,
        shape: shape || null,
        color: color || null,
      });
      return;
    }
    setBusy(true);
    try {
      await onCreate({
        name: trimmed,
        persona,
        cli,
        model,
        effort,
        shape: shape || null,
        color: color || null,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} title="새 봇" onClose={onClose}>
      <div className="form-stack">
        <Field label="아바타">
          <div className="avatar-row">
            <Avatar
              className="new-avatar"
              id="new"
              name={name.trim() || "new"}
              shape={shape || null}
              color={color || null}
            />
          </div>
        </Field>
        <FacePicker
          id="new"
          shape={shape || null}
          color={color || null}
          onShape={setShape}
          onColor={setColor}
        />
        <Field label="이름" htmlFor="new-name">
          <input
            id="new-name"
            ref={nameRef}
            className="textin"
            placeholder="예: 기획 도우미"
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
        <Field label="역할 / 설명" htmlFor="new-persona">
          <textarea
            id="new-persona"
            className="textin"
            placeholder="선택 사항"
            value={persona}
            onChange={(e) => setPersona(e.target.value)}
          />
        </Field>
        <Field label="AI">
          <Seg value={cli} options={CLIS} onChange={setCli} />
        </Field>
        <Field label="모델" htmlFor="new-model">
          <input
            id="new-model"
            className="textin"
            placeholder="비워 두면 기본값"
            autoComplete="off"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        </Field>
        <Field label="생각">
          <Seg value={effort} options={EFFORTS} onChange={setEffort} />
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
