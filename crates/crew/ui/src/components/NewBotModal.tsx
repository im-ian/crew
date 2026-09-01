import { useEffect, useRef, useState } from "react";
import { hashedFace, type AvatarShape } from "../avatar";
import { useT } from "../LocaleContext";
import { CLIS, effortOptions } from "../options";
import type { CliKind } from "../types";
import { Avatar } from "./Avatar";
import { FacePop } from "./FacePicker";
import { Field } from "./Field";
import { Modal } from "./Modal";
import { ModelSelect } from "./ModelSelect";
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
  const t = useT();
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
    <Modal open={open} title={t("newBot.title")} onClose={onClose}>
      <div className="form-stack">
        <div className="info-hero">
          <FacePop
            active={open}
            id="new"
            shape={shape || null}
            color={color || null}
            onShape={setShape}
            onColor={setColor}
            onFace={(nextShape, nextColor) => {
              setShape(nextShape);
              setColor(nextColor);
            }}
          >
            <Avatar
              className="new-avatar"
              id="new"
              name={name.trim() || "new"}
              shape={shape || null}
              color={color || null}
            />
          </FacePop>
        </div>
        <Field label={t("field.name")} htmlFor="new-name">
          <input
            id="new-name"
            ref={nameRef}
            className="textin"
            placeholder={t("info.namePh")}
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
        <Field label={t("field.persona")} htmlFor="new-persona">
          <textarea
            id="new-persona"
            className="textin"
            placeholder={t("newBot.personaPh")}
            value={persona}
            onChange={(e) => setPersona(e.target.value)}
          />
        </Field>
        <Field label={t("field.ai")}>
          <Seg
            value={cli}
            options={CLIS}
            onChange={(next) => {
              setCli(next);
              setModel("");
            }}
          />
        </Field>
        <Field label={t("field.model")} htmlFor="new-model">
          <ModelSelect
            id="new-model"
            cli={cli}
            value={model}
            onChange={setModel}
            active={open}
          />
        </Field>
        <Field label={t("field.effort")}>
          <Seg value={effort} options={effortOptions(t)} onChange={setEffort} />
        </Field>
      </div>
      <div className="actions spread">
        <button type="button" className="ghost" onClick={onClose}>
          {t("common.cancel")}
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => void submit()}
        >
          {t("common.create")}
        </button>
      </div>
    </Modal>
  );
}
