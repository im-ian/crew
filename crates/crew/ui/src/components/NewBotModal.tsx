import { useEffect, useRef, useState } from "react";
import { randomFace, type AvatarShape } from "../avatar";
import { useT } from "../LocaleContext";
import type { CliKind, Group } from "../types";
import { Avatar } from "./Avatar";
import { FacePop } from "./FacePicker";
import { Field } from "./Field";
import { Modal } from "./Modal";
import { ModelPicker } from "./ModelPicker";

type Props = {
  open: boolean;
  groups: Group[];
  /** Sidebar place that opened this dialog, when it was opened from one. */
  placeId?: string | null;
  onClose: () => void;
  onCreate: (args: {
    name: string;
    cli: CliKind;
    model: string;
    effort: string;
    cmd: string;
    shape: string | null;
    color: string | null;
    groupId: string | null;
  }) => Promise<void>;
};

export function NewBotModal({
  open,
  groups,
  placeId,
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
  const [groupId, setGroupId] = useState("");
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const groupsRef = useRef(groups);
  groupsRef.current = groups;

  useEffect(() => {
    if (!open) return;
    setName("");
    setModel("");
    setCli("grok");
    setCommand("");
    setEffort("");
    setGroupId(
      placeId && groupsRef.current.some((g) => g.id === placeId) ? placeId : "",
    );
    // #3a3a3c is a swatch to pick, not a face to start from: on the dark
    // dialog it reads as an empty slot.
    const face = randomFace({ color: "#3a3a3c" });
    setShape(face.shape);
    setColor(face.color);
    setBusy(false);
    const t = window.setTimeout(() => nameRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [open, placeId]);

  function payload(botName: string) {
    return {
      name: botName,
      cli,
      model,
      effort,
      cmd: command,
      shape: shape || null,
      color: color || null,
      groupId: groupId || null,
    };
  }

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed) {
      nameRef.current?.focus();
      await onCreate(payload(""));
      return;
    }
    setBusy(true);
    try {
      await onCreate(payload(trimmed));
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
        <Field label={t("field.group")} htmlFor="new-group">
          <select
            id="new-group"
            className="textin"
            value={groupId}
            onChange={(e) => setGroupId(e.target.value)}
          >
            <option value="">{t("newBot.none")}</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </Field>
        <p className="apply-note">{t("newBot.placeHint")}</p>
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
