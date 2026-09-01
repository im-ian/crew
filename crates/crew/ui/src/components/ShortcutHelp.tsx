import { useT } from "../LocaleContext";
import type { MessageKey } from "../locales";
import { formatCombo, groupedShortcuts } from "../shortcuts";
import { Modal } from "./Modal";

type Props = {
  open: boolean;
  onClose: () => void;
};

export function ShortcutHelp({ open, onClose }: Props) {
  const t = useT();
  return (
    <Modal open={open} title={t("shortcut.title")} onClose={onClose} wide>
      <div className="shortcut-list">
        {groupedShortcuts().map((g) => (
          <section key={g.group}>
            <h4>{t(`shortcut.group.${g.group}` as MessageKey)}</h4>
            <ul>
              {g.items.map((s) => (
                <li key={s.id}>
                  <span className="shortcut-label">
                    {t(`shortcut.${s.id}` as MessageKey)}
                  </span>
                  <span className="shortcut-keys">
                    {formatCombo(s.combo, t("key.space")).map((part, i) => (
                      <kbd key={s.id + i}>{part}</kbd>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <p className="apply-note">{t("shortcut.note")}</p>
    </Modal>
  );
}
