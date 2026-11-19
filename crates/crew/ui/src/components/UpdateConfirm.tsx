import type { TFn } from "../i18n";
import { useT } from "../LocaleContext";
import { Modal } from "./Modal";

/** What the update would interrupt, and what happens to it. */
export function updateWarning(t: TFn, bots: number): string {
  return t("update.busyBody", { n: String(bots) });
}

/**
 * Asked once before an update restarts Crew while bots are at work. Their
 * turns pick up again after the restart; background work they left running
 * has to start over.
 */
export function UpdateConfirm({
  bots,
  onCancel,
  onInstall,
}: {
  /** Bots at work. 0 keeps it closed. */
  bots: number;
  onCancel: () => void;
  onInstall: () => void;
}) {
  const t = useT();
  return (
    <Modal open={bots > 0} title={t("update.busyTitle")} onClose={onCancel}>
      <p>{bots > 0 ? updateWarning(t, bots) : null}</p>
      <div className="actions spread">
        <button type="button" className="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </button>
        <button type="button" className="primary" onClick={onInstall}>
          {t("update.busyInstall")}
        </button>
      </div>
    </Modal>
  );
}
