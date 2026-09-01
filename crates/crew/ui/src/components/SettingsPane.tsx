import { Field } from "./Field";
import { Modal } from "./Modal";
import { Seg } from "./Seg";
import type { ThemePref } from "../theme";

type Props = {
  open: boolean;
  theme: ThemePref;
  onTheme: (theme: ThemePref) => void;
  onClose: () => void;
  onOpenShortcuts: () => void;
};

const THEMES: { value: ThemePref; label: string }[] = [
  { value: "dark", label: "다크" },
  { value: "light", label: "라이트" },
  { value: "system", label: "시스템" },
];

export function SettingsPane({
  open,
  theme,
  onTheme,
  onClose,
  onOpenShortcuts,
}: Props) {
  return (
    <Modal open={open} title="설정" onClose={onClose}>
      <div className="form-stack">
        <Field label="모양">
          <Seg value={theme} options={THEMES} onChange={onTheme} />
        </Field>
        <p className="apply-note">
          {theme === "system"
            ? "맥 외관 설정을 따릅니다."
            : theme === "light"
              ? "밝은 배경으로 표시합니다."
              : "어두운 배경으로 표시합니다."}
        </p>
        <Field label="단축키">
          <button type="button" className="ghost settings-action" onClick={onOpenShortcuts}>
            단축키 보기
          </button>
        </Field>
      </div>
    </Modal>
  );
}
