import { useEffect, useState } from "react";
import { useT } from "../LocaleContext";
import type { ConfirmKind } from "../types";
import { Modal } from "./Modal";

type Props = {
  open: boolean;
  kind: ConfirmKind;
  onCancel: () => void;
  onConfirm: (dropRoutines: boolean) => void;
  /** Routers the bot being removed stands in for. */
  represents?: string[];
  /** The router being left, and my name on it. */
  leaving?: { alias: string; name: string } | null;
  /** The group being put away, and what goes with it. */
  archiving?: { name: string; bots: number; routines: number; working: number } | null;
  /** The archived group being deleted for good. */
  deleting?: { name: string; bots: number } | null;
};

export function ConfirmDialog({
  open,
  kind,
  onCancel,
  onConfirm,
  represents = [],
  leaving = null,
  archiving = null,
  deleting = null,
}: Props) {
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
    body = represents.length
      ? t("confirm.remove.bodyRep", { alias: represents.join(", ") })
      : t("confirm.remove.body");
    ok = t("common.delete");
    okClass = "danger";
    showToggle = false;
  } else if (kind === "leave-remote") {
    title = t("confirm.leaveRemote.title", { alias: leaving?.alias ?? "" });
    body = t("confirm.leaveRemote.body", { name: leaving?.name ?? "" });
    ok = t("confirm.leaveRemote.ok");
    okClass = "danger";
    showToggle = false;
  } else if (kind === "archive-group") {
    title = t("confirm.archiveGroup.title");
    body = t("confirm.archiveGroup.body", {
      name: archiving?.name ?? "",
      bots: String(archiving?.bots ?? 0),
      routines: String(archiving?.routines ?? 0),
    });
    ok = t("confirm.archiveGroup.ok");
    showToggle = false;
  } else if (kind === "delete-archived") {
    title = t("confirm.deleteArchived.title");
    body = t("confirm.deleteArchived.body", {
      name: deleting?.name ?? "",
      bots: String(deleting?.bots ?? 0),
    });
    ok = t("confirm.deleteArchived.ok");
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
    <Modal open={open} title={title} onClose={onCancel} closeButton={false}>
      <p>{body}</p>
      {kind === "archive-group" && archiving && archiving.working > 0 ? (
        <p role="alert" className="confirm-working">
          {t("confirm.archiveGroup.working", { n: String(archiving.working) })}
        </p>
      ) : null}
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
