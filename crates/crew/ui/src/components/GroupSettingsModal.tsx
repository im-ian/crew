import { useEffect, useRef, useState } from "react";
import { useT } from "../LocaleContext";
import type { Group } from "../types";
import { Field } from "./Field";
import { FolderPick } from "./FolderPick";
import { Modal } from "./Modal";

type Props = {
  open: boolean;
  group: Group | null;
  onClose: () => void;
  onPickFolder: () => Promise<string | null>;
  onLoad: (id: string) => Promise<string>;
  onSave: (
    id: string,
    fields: { path: string; memory: string; base: string },
  ) => Promise<boolean>;
};

export function GroupSettingsModal({
  open,
  group,
  onClose,
  onPickFolder,
  onLoad,
  onSave,
}: Props) {
  const t = useT();
  const [path, setPath] = useState("");
  const [memory, setMemory] = useState("");
  const [busy, setBusy] = useState(false);
  const edited = useRef(false);
  // The notes as loaded. A bot may add to them while the dialog is open.
  const base = useRef("");

  useEffect(() => {
    if (!open || !group) return;
    setPath(group.path ?? "");
    setMemory("");
    setBusy(false);
    edited.current = false;
    base.current = "";
    void onLoad(group.id).then((text) => {
      if (edited.current) return;
      base.current = text;
      setMemory(text);
    });
  }, [open, group?.id]);

  async function submit() {
    if (!group || busy) return;
    setBusy(true);
    try {
      if (await onSave(group.id, { path, memory, base: base.current })) onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} title={t("groupSettings.title")} onClose={onClose}>
      <div className="form-stack">
        <p className="apply-note">{group?.name}</p>
        <Field label={t("field.cwd")} htmlFor="group-path">
          <FolderPick id="group-path" path={path} onPick={onPickFolder} onChange={setPath} />
        </Field>
        <p className="apply-note">{t("group.folderHint")}</p>
        <Field label={t("groupSettings.memoryLabel")} htmlFor="group-memory">
          <textarea
            id="group-memory"
            className="textin memory"
            placeholder={t("groupSettings.memoryPh")}
            value={memory}
            onChange={(e) => {
              edited.current = true;
              setMemory(e.target.value);
            }}
          />
        </Field>
        <p className="apply-note">{t("groupSettings.memoryNote")}</p>
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
