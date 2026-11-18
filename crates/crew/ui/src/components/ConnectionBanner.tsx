import { useT } from "../LocaleContext";
import { UNREACHABLE } from "../web";

type Props = {
  visible: boolean;
  detail: string;
};

/// Slot is always mounted so `role="status"` announces the change rather than
/// the insertion, and so the grid row does not shift when it appears.
export function ConnectionBanner({ visible, detail }: Props) {
  const t = useT();
  // On a phone the laptop itself can be gone: asleep, or off the tailnet.
  const laptop = detail === UNREACHABLE;
  const text = laptop ? "" : detail.trim();
  return (
    <div className="conn-banner-slot" role="status">
      {visible ? (
        <div className="conn-banner">
          <div className="conn-banner-head">{t(laptop ? "conn.laptopDown" : "conn.down")}</div>
          {/* The daemon's own words, which are English and often a log tail. */}
          {text ? <div className="conn-banner-detail">{text}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
