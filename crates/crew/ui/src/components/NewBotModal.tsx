import { useEffect, useRef, useState } from "react";
import type { CliKind, PendingAvatar } from "../types";
import { Avatar } from "./Avatar";

type Props = {
  open: boolean;
  pendingAvatar: PendingAvatar | null;
  onClose: () => void;
  onPickAvatar: () => void;
  onClearAvatar: () => void;
  onCreate: (args: {
    name: string;
    persona: string;
    cli: CliKind;
    model: string;
    effort: string;
  }) => Promise<void>;
};

const CLIS: CliKind[] = ["grok", "claude", "codex"];
const EFFORTS: { value: string; label: string }[] = [
  { value: "", label: "기본" },
  { value: "low", label: "낮음" },
  { value: "medium", label: "보통" },
  { value: "high", label: "높음" },
];

export function NewBotModal({
  open,
  pendingAvatar,
  onClose,
  onPickAvatar,
  onClearAvatar,
  onCreate,
}: Props) {
  const [name, setName] = useState("");
  const [persona, setPersona] = useState("");
  const [model, setModel] = useState("");
  const [cli, setCli] = useState<CliKind>("grok");
  const [effort, setEffort] = useState("");
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setPersona("");
    setModel("");
    setCli("grok");
    setEffort("");
    setBusy(false);
    const t = window.setTimeout(() => nameRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [open]);

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed) {
      nameRef.current?.focus();
      await onCreate({ name: "", persona, cli, model, effort });
      return;
    }
    setBusy(true);
    try {
      await onCreate({ name: trimmed, persona, cli, model, effort });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={"modal" + (open ? " open" : "")}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog">
        <h3>새 봇</h3>
        <label className="field">아바타</label>
        <div className="new-avatar-row">
          <Avatar
            as="button"
            className="new-avatar"
            id="new"
            name="+"
            letter="+"
            src={pendingAvatar?.data}
            title="사진 선택"
            onClick={onPickAvatar}
          />
          <button
            type="button"
            className="ghost"
            hidden={!pendingAvatar}
            onClick={onClearAvatar}
          >
            기본으로
          </button>
        </div>
        <label className="field" htmlFor="new-name">
          이름
        </label>
        <input
          id="new-name"
          ref={nameRef}
          className="textin"
          placeholder="예: Frontend"
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
        <label className="field" htmlFor="new-persona">
          역할 / 설명
        </label>
        <textarea
          id="new-persona"
          className="textin"
          placeholder="선택 사항"
          value={persona}
          onChange={(e) => setPersona(e.target.value)}
        />
        <label className="field">CLI</label>
        <div className="seg three">
          {CLIS.map((c) => (
            <button
              key={c}
              type="button"
              className={cli === c ? "on" : ""}
              onClick={() => setCli(c)}
            >
              {c}
            </button>
          ))}
        </div>
        <label className="field" htmlFor="new-model">
          모델
        </label>
        <input
          id="new-model"
          className="textin"
          placeholder="CLI 기본값"
          autoComplete="off"
          value={model}
          onChange={(e) => setModel(e.target.value)}
        />
        <label className="field">노력</label>
        <div className="seg">
          {EFFORTS.map((opt) => (
            <button
              key={opt.value || "default"}
              type="button"
              className={effort === opt.value ? "on" : ""}
              onClick={() => setEffort(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <div className="dialog-actions">
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
      </div>
    </div>
  );
}
