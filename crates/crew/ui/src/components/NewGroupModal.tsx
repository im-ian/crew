import { useEffect, useRef, useState } from "react";
import { folderName } from "../groups";
import { useT } from "../LocaleContext";
import { Field } from "./Field";
import { FolderPick } from "./FolderPick";
import { Modal } from "./Modal";

type Props = {
  open: boolean;
  onClose: () => void;
  onPickFolder: () => Promise<string | null>;
  onCreate: (name: string, path: string, memory: string) => void;
};

export function NewGroupModal({ open, onClose, onPickFolder, onCreate }: Props) {
  const t = useT();
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [memory, setMemory] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  const nameEdited = useRef(false);

  useEffect(() => {
    if (!open) return;
    setName("");
    setPath("");
    setMemory("");
    nameEdited.current = false;
    const timer = window.setTimeout(() => nameRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  function submit() {
    const trimmed = name.trim();
    if (!trimmed) {
      nameRef.current?.focus();
      return;
    }
    onCreate(trimmed, path.trim(), memory);
  }

  return (
    <Modal open={open} title={t("newGroup.title")} onClose={onClose}>
      <div className="form-stack">
        <Field label={t("field.name")} htmlFor="new-group-name">
          <input
            id="new-group-name"
            ref={nameRef}
            className="textin"
            placeholder={t("newGroup.namePh")}
            autoComplete="off"
            value={name}
            onChange={(e) => {
              nameEdited.current = true;
              setName(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
          />
        </Field>
        <Field label={t("group.folderLabel")} htmlFor="new-group-path" hint={t("group.folderHint")}>
          <FolderPick
            id="new-group-path"
            path={path}
            onPick={onPickFolder}
            onChange={(picked) => {
              setPath(picked);
              if (picked && !nameEdited.current) setName(folderName(picked));
            }}
          />
        </Field>
        <Field
          label={t("groupSettings.memoryLabel")}
          htmlFor="new-group-memory"
          hint={t("groupSettings.memoryNote")}
        >
          <textarea
            id="new-group-memory"
            className="textin memory"
            placeholder={t("groupSettings.memoryPh")}
            value={memory}
            onChange={(e) => setMemory(e.target.value)}
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
          disabled={!name.trim()}
          onClick={submit}
        >
          {t("common.create")}
        </button>
      </div>
    </Modal>
  );
}
