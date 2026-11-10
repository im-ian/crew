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
  busy = false,
  onPick,
}: {
  open: boolean;
  /** Sending anyway is under way. */
  busy?: boolean;
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
        // A button reached with Tab takes Enter as its own click.
        const onButton =
          !e.metaKey && !e.ctrlKey && e.target instanceof Element && !!e.target.closest(".ask-hold-actions button");
        if (onButton) return;
        e.preventDefault();
        e.stopPropagation();
        // The Enter that sent is still held: its repeats are not a pick.
        if (e.repeat) return;
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
        <button type="button" className="ghost" disabled={busy} onClick={() => onPick("send")}>
          {t("askHold.send")}
          <kbd>⌘↵</kbd>
        </button>
        <button type="button" className="primary" disabled={busy} onClick={() => onPick("go")}>
          {t("askHold.go")}
          <kbd>↵</kbd>
        </button>
      </div>
    </Modal>
  );
}
