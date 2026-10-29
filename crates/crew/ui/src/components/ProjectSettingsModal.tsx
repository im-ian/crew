import { useEffect, useRef, useState } from "react";
import { useT } from "../LocaleContext";
import type { Group } from "../types";
import { Field } from "./Field";
import { Modal } from "./Modal";

type Props = {
  open: boolean;
  group: Group | null;
  onClose: () => void;
  onLoad: (id: string) => Promise<string>;
  onSave: (id: string, text: string) => Promise<boolean>;
};

export function ProjectSettingsModal({ open, group, onClose, onLoad, onSave }: Props) {
  const t = useT();
  const [memory, setMemory] = useState("");
  const [busy, setBusy] = useState(false);
  const edited = useRef(false);
  const memoryRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open || !group) return;
    setMemory("");
    setBusy(false);
    edited.current = false;
    void onLoad(group.id).then((text) => {
      if (!edited.current) setMemory(text);
    });
    const timer = window.setTimeout(() => memoryRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open, group?.id]);

  async function submit() {
    if (!group || busy) return;
    setBusy(true);
    try {
      if (await onSave(group.id, memory)) onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} title={t("projectSettings.title")} onClose={onClose}>
      <div className="form-stack">
        <p className="apply-note">
          {group?.path
            ? t("projectSettings.of", { name: group.name, path: group.path })
            : group?.name}
        </p>
        <p className="apply-note">{t("projectSettings.memoryNote")}</p>
        <Field label={t("projectSettings.memoryLabel")} htmlFor="project-memory">
          <textarea
            id="project-memory"
            ref={memoryRef}
            className="textin memory"
            placeholder={t("projectSettings.memoryPh")}
            value={memory}
            onChange={(e) => {
              edited.current = true;
              setMemory(e.target.value);
            }}
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
          {t("common.save")}
        </button>
      </div>
    </Modal>
  );
}
