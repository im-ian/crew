import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocale } from "../LocaleContext";
import { api } from "../api";
import type { MessageKey, TFn } from "../i18n";
import { Gauge } from "../icons";
import {
  agoLabel,
  anyWarn,
  usageClis,
  usageColumns,
  usageRows,
  windowName,
  type UsageRow,
} from "../planUsage";
import type { AgentInfo, PlanUsage } from "../types";
import { Modal } from "./Modal";

/** Claude reports after each turn and Grok when it fetches credits, so a minute is fresh enough. */
const POLL_MS = 60_000;
/** Long enough to cross from the button into the popover without it closing. */
const HIDE_MS = 150;
/** Space between the button and the popover above it. */
const POP_GAP = 6;

/** The popover opens above the button, its left edge on the button's. */
export function popoverPlace(button: DOMRect, viewportHeight: number): { left: number; bottom: number } {
  return { left: button.left, bottom: viewportHeight - button.top + POP_GAP };
}

/**
 * A button beside settings for the plans the bots here run on. Hovering
 * shows the table; clicking opens the details.
 */
export function PlanUsageButton({ agents }: { agents: AgentInfo[] }) {
  const { t, locale } = useLocale();
  const clis = useMemo(() => usageClis(agents), [agents]);
  const key = clis.join(",");
  const [usage, setUsage] = useState<PlanUsage[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [hover, setHover] = useState(false);
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const hide = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!key) {
      setUsage([]);
      return;
    }
    let live = true;
    const read = () => {
      api
        .planUsage(key.split(","))
        .then((u) => {
          if (live) {
            setUsage(u);
            setNow(Date.now());
          }
        })
        .catch(() => {});
    };
    read();
    const timer = window.setInterval(read, POLL_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [key]);

  useEffect(() => () => window.clearTimeout(hide.current), []);

  if (!key) return null;
  const rows = usageRows(usage, now, t);
  const show = () => {
    window.clearTimeout(hide.current);
    setHover(true);
  };
  const later = () => {
    window.clearTimeout(hide.current);
    hide.current = window.setTimeout(() => setHover(false), HIDE_MS);
  };
  const rect = btn.current?.getBoundingClientRect();

  return (
    <>
      <button
        ref={btn}
        type="button"
        className="icon-btn plan-usage-btn"
        aria-label={t("usage.button")}
        aria-haspopup="dialog"
        onMouseEnter={show}
        onMouseLeave={later}
        onFocus={show}
        onBlur={later}
        onClick={() => {
          setHover(false);
          setOpen(true);
        }}
      >
        <Gauge />
        {anyWarn(rows) ? <span className="plan-usage-dot" aria-hidden="true" /> : null}
      </button>
      {hover && !open && rect
        ? createPortal(
            <div
              className="plan-usage-pop"
              role="tooltip"
              style={popoverPlace(rect, window.innerHeight)}
              onMouseEnter={show}
              onMouseLeave={later}
            >
              {rows.length ? (
                <PlanUsageRows rows={rows} label={t("usage.label")} />
              ) : (
                <p className="plan-usage-empty">{t("usage.empty")}</p>
              )}
            </div>,
            document.body,
          )
        : null}
      <Modal open={open} title={t("usage.detailTitle")} onClose={() => setOpen(false)} className="plan-usage-modal">
        <PlanUsageDetail rows={rows} now={now} t={t} locale={locale} />
        <div className="actions">
          <button type="button" className="primary" onClick={() => setOpen(false)}>
            {t("usage.close")}
          </button>
        </div>
      </Modal>
    </>
  );
}

/** The compact table: one row per CLI, one column per window some plan has. */
export function PlanUsageRows({ rows, label }: { rows: UsageRow[]; label: string }) {
  if (!rows.length) return null;
  const cols = usageColumns(rows);
  return (
    <div className="plan-usage" role="table" aria-label={label} style={{ ["--plan-cols" as string]: cols.length }}>
      <div className="plan-usage-row plan-usage-head" role="row">
        <span role="columnheader" />
        {cols.map((c) => (
          <span key={c.key} role="columnheader">
            {c.label}
          </span>
        ))}
      </div>
      {rows.map((row) => (
        <div className="plan-usage-row" role="row" key={row.cli}>
          <span className="plan-usage-cli" role="rowheader" title={row.label}>
            {row.label}
          </span>
          {cols.map(({ key: k }) => {
            const cell = row.cells.find((c) => c.key === k);
            if (!cell) return <span key={k} role="cell" className="plan-usage-cell none" />;
            return (
              <span
                key={k}
                role="cell"
                className={cell.warn ? "plan-usage-cell warn" : "plan-usage-cell"}
                aria-label={cell.title}
              >
                <span className="plan-usage-num">{cell.stale ? "—" : `${cell.percent}%`}</span>
                <span className="plan-usage-meter" aria-hidden="true">
                  <span style={{ width: cell.stale ? 0 : `${cell.percent}%` }} />
                </span>
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function resetWhen(resetsAt: number, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "numeric",
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(resetsAt * 1000));
  } catch {
    return new Date(resetsAt * 1000).toLocaleString();
  }
}

/** Each plan's windows in full: how much is used, when it resets, and where the number came from. */
export function PlanUsageDetail({
  rows,
  now,
  t,
  locale,
}: {
  rows: UsageRow[];
  now: number;
  t: TFn;
  locale: string;
}) {
  if (!rows.length) return <p className="plan-usage-empty">{t("usage.empty")}</p>;
  return (
    <div className="plan-usage-detail">
      {rows.map((row) => {
        const ago = agoLabel(row.capturedAt, now, t);
        const source = t(`usage.source.${row.cli}` as MessageKey);
        return (
          <section key={row.cli} className="plan-usage-card">
            <div className="plan-usage-card-head">
              <strong>{row.label}</strong>
              {ago ? <span>{t("usage.readAt", { ago })}</span> : null}
            </div>
            {(row.groups.length
              ? row.groups.map((g) => ({ key: g.name, name: g.name, cell: g.cell }))
              : row.cells.map((cell) => ({
                  key: cell.key,
                  name: windowName(cell.key, t, true),
                  cell,
                }))
            ).map(({ key, name, cell }) => (
              <div key={key} className={cell.warn ? "plan-usage-line warn" : "plan-usage-line"}>
                <div className="plan-usage-line-top">
                  <span>{name}</span>
                  <span className="plan-usage-big">{cell.stale ? "—" : t("usage.used", { percent: cell.percent })}</span>
                </div>
                <span className="plan-usage-meter" aria-hidden="true">
                  <span style={{ width: cell.stale ? 0 : `${cell.percent}%` }} />
                </span>
                <div className="plan-usage-line-sub">
                  {cell.stale
                    ? t("usage.resetDone")
                    : cell.resetsAt && cell.until
                      ? t("usage.resetsAt", { when: resetWhen(cell.resetsAt, locale), until: cell.until })
                      : null}
                </div>
              </div>
            ))}
            <div className="plan-usage-source">{source}</div>
          </section>
        );
      })}
      <div className="plan-usage-note">{t("usage.note")}</div>
    </div>
  );
}
