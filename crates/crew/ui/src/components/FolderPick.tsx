import { useState } from "react";
import { useT } from "../LocaleContext";

type Props = {
  id: string;
  path: string;
  onPick: () => Promise<string | null>;
  onChange: (path: string) => void;
};

/** A group's working folder. Optional, so a set one can be cleared. */
export function FolderPick({ id, path, onPick, onChange }: Props) {
  const t = useT();
  const [picking, setPicking] = useState(false);

  async function choose() {
    if (picking) return;
    setPicking(true);
    try {
      const picked = await onPick();
      if (picked) onChange(picked);
    } finally {
      setPicking(false);
    }
  }

  return (
    <div className="path-pick">
      <input
        id={id}
        className="textin"
        readOnly
        placeholder={t("group.folderPh")}
        title={path || undefined}
        value={path}
      />
      {path ? (
        <button type="button" className="ghost" onClick={() => onChange("")}>
          {t("group.folderClear")}
        </button>
      ) : null}
      <button
        type="button"
        className="ghost"
        disabled={picking}
        onClick={() => void choose()}
      >
        {t("group.folderChoose")}
      </button>
    </div>
  );
}
