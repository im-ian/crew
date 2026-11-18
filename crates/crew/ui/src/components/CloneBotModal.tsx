import { useEffect, useRef, useState } from "react";
import { cloneDefaults, type ClonePick } from "../cloneParts";
import { useT } from "../LocaleContext";
import { Field } from "./Field";
import { Modal } from "./Modal";

type Props = {
  open: boolean;
  /** The original's name, for the copy's default name. */
  sourceName: string;
  /** It sits in a group, so the copy can go right below it there. */
  inGroup: boolean;
  /** A terminal cannot bring its chat along. */
  carriesChat: boolean;
  onClose: () => void;
  onClone: (name: string, pick: ClonePick) => void;
};

type Part = keyof ClonePick;

export function CloneBotModal({ open, sourceName, inGroup, carriesChat, onClose, onClone }: Props) {
  const t = useT();
  const [name, setName] = useState("");
  const [pick, setPick] = useState<ClonePick>(cloneDefaults);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setName(t("cloneBot.defaultName", { name: sourceName }).trim());
    setPick(cloneDefaults());
    const timer = window.setTimeout(() => nameRef.current?.select(), 0);
    return () => window.clearTimeout(timer);
  }, [open, sourceName, t]);

  function submit() {
    const trimmed = name.trim();
    if (!trimmed) {
      nameRef.current?.focus();
      return;
    }
    onClone(trimmed, pick);
  }

  const parts: { key: Part; label: string; hidden?: boolean; disabled?: boolean; hint?: string }[] = [
    { key: "avatar", label: t("cloneBot.avatar") },
    { key: "routines", label: t("cloneBot.routines") },
    { key: "memory", label: t("cloneBot.memory") },
    { key: "group", label: t("cloneBot.group"), hidden: !inGroup },
    {
      key: "chat",
      label: t("cloneBot.chat"),
      disabled: !carriesChat,
      hint: carriesChat ? t("cloneBot.chatHint") : t("cloneBot.chatTerminal"),
    },
  ];

  return (
    <Modal open={open} title={t("cloneBot.title")} onClose={onClose}>
      <div className="form-stack">
        <Field label={t("field.name")} htmlFor="clone-bot-name">
          <input
            id="clone-bot-name"
            ref={nameRef}
            className="textin"
            autoComplete="off"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
          />
        </Field>
      </div>
      <p className="field-hint clone-settings">{t("cloneBot.settings")}</p>
      <div className="clone-parts">
        {parts.map((part) =>
          part.hidden ? null : (
            <div key={part.key}>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={pick[part.key] && !part.disabled}
                  disabled={part.disabled}
                  onChange={(e) => setPick({ ...pick, [part.key]: e.target.checked })}
                />
                {part.label}
              </label>
              {part.hint ? <p className="field-hint clone-part-hint">{part.hint}</p> : null}
            </div>
          ),
        )}
      </div>
      <div className="actions spread">
        <button type="button" className="ghost" onClick={onClose}>
          {t("common.cancel")}
        </button>
        <button type="button" className="primary" disabled={!name.trim()} onClick={submit}>
          {t("cloneBot.ok")}
        </button>
      </div>
    </Modal>
  );
}
