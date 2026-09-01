import type { TFn } from "./i18n";
import type { MessageKey } from "./locales";

export type Repeat = "daily" | "weekdays" | "weekly" | "hourly";

export const REPEAT_VALUES: Repeat[] = ["daily", "weekdays", "weekly", "hourly"];

export function repeatOptions(t: TFn): { value: Repeat; label: string }[] {
  return REPEAT_VALUES.map((value) => ({
    value,
    label: t(`repeat.${value}` as MessageKey),
  }));
}

export const WEEKDAYS: { value: number }[] = [
  { value: 1 },
  { value: 2 },
  { value: 3 },
  { value: 4 },
  { value: 5 },
  { value: 6 },
  { value: 0 },
];

export function toCron(
  repeat: Repeat,
  days: number[],
  hour: number,
  minute: number,
): string {
  const m = String(minute);
  const h = String(hour);
  if (repeat === "hourly") return `${m} * * * *`;
  if (repeat === "daily") return `${m} ${h} * * *`;
  if (repeat === "weekdays") return `${m} ${h} * * 1-5`;
  const picked = (days.length ? days : [1]).slice().sort((a, b) => a - b);
  return `${m} ${h} * * ${picked.join(",")}`;
}

export function formatClock(hour: number, minute: number, t: TFn): string {
  const ampm = hour < 12 ? t("clock.am") : t("clock.pm");
  let h12 = hour % 12;
  if (h12 === 0) h12 = 12;
  return t("clock.time", { ampm, h: h12, mm: String(minute).padStart(2, "0") });
}

export function formatSchedule(expr: string, t: TFn): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return t("schedule.custom");
  const [min, hour, dom, month, dow] = parts;
  if (dom !== "*" || month !== "*") return t("schedule.custom");

  const minStep = min.match(/^\*\/(\d+)$/);
  if (minStep && hour === "*" && (dow === "*" || !dow)) {
    return t("schedule.everyMinutes", { n: Number(minStep[1]) });
  }
  const hourStep = hour.match(/^\*\/(\d+)$/);
  if (min === "0" && hourStep && (dow === "*" || !dow)) {
    return t("schedule.everyHours", { n: Number(hourStep[1]) });
  }
  if (/^\d+$/.test(min) && hour === "*" && (dow === "*" || !dow)) {
    return Number(min) === 0
      ? t("schedule.hourlyOnHour")
      : t("schedule.hourlyAtMinute", { n: Number(min) });
  }

  const time = clockFromFields(hour, min, t);
  if (!time) return t("schedule.custom");
  if (dow === "*") return t("schedule.dailyAt", { time });
  if (dow === "1-5") return t("schedule.weekdaysAt", { time });
  if (dow === "0,6" || dow === "6,0") return t("schedule.weekendAt", { time });
  if (/^\d+(,\d+)*$/.test(dow)) {
    const names = dow.split(",").map((n) => {
      const i = Number(n) % 7;
      if (!Number.isInteger(i)) return "";
      return t(`dow.${i}` as MessageKey);
    });
    if (names.some((n) => !n)) return time;
    if (names.length === 1) return t("schedule.weeklyAt", { day: names[0], time });
    return t("schedule.daysAt", { days: names.join(" · "), time });
  }
  return time;
}

function clockFromFields(hour: string, min: string, t: TFn): string | null {
  if (!/^\d+$/.test(hour) || !/^\d+$/.test(min)) return null;
  const h = Number(hour);
  const m = Number(min);
  if (h > 23 || m > 59) return null;
  return formatClock(h, m, t);
}

export function parseTimeValue(value: string): { hour: number; minute: number } | null {
  const m = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}
