import { useEffect, useRef, useState } from "react";
import { folderName } from "../groups";
import { useT } from "../LocaleContext";
import { Folder } from "../icons";
import { Field } from "./Field";
import { Modal } from "./Modal";

type Props = {
  open: boolean;
  onClose: () => void;
  onPickFolder: () => Promise<string | null>;
  onCreate: (name: string, path: string) => void;
};

export function NewProjectModal({ open, onClose, onPickFolder, onCreate }: Props) {
  const t = useT();
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [picking, setPicking] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const nameEdited = useRef(false);

  useEffect(() => {
    if (!open) return;
    setName("");
    setPath("");
    setPicking(false);
    nameEdited.current = false;
    const timer = window.setTimeout(() => nameRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  async function choose() {
    if (picking) return;
    setPicking(true);
    try {
      const picked = await onPickFolder();
      if (!picked) return;
      setPath(picked);
      if (!nameEdited.current) setName(folderName(picked));
    } finally {
      setPicking(false);
    }
  }

  function submit() {
    const trimmed = name.trim();
    const folder = path.trim();
    if (!trimmed) {
      nameRef.current?.focus();
      return;
    }
    if (!folder) return;
    onCreate(trimmed, folder);
  }

  const ready = name.trim().length > 0 && path.trim().length > 0;

  return (
    <Modal open={open} title={t("newProject.title")} onClose={onClose}>
      <div className="form-stack">
        <Field label={t("field.name")} htmlFor="new-project-name">
          <input
            id="new-project-name"
            ref={nameRef}
            className="textin"
            placeholder={t("info.namePh")}
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
        <Field label={t("field.cwd")} htmlFor="new-project-path">
          <div className="path-pick">
            <input
              id="new-project-path"
              className="textin"
              readOnly
              placeholder={t("newProject.pathPh")}
              title={path || undefined}
              value={path}
            />
            <button
              type="button"
              className="ghost"
              disabled={picking}
              onClick={() => void choose()}
            >
              <Folder size={14} />
              {t("newProject.choose")}
            </button>
          </div>
        </Field>
        <p className="apply-note">{t("newProject.hint")}</p>
      </div>
      <div className="actions spread">
        <button type="button" className="ghost" onClick={onClose}>
          {t("common.cancel")}
        </button>
        <button type="button" className="primary" disabled={!ready} onClick={submit}>
          {t("common.create")}
        </button>
      </div>
    </Modal>
  );
}
