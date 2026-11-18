import { useEffect, useState } from "react";
import { api, errMsg } from "../api";
import { useT } from "../LocaleContext";
import { minutesSeconds, phoneUrl, type MobilePair, type MobileStatus } from "../mobileAccess";
import { Field } from "./Field";
import { Seg } from "./Seg";

/**
 * Mobile access: Crew's UI and commands on this Mac's Tailscale address, for
 * a phone paired with a short code. Off until turned on here.
 */
export function MobileSettings({ active }: { active: boolean }) {
  const t = useT();
  const [status, setStatus] = useState<MobileStatus | null>(null);
  const [pair, setPair] = useState<(MobilePair & { until: number }) | null>(null);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function run(task: () => Promise<MobileStatus | void>) {
    setBusy(true);
    setError("");
    try {
      const next = await task();
      if (next) setStatus(next);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!active) return;
    void run(() => api.mobileStatus());
  }, [active]);

  // The code's countdown, and the device list once a phone pairs with it.
  useEffect(() => {
    if (!pair) return;
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    const poll = window.setInterval(() => {
      void api
        .mobileStatus()
        .then(setStatus)
        .catch(() => {});
    }, 3000);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(poll);
    };
  }, [pair]);

  const paired = status?.devices.length ?? 0;
  useEffect(() => {
    // A phone used the code: it is spent.
    setPair(null);
  }, [paired]);

  const left = pair ? (pair.until - now) / 1000 : 0;
  useEffect(() => {
    if (pair && left <= 0) setPair(null);
  }, [pair, left]);

  const on = !!status?.enabled;
  const url = status ? phoneUrl(status) : null;
  const { m, s } = minutesSeconds(left);

  return (
    <div className="form-stack mobile-settings">
      <Field label={t("mobile.access")} hint={t("mobile.accessHint")}>
        <Seg
          value={on ? "on" : "off"}
          options={[
            { value: "on", label: t("templateEdit.on") },
            { value: "off", label: t("templateEdit.off") },
          ]}
          onChange={(v) => {
            setPair(null);
            void run(() => api.mobileSet(v === "on"));
          }}
        />
      </Field>
      {error ? <p className="field-hint mobile-error">{error}</p> : null}
      {on && status ? (
        <>
          <Field label={t("mobile.address")} hint={url ? t("mobile.addressHint") : t("mobile.noTailscale")}>
            <div className="mobile-urls">
              {status.urls.map((u) => (
                <code key={u}>{u}</code>
              ))}
            </div>
          </Field>
          {status.error ? <p className="field-hint mobile-error">{status.error}</p> : null}
          <Field label={t("mobile.pair")} hint={t("mobile.pairHint")}>
            {pair ? (
              <div className="mobile-pair">
                <div
                  className="mobile-qr"
                  aria-label={t("mobile.qr")}
                  // The daemon draws it from the address; it holds no input.
                  dangerouslySetInnerHTML={{ __html: pair.qrSvg }}
                />
                <div className="mobile-code">
                  <b>{pair.code}</b>
                  <small>{t("mobile.expires", { m: String(m), s: String(s).padStart(2, "0") })}</small>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="ghost"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const next = await api.mobilePair();
                    setNow(Date.now());
                    setPair({ ...next, until: Date.now() + next.expiresIn * 1000 });
                  })
                }
              >
                {t("mobile.newCode")}
              </button>
            )}
          </Field>
          <Field label={t("mobile.devices")}>
            {status.devices.length ? (
              <ul className="mobile-devices">
                {status.devices.map((d) => (
                  <li key={d.id}>
                    <span>{d.name}</span>
                    <small>{new Date((d.lastSeen || d.created) * 1000).toLocaleString()}</small>
                    <button
                      type="button"
                      className="ghost sm"
                      disabled={busy}
                      onClick={() => void run(() => api.mobileRevoke(d.id))}
                    >
                      {t("mobile.revoke")}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="field-hint">{t("mobile.noDevices")}</p>
            )}
          </Field>
        </>
      ) : null}
    </div>
  );
}
