import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { api } from "../api";
import { loadBotDefault, saveBotDefault, type BotDefault } from "../botDefault";
import { useLocale, useT } from "../LocaleContext";
import type { Locale } from "../i18n";
import type { ChatWidth } from "../chatWidth";
import type { Delivery } from "../deliveryPref";
import { loadNotify, saveNotify } from "../notifyPref";
import type { ThemePref } from "../theme";
import type { UpdaterApi } from "../updater";
import { Info, Keyboard, MessageSquare, Monitor, SlidersHorizontal } from "../icons";
import { Field } from "./Field";
import { Modal } from "./Modal";
import { ModelPicker } from "./ModelPicker";
import { Seg } from "./Seg";
import { ShortcutList } from "./ShortcutHelp";

type Props = {
  open: boolean;
  theme: ThemePref;
  onTheme: (theme: ThemePref) => void;
  chatWidth: ChatWidth;
  onChatWidth: (width: ChatWidth) => void;
  showTools: boolean;
  onShowTools: (show: boolean) => void;
  delivery: Delivery;
  onDelivery: (mode: Delivery) => void;
  onClose: () => void;
  onOpenSkills: () => void;
  updater: UpdaterApi;
};

type Section = "general" | "display" | "chat" | "shortcuts" | "about";

const LANGS: { value: Locale; label: string }[] = [
  { value: "ko", label: "한글" },
  { value: "en", label: "English" },
];

export function SettingsPane({
  open,
  theme,
  onTheme,
  chatWidth,
  onChatWidth,
  showTools,
  onShowTools,
  delivery,
  onDelivery,
  onClose,
  onOpenSkills,
  updater,
}: Props) {
  const t = useT();
  const { locale, setLocale } = useLocale();
  const [notify, setNotify] = useState(loadNotify);
  const [botDefault, setBotDefault] = useState(loadBotDefault);

  function changeBotDefault(next: Partial<BotDefault>) {
    setBotDefault((prev) => {
      const merged = { ...prev, ...next };
      saveBotDefault(merged);
      return merged;
    });
  }
  // Stays on the last page while the app runs, like the window it came from.
  const [section, setSection] = useState<Section>("general");

  useEffect(() => {
    saveNotify(notify);
    // The daemon sends the same alerts while the window is closed.
    void api.setNotifications(notify).catch(() => {});
  }, [notify]);

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

  const sections: { id: Section; label: string; icon: ReactNode }[] = [
    { id: "general", label: t("settings.group.general"), icon: <SlidersHorizontal /> },
    { id: "display", label: t("settings.group.display"), icon: <Monitor /> },
    { id: "chat", label: t("settings.group.chat"), icon: <MessageSquare /> },
    { id: "shortcuts", label: t("settings.shortcuts"), icon: <Keyboard /> },
    { id: "about", label: t("settings.group.about"), icon: <Info /> },
  ];
  const current = sections.find((s) => s.id === section) ?? sections[0];

  function onNavKey(e: KeyboardEvent<HTMLDivElement>) {
    const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const at = sections.findIndex((s) => s.id === section);
    const next = sections[(at + step + sections.length) % sections.length];
    setSection(next.id);
    e.currentTarget
      .querySelector<HTMLButtonElement>(`[data-section="${next.id}"]`)
      ?.focus();
  }

  return (
    <Modal
      open={open}
      title={t("settings.title")}
      onClose={onClose}
      className="settings-dialog"
    >
      <div className="settings-split">
        <div
          className="settings-nav"
          role="tablist"
          aria-orientation="vertical"
          onKeyDown={onNavKey}
        >
          {sections.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              data-section={s.id}
              aria-label={s.label}
              title={s.label}
              aria-selected={s.id === section}
              tabIndex={s.id === section ? 0 : -1}
              className={s.id === section ? "on" : ""}
              onClick={() => setSection(s.id)}
            >
              {s.icon}
              <span>{s.label}</span>
            </button>
          ))}
        </div>
        <div className="settings-body" role="tabpanel" key={section}>
          <h4>{current.label}</h4>
          {section === "general" ? (
            <div className="form-stack">
              <Field label={t("settings.language")}>
                <Seg value={locale} options={LANGS} onChange={setLocale} />
              </Field>
              <p className="apply-note">{t("settings.language.note")}</p>
              <div className="settings-notify">
                <label className="field" htmlFor="settings-notify">
                  {t("settings.notifications")}
                </label>
                <input
                  id="settings-notify"
                  type="checkbox"
                  role="switch"
                  className="switch"
                  checked={notify}
                  title={notify ? t("common.on") : t("common.off")}
                  onChange={(e) => setNotify(e.target.checked)}
                />
              </div>
              <p className="apply-note">
                {notify
                  ? t("settings.notifications.note.on")
                  : t("settings.notifications.note.off")}
              </p>
              <Field label={t("settings.botDefault")}>
                <ModelPicker
                  cli={botDefault.cli}
                  model={botDefault.model}
                  effort={botDefault.effort}
                  active={open && section === "general"}
                  command={botDefault.cmd}
                  onCli={(cli) =>
                    changeBotDefault({ cli, model: "", effort: "", cmd: "" })
                  }
                  onModel={(model) => changeBotDefault({ model })}
                  onEffort={(effort) => changeBotDefault({ effort })}
                  onCommand={(cmd) => changeBotDefault({ cmd })}
                />
              </Field>
              <p className="apply-note">{t("settings.botDefault.note")}</p>
            </div>
          ) : section === "display" ? (
            <div className="form-stack">
              <Field label={t("settings.appearance")}>
                <Seg value={theme} options={themes} onChange={onTheme} />
              </Field>
              <p className="apply-note">{themeNote}</p>
              <Field label={t("settings.chatWidth")}>
                <Seg
                  value={chatWidth}
                  options={[
                    { value: "full", label: t("settings.chatWidth.full") },
                    { value: "narrow", label: t("settings.chatWidth.narrow") },
                  ]}
                  onChange={onChatWidth}
                />
              </Field>
              <p className="apply-note">
                {chatWidth === "narrow"
                  ? t("settings.chatWidth.note.narrow")
                  : t("settings.chatWidth.note.full")}
              </p>
            </div>
          ) : section === "chat" ? (
            <div className="form-stack">
              <Field label={t("settings.delivery")}>
                <Seg
                  value={delivery}
                  options={[
                    { value: "interrupt", label: t("settings.delivery.interrupt") },
                    { value: "queue", label: t("settings.delivery.queue") },
                  ]}
                  onChange={onDelivery}
                />
              </Field>
              <p className="apply-note">
                {delivery === "interrupt"
                  ? t("settings.delivery.note.interrupt")
                  : t("settings.delivery.note.queue")}
              </p>
              <Field label={t("settings.tools")}>
                <Seg
                  value={showTools ? "on" : "off"}
                  options={[
                    { value: "on", label: t("common.on") },
                    { value: "off", label: t("common.off") },
                  ]}
                  onChange={(v) => onShowTools(v === "on")}
                />
              </Field>
              <p className="apply-note">{t("settings.tools.note")}</p>
              <Field label={t("settings.skills")}>
                <button type="button" className="ghost settings-action" onClick={onOpenSkills}>
                  {t("settings.skillsOpen")}
                </button>
              </Field>
              <p className="apply-note">{t("settings.skills.note")}</p>
            </div>
          ) : section === "shortcuts" ? (
            <>
              <ShortcutList />
              <p className="apply-note">{t("shortcut.note")}</p>
            </>
          ) : (
            <div className="form-stack">
              <Field label={t("settings.update")}>
                <div className="update-actions">
                  <button
                    type="button"
                    className="ghost settings-action"
                    disabled={updater.busy}
                    onClick={() => void updater.check(true)}
                  >
                    {updater.busy
                      ? t("settings.update.checking")
                      : t("settings.update.check")}
                  </button>
                  {updater.available ? (
                    <button
                      type="button"
                      className="primary settings-action"
                      disabled={updater.busy}
                      onClick={() => void updater.install()}
                    >
                      {updater.busy
                        ? t("update.installing")
                        : t("settings.update.install")}
                    </button>
                  ) : null}
                </div>
              </Field>
              <p className={"apply-note" + (updater.error ? " is-error" : "")}>
                {updater.error
                  ? updater.error
                  : updater.available
                    ? t("settings.update.available", {
                        version: updater.available.version,
                      })
                    : updater.currentVersion
                      ? t("settings.update.current", {
                          version: updater.currentVersion,
                        })
                      : t("settings.update.note")}
              </p>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

