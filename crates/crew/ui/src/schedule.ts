export type Repeat = "daily" | "weekdays" | "weekly" | "hourly";

export const REPEAT_OPTIONS: { value: Repeat; label: string }[] = [
  { value: "daily", label: "매일" },
  { value: "weekdays", label: "평일" },
  { value: "weekly", label: "매주" },
  { value: "hourly", label: "매시" },
];

export const WEEKDAYS: { value: number; short: string; label: string }[] = [
  { value: 1, short: "월", label: "월요일" },
  { value: 2, short: "화", label: "화요일" },
  { value: 3, short: "수", label: "수요일" },
  { value: 4, short: "목", label: "목요일" },
  { value: 5, short: "금", label: "금요일" },
  { value: 6, short: "토", label: "토요일" },
  { value: 0, short: "일", label: "일요일" },
];

const DOW_FULL = ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"];

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

export function formatClock(hour: number, minute: number): string {
  const ampm = hour < 12 ? "오전" : "오후";
  let h12 = hour % 12;
  if (h12 === 0) h12 = 12;
  return `${ampm} ${h12}:${String(minute).padStart(2, "0")}`;
}

export function formatSchedule(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return "예약된 시각";
  const [min, hour, dom, month, dow] = parts;
  if (dom !== "*" || month !== "*") return "예약된 시각";

  const minStep = min.match(/^\*\/(\d+)$/);
  if (minStep && hour === "*" && (dow === "*" || !dow)) {
    return `${Number(minStep[1])}분마다`;
  }
  const hourStep = hour.match(/^\*\/(\d+)$/);
  if (min === "0" && hourStep && (dow === "*" || !dow)) {
    return `${Number(hourStep[1])}시간마다`;
  }
  if (/^\d+$/.test(min) && hour === "*" && (dow === "*" || !dow)) {
    return Number(min) === 0 ? "매시 정각" : `매시 ${Number(min)}분`;
  }

  const time = clockFromFields(hour, min);
  if (!time) return "예약된 시각";
  if (dow === "*") return `매일 ${time}`;
  if (dow === "1-5") return `평일 ${time}`;
  if (dow === "0,6" || dow === "6,0") return `주말 ${time}`;
  if (/^\d+(,\d+)*$/.test(dow)) {
    const names = dow.split(",").map((n) => DOW_FULL[Number(n) % 7] || "");
    if (names.some((n) => !n)) return time;
    if (names.length === 1) return `매주 ${names[0]} ${time}`;
    return `${names.join(" · ")} ${time}`;
  }
  return time;
}

function clockFromFields(hour: string, min: string): string | null {
  if (!/^\d+$/.test(hour) || !/^\d+$/.test(min)) return null;
  const h = Number(hour);
  const m = Number(min);
  if (h > 23 || m > 59) return null;
  return formatClock(h, m);
}

export function parseTimeValue(value: string): { hour: number; minute: number } | null {
  const m = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}
