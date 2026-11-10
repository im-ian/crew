import { useEffect, useRef } from "react";
import { useT } from "../LocaleContext";
import { Modal } from "./Modal";

/** Go to the open question, send anyway over it, or back to the draft. */
export type AskPick = "go" | "send" | "cancel";

/**
 * Asked when a message is sent while the bot still waits on a question.
 * Enter goes to the question, ⌘Enter sends anyway, Escape goes back.
 */
export function AskHoldDialog({
  open,
  onPick,
}: {
  open: boolean;
  onPick: (pick: AskPick) => void;
}) {
  const t = useT();
  const pickRef = useRef(onPick);
  pickRef.current = onPick;

  // On the window, before the page: the composer still holds the focus and
  // would take this Enter as another send.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        pickRef.current(e.metaKey || e.ctrlKey ? "send" : "go");
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        pickRef.current("cancel");
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  return (
    <Modal open={open} title={t("askHold.title")} onClose={() => onPick("cancel")}>
      <p>{t("askHold.body")}</p>
      <div className="actions ask-hold-actions">
        <button type="button" className="ghost" onClick={() => onPick("send")}>
          {t("askHold.send")}
          <kbd>⌘↵</kbd>
        </button>
        <button type="button" className="primary" onClick={() => onPick("go")}>
          {t("askHold.go")}
          <kbd>↵</kbd>
        </button>
      </div>
    </Modal>
  );
}
