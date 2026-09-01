import { useLocale, useT } from "../LocaleContext";
import type { Locale } from "../i18n";
import type { ThemePref } from "../theme";
import { Field } from "./Field";
import { Modal } from "./Modal";
import { Seg } from "./Seg";

type Props = {
  open: boolean;
  theme: ThemePref;
  onTheme: (theme: ThemePref) => void;
  onClose: () => void;
  onOpenShortcuts: () => void;
};

const LANGS: { value: Locale; label: string }[] = [
  { value: "ko", label: "한글" },
  { value: "en", label: "English" },
];

export function SettingsPane({
  open,
  theme,
  onTheme,
  onClose,
  onOpenShortcuts,
}: Props) {
  const t = useT();
  const { locale, setLocale } = useLocale();
  const themes: { value: ThemePref; label: string }[] = [
    { value: "dark", label: t("settings.theme.dark") },
    { value: "light", label: t("settings.theme.light") },
    { value: "system", label: t("settings.theme.system") },
  ];
  const themeNote =
    theme === "system"
      ? t("settings.theme.note.system")
      : theme === "light"
        ? t("settings.theme.note.light")
        : t("settings.theme.note.dark");

  return (
    <Modal open={open} title={t("settings.title")} onClose={onClose}>
      <div className="form-stack">
        <Field label={t("settings.appearance")}>
          <Seg value={theme} options={themes} onChange={onTheme} />
        </Field>
        <p className="apply-note">{themeNote}</p>
        <Field label={t("settings.language")}>
          <Seg value={locale} options={LANGS} onChange={setLocale} />
        </Field>
        <p className="apply-note">{t("settings.language.note")}</p>
        <Field label={t("settings.shortcuts")}>
          <button type="button" className="ghost settings-action" onClick={onOpenShortcuts}>
            {t("settings.shortcutsOpen")}
          </button>
        </Field>
      </div>
    </Modal>
  );
}
