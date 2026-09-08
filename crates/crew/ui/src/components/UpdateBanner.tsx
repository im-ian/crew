import { useT } from "../LocaleContext";

type Props = {
  visible: boolean;
  version?: string;
  busy: boolean;
  error: string | null;
  onInstall: () => void;
  onLater: () => void;
  onClearError: () => void;
};

export function UpdateBanner({
  visible,
  version,
  busy,
  error,
  onInstall,
  onLater,
  onClearError,
}: Props) {
  const t = useT();
  if (!visible || !version) {
    return <div className="update-banner-slot" />;
  }

  return (
    <div className="update-banner-slot">
      <div className="update-banner">
        <div className="update-banner-msg">
          <span className="update-banner-ver">Crew {version}</span>{" "}
          {t("update.available")}
          {error ? (
            <span className="update-banner-error">
              {" "}
              {error}{" "}
              <button type="button" className="linkish" onClick={onClearError}>
                {t("common.close")}
              </button>
            </span>
          ) : null}
        </div>
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={onInstall}
        >
          {busy ? t("update.installing") : t("update.install")}
        </button>
        <button type="button" className="ghost" disabled={busy} onClick={onLater}>
          {t("update.later")}
        </button>
      </div>
    </div>
  );
}
