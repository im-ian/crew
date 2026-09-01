import { useEffect, useState } from "react";
import { useT } from "../LocaleContext";
import type { ConfirmKind } from "../types";
import { Modal } from "./Modal";

type Props = {
  open: boolean;
  kind: ConfirmKind;
  onCancel: () => void;
  onConfirm: (dropRoutines: boolean) => void;
};

export function ConfirmDialog({ open, kind, onCancel, onConfirm }: Props) {
  const t = useT();
  const [drop, setDrop] = useState(false);

  useEffect(() => {
    if (open) setDrop(false);
  }, [open]);

  let title = t("confirm.reset.title");
  let body = t("confirm.reset.body");
  let ok = t("confirm.reset.ok");
  let okClass = "primary";
  let showToggle = true;

  if (kind === "remove") {
    title = t("confirm.remove.title");
    body = t("confirm.remove.body");
    ok = t("common.delete");
    okClass = "danger";
    showToggle = false;
  } else if (kind === "leave-channel") {
    title = t("confirm.leaveChannel.title");
    body = t("confirm.leaveChannel.body");
    ok = t("confirm.leaveChannel.ok");
    okClass = "danger";
    showToggle = false;
  } else if (kind === "remove-channel") {
    title = t("confirm.removeChannel.title");
    body = t("confirm.removeChannel.body");
    ok = t("common.delete");
    okClass = "danger";
    showToggle = false;
  } else if (kind === "remove-group") {
    title = t("confirm.removeGroup.title");
    body = t("confirm.removeGroup.body");
    ok = t("common.delete");
    okClass = "danger";
    showToggle = false;
  }

  return (
    <Modal open={open} title={title} onClose={onCancel}>
      <p>{body}</p>
      {showToggle ? (
        <label className="toggle">
          <input
            type="checkbox"
            checked={drop}
            onChange={(e) => setDrop(e.target.checked)}
          />
          {t("confirm.reset.dropRoutines")}
        </label>
      ) : null}
      <div className="actions spread">
        <button type="button" className="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </button>
        <button type="button" className={okClass} onClick={() => onConfirm(drop)}>
          {ok}
        </button>
      </div>
    </Modal>
  );
}
