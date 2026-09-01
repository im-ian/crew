import { formatCombo, groupedShortcuts } from "../shortcuts";
import { Modal } from "./Modal";

type Props = {
  open: boolean;
  onClose: () => void;
};

export function ShortcutHelp({ open, onClose }: Props) {
  return (
    <Modal open={open} title="단축키" onClose={onClose} wide>
      <div className="shortcut-list">
        {groupedShortcuts().map((g) => (
          <section key={g.group}>
            <h4>{g.group}</h4>
            <ul>
              {g.items.map((s) => (
                <li key={s.id}>
                  <span className="shortcut-label">{s.label}</span>
                  <span className="shortcut-keys">
                    {formatCombo(s.combo).map((part, i) => (
                      <kbd key={s.id + i}>{part}</kbd>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <p className="apply-note">입력 중에도 ⌘ 조합은 동작합니다. ? 는 입력창 밖에서만.</p>
    </Modal>
  );
}
