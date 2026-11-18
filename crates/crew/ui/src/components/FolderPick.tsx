import { useState } from "react";
import { useT } from "../LocaleContext";
import { isWeb } from "../web";

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

  // A phone cannot open the Mac's folder dialog, so the path is typed.
  const web = isWeb();
  return (
    <div className="path-pick">
      <input
        id={id}
        className="textin"
        readOnly={!web}
        placeholder={web ? t("group.folderPhWeb") : t("group.folderPh")}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        title={path || undefined}
        value={path}
        onChange={web ? (e) => onChange(e.target.value) : undefined}
      />
      {path ? (
        <button type="button" className="ghost" onClick={() => onChange("")}>
          {t("group.folderClear")}
        </button>
      ) : null}
      {web ? null : (
        <button
          type="button"
          className="ghost"
          disabled={picking}
          onClick={() => void choose()}
        >
          {t("group.folderChoose")}
        </button>
      )}
    </div>
  );
}
