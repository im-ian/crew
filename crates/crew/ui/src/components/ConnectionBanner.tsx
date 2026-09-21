import { useT } from "../LocaleContext";

type Props = {
  visible: boolean;
  detail: string;
};

/// Slot is always mounted so `role="status"` announces the change rather than
/// the insertion, and so the grid row does not shift when it appears.
export function ConnectionBanner({ visible, detail }: Props) {
  const t = useT();
  const text = detail.trim();
  return (
    <div className="conn-banner-slot" role="status">
      {visible ? (
        <div className="conn-banner">
          <div className="conn-banner-head">{t("conn.down")}</div>
          {/* The daemon's own words, which are English and often a log tail. */}
          {text ? <div className="conn-banner-detail">{text}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
