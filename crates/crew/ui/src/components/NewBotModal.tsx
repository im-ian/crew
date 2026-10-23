import { useEffect, useRef, useState } from "react";
import { randomFace, type AvatarShape } from "../avatar";
import { useT } from "../LocaleContext";
import type { CliKind } from "../types";
import { Avatar } from "./Avatar";
import { FacePop } from "./FacePicker";
import { Field } from "./Field";
import { Modal } from "./Modal";
import { ModelPicker } from "./ModelPicker";

type Props = {
  open: boolean;
  onClose: () => void;
  onCreate: (args: {
    name: string;
    cli: CliKind;
    model: string;
    effort: string;
    cmd: string;
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
  const [model, setModel] = useState("");
  const [cli, setCli] = useState<CliKind>("grok");
  const [command, setCommand] = useState("");
  const [effort, setEffort] = useState("");
  const [shape, setShape] = useState<AvatarShape | "">("");
  const [color, setColor] = useState("");
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setModel("");
    setCli("grok");
    setCommand("");
    setEffort("");
    // #3a3a3c is a swatch to pick, not a face to start from: on the dark
    // dialog it reads as an empty slot.
    const face = randomFace({ color: "#3a3a3c" });
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
        cli,
        model,
        effort,
        cmd: command,
        shape: shape || null,
        color: color || null,
      });
      return;
    }
    setBusy(true);
    try {
      await onCreate({
        name: trimmed,
        cli,
        model,
        effort,
        cmd: command,
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
        <Field label={t("field.ai")}>
          <ModelPicker
            cli={cli}
            model={model}
            effort={effort}
            active={open}
            pickInstalled
            command={command}
            onCli={(next) => {
              setCli(next);
              setModel("");
              if (next === "custom") setCommand("");
            }}
            onModel={setModel}
            onEffort={setEffort}
            onCommand={setCommand}
          />
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
