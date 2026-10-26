import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api";
import { useLocale, useT } from "../LocaleContext";
import type { Locale } from "../i18n";
import type { Delivery } from "../deliveryPref";
import { loadNotify, saveNotify } from "../notifyPref";
import type { ThemePref } from "../theme";
import type { UpdaterApi } from "../updater";
import { Field } from "./Field";
import { Modal } from "./Modal";
import { Seg } from "./Seg";

type Props = {
  open: boolean;
  theme: ThemePref;
  onTheme: (theme: ThemePref) => void;
  showTools: boolean;
  onShowTools: (show: boolean) => void;
  delivery: Delivery;
  onDelivery: (mode: Delivery) => void;
  onClose: () => void;
  onOpenShortcuts: () => void;
  onOpenSkills: () => void;
  updater: UpdaterApi;
};

const LANGS: { value: Locale; label: string }[] = [
  { value: "ko", label: "한글" },
  { value: "en", label: "English" },
];

export function SettingsPane({
  open,
  theme,
  onTheme,
  showTools,
  onShowTools,
  delivery,
  onDelivery,
  onClose,
  onOpenShortcuts,
  onOpenSkills,
  updater,
}: Props) {
  const t = useT();
  const { locale, setLocale } = useLocale();
  const [notify, setNotify] = useState(loadNotify);

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

  return (
    <Modal open={open} title={t("settings.title")} onClose={onClose}>
      <div className="settings-groups">
        <SettingsGroup title={t("settings.group.display")}>
          <Field label={t("settings.appearance")}>
            <Seg value={theme} options={themes} onChange={onTheme} />
          </Field>
          <p className="apply-note">{themeNote}</p>
          <Field label={t("settings.language")}>
            <Seg value={locale} options={LANGS} onChange={setLocale} />
          </Field>
          <p className="apply-note">{t("settings.language.note")}</p>
        </SettingsGroup>
        <SettingsGroup title={t("settings.group.chat")}>
          <Field label={t("settings.delivery")}>
            <Seg
              value={delivery}
              options={[
                { value: "queue", label: t("settings.delivery.queue") },
                { value: "interrupt", label: t("settings.delivery.interrupt") },
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
        </SettingsGroup>
        <SettingsGroup title={t("settings.group.app")}>
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
          <Field label={t("settings.shortcuts")}>
            <button type="button" className="ghost settings-action" onClick={onOpenShortcuts}>
              {t("settings.shortcutsOpen")}
            </button>
          </Field>
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
        </SettingsGroup>
      </div>
    </Modal>
  );
}

function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="settings-group">
      <h4>{title}</h4>
      <div className="form-stack">{children}</div>
    </section>
  );
}
