import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { useT } from "../LocaleContext";
import {
  getPairState,
  pairCodeFromUrl,
  pairDevice,
  subscribePair,
  webInvoke,
  withoutPairCode,
  type PairResult,
} from "../web";

/**
 * On a phone, the app once this device is paired, and the code form until
 * then. A QR from the laptop opens with the code in the address, and that
 * code is tried first. Any call that comes back 401 later, such as after the
 * pairing was removed on the laptop, brings the form back.
 */
export function PairGate({ children }: { children: ReactNode }) {
  const state = useSyncExternalStore(subscribePair, getPairState);
  const [checked, setChecked] = useState(false);
  const [first, setFirst] = useState<PairResult | null>(null);

  useEffect(() => {
    let gone = false;
    void (async () => {
      const code = pairCodeFromUrl(window.location.href);
      if (code) {
        window.history.replaceState(null, "", withoutPairCode(window.location.href));
        const result = await pairDevice(code);
        if (!gone && result !== "paired") setFirst(result);
      }
      if (getPairState() === "unknown") {
        // A 401 marks this device unpaired. Anything else is the
        // connection banner's to show, inside the app.
        await webInvoke("daemon_ping").catch(() => undefined);
      }
      if (!gone) setChecked(true);
    })();
    return () => {
      gone = true;
    };
  }, []);

  if (state === "unpaired") return <PairScreen first={first} />;
  if (state !== "paired" && !checked) return null;
  return <>{children}</>;
}

function PairScreen({ first }: { first: PairResult | null }) {
  const t = useT();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PairResult | null>(first);

  useEffect(() => setResult(first), [first]);

  async function submit() {
    if (busy || !code.trim()) return;
    setBusy(true);
    const next = await pairDevice(code);
    setBusy(false);
    if (next !== "paired") setResult(next);
  }

  const message =
    result === "wrong"
      ? t("pair.wrong")
      : result === "unreachable"
        ? t("pair.unreachable")
        : result && typeof result === "object"
          ? t("pair.failed", { error: result.error })
          : null;

  return (
    <div className="pair-screen" role="main">
      <form
        className="pair-card"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h1 className="pair-title">{t("pair.title")}</h1>
        <p className="pair-note">{t("pair.note")}</p>
        <label className="pair-label" htmlFor="pair-code">
          {t("pair.code")}
        </label>
        <input
          id="pair-code"
          className="textin pair-input"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoComplete="one-time-code"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          autoFocus
        />
        {message ? (
          <p className="pair-error" role="alert">
            {message}
          </p>
        ) : null}
        <button type="submit" className="primary pair-submit" disabled={busy || !code.trim()}>
          {busy ? t("pair.busy") : t("pair.submit")}
        </button>
      </form>
    </div>
  );
}
