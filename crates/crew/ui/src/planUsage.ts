import type { TFn } from "./i18n";
import type { AgentInfo, PlanUsage, PlanWindow } from "./types";
import { cliFromCmd } from "./options";

/** CLIs whose plan Crew can read, in the order the sidebar lists them. */
const READABLE = ["claude", "codex", "grok", "agy"] as const;
const LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  grok: "Grok",
  agy: "Antigravity",
};

/** A window this full shows as a warning. */
export const WARN_PERCENT = 80;

/** The readable CLIs among the bots there are, each once. */
export function usageClis(agents: AgentInfo[]): string[] {
  const have = new Set(agents.map((a) => cliFromCmd(a.cmd)));
  return READABLE.filter((cli) => have.has(cli));
}

const DAY = 24 * 60;

/**
 * A window's name, from how long it runs: "5h", "1일", "주간", "30일".
 * `long` is the name in a sentence, "5시간 한도". An old reading that never
 * said how long its window is is just "한도".
 */
export function windowName(minutes: number | null | undefined, t: TFn, long = false): string {
  if (!minutes || minutes <= 0) return t(long ? "usage.limitLong" : "usage.limit");
  if (minutes === 7 * DAY) return t(long ? "usage.weeklyLong" : "usage.weekly");
  if (minutes % DAY === 0) return t(long ? "usage.daysLong" : "usage.days", { n: minutes / DAY });
  const hours = Math.max(1, Math.round(minutes / 60));
  return t(long ? "usage.hoursLong" : "usage.hours", { n: hours });
}

/** A column per window length; one of unknown length goes last. */
function windowKey(minutes: number | null | undefined): string {
  return minutes && minutes > 0 ? String(minutes) : "?";
}

function keyOrder(key: string): number {
  return key === "?" ? Number.MAX_SAFE_INTEGER : Number(key);
}

export type UsageCell = {
  /** The window's length in minutes, as text, or "?" when unknown: the column it sits in. */
  key: string;
  label: string;
  /** The window's name in a sentence, "5시간 한도". */
  name: string;
  percent: number;
  /** Unix seconds. */
  resetsAt: number | null;
  /** "in 2 h", or null when the reset is unknown. */
  until: string | null;
  /** The window started over since this was read, so the number is old. */
  stale: boolean;
  warn: boolean;
  title: string;
};

export type UsageRow = {
  cli: string;
  label: string;
  cells: UsageCell[];
  /** Unix seconds when the numbers were read. */
  capturedAt: number | null;
  /** Separate pools inside the plan, each with its own weekly window, for the details. */
  groups: { name: string; cell: UsageCell }[];
};

/** How long until `resetsAt`, as the shortest unit that is not zero. */
export function untilLabel(resetsAt: number | null | undefined, nowMs: number, t: TFn): string | null {
  if (!resetsAt) return null;
  const mins = Math.max(0, Math.round((resetsAt * 1000 - nowMs) / 60000));
  if (mins < 60) return t("usage.inMinutes", { n: Math.max(1, mins) });
  const hours = Math.round(mins / 60);
  if (hours < 24) return t("usage.inHours", { n: hours });
  return t("usage.inDays", { n: Math.round(hours / 24) });
}

/** How long ago `capturedAt` was, or null when unknown. */
export function agoLabel(capturedAt: number | null | undefined, nowMs: number, t: TFn): string | null {
  if (!capturedAt) return null;
  const mins = Math.max(0, Math.round((nowMs - capturedAt * 1000) / 60000));
  if (mins < 1) return t("usage.justNow");
  if (mins < 60) return t("usage.minutesAgo", { n: mins });
  const hours = Math.round(mins / 60);
  if (hours < 24) return t("usage.hoursAgo", { n: hours });
  return t("usage.daysAgo", { n: Math.round(hours / 24) });
}

/** True when any window is near its limit, for the dot on the button. */
export function anyWarn(rows: UsageRow[]): boolean {
  return rows.some((r) => r.cells.some((c) => c.warn));
}

/** The columns to draw: a window only when some plan has it, so with no five-hour cap anywhere only the weekly one is left. */
export function usageColumns(rows: UsageRow[]): { key: UsageCell["key"]; label: string }[] {
  const seen = new Map<string, string>();
  for (const c of rows.flatMap((r) => r.cells)) if (!seen.has(c.key)) seen.set(c.key, c.label);
  return [...seen]
    .sort(([a], [b]) => keyOrder(a) - keyOrder(b))
    .map(([key, label]) => ({ key, label }));
}

/** Rows for the sidebar. A window the plan does not have right now is not shown. */
export function usageRows(usage: PlanUsage[], nowMs: number, t: TFn): UsageRow[] {
  const rows: UsageRow[] = [];
  for (const cli of READABLE) {
    const u = usage.find((x) => x.cli === cli);
    if (!u) continue;
    const label = LABELS[cli];
    const cells: UsageCell[] = [];
    const cell = (w: PlanWindow, name: string): UsageCell => {
      const percent = Math.min(100, Math.max(0, Math.round(w.usedPercent)));
      const stale = !!w.resetsAt && w.resetsAt * 1000 <= nowMs;
      const until = untilLabel(w.resetsAt, nowMs, t);
      const title = stale
        ? t("usage.titleStale", { cli: label, name })
        : until
          ? t("usage.titleResets", { cli: label, name, percent, until })
          : t("usage.title", { cli: label, name, percent });
      return {
        key: windowKey(w.minutes),
        label: windowName(w.minutes, t),
        name,
        percent,
        resetsAt: w.resetsAt ?? null,
        until,
        stale,
        warn: !stale && percent >= WARN_PERCENT,
        title,
      };
    };
    for (const w of u.windows ?? []) cells.push(cell(w, windowName(w.minutes, t, true)));
    const groups = (u.groups ?? []).map((g) => ({ name: g.name, cell: cell(g.window, g.name) }));
    if (cells.length) rows.push({ cli, label, cells, capturedAt: u.capturedAt ?? null, groups });
  }
  return rows;
}
