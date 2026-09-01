import { Field } from "./Field";
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
    <div
      className={"overlay settings-overlay" + (open ? " open" : "")}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="sheet agent-sheet">
        <div className="sheet-head">
          <h3>설정</h3>
          <button
            type="button"
            className="sheet-close"
            title="닫기"
            aria-label="닫기"
            onClick={onClose}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M4 4l8 8M12 4l-8 8"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
        <div className="sheet-body">
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
        </div>
      </div>
    </div>
  );
}
