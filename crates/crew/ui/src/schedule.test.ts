import { describe, expect, it } from "vitest";
import { formatSchedule, parseTimeValue, toCron } from "./schedule";
import type { TFn } from "./i18n";

// Stub translator: reports the key and its variables, so a test asserts on the
// branch that was taken rather than on Korean copy.
const t = ((key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}(${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(",")})` : key) as TFn;

describe("toCron", () => {
  it("writes one expression per repeat kind", () => {
    expect(toCron("daily", [], 9, 0)).toBe("0 9 * * *");
    expect(toCron("weekdays", [], 8, 30)).toBe("30 8 * * 1-5");
    expect(toCron("hourly", [], 9, 45)).toBe("45 * * * *");
    expect(toCron("weekly", [5, 1], 18, 0)).toBe("0 18 * * 1,5");
  });

  it("falls back to Monday when a weekly routine picked no day", () => {
    expect(toCron("weekly", [], 7, 0)).toBe("0 7 * * 1");
  });
});

describe("parseTimeValue", () => {
  it("takes HH:MM inside a real clock", () => {
    expect(parseTimeValue("09:05")).toEqual({ hour: 9, minute: 5 });
    expect(parseTimeValue(" 23:59 ")).toEqual({ hour: 23, minute: 59 });
  });

  it("rejects anything else", () => {
    for (const bad of ["24:00", "09:60", "9:5", "0900", "", "aa:bb"]) {
      expect(parseTimeValue(bad), bad).toBeNull();
    }
  });
});

describe("formatSchedule", () => {
  it("names the shapes the picker can produce", () => {
    expect(formatSchedule("0 9 * * *", t)).toBe("schedule.dailyAt(time=clock.time(ampm=clock.am,h=9,mm=00))");
    expect(formatSchedule("30 8 * * 1-5", t)).toContain("schedule.weekdaysAt");
    expect(formatSchedule("0 10 * * 0,6", t)).toContain("schedule.weekendAt");
    expect(formatSchedule("0 9 * * 3", t)).toContain("schedule.weeklyAt(day=dow.3");
    expect(formatSchedule("0 9 * * 1,3", t)).toContain("schedule.daysAt(days=dow.1 · dow.3");
  });

  it("names the recurring shapes", () => {
    expect(formatSchedule("*/5 * * * *", t)).toBe("schedule.everyMinutes(n=5)");
    expect(formatSchedule("0 */2 * * *", t)).toBe("schedule.everyHours(n=2)");
    expect(formatSchedule("0 * * * *", t)).toBe("schedule.hourlyOnHour");
    expect(formatSchedule("15 * * * *", t)).toBe("schedule.hourlyAtMinute(n=15)");
  });

  it("gives up on expressions the picker cannot draw", () => {
    for (const expr of ["", "0 9 * *", "0 9 1 * *", "0 9 * 3 *", "0 99 * * *", "@daily"]) {
      expect(formatSchedule(expr, t), expr).toBe("schedule.custom");
    }
  });

  it("reads noon and midnight as PM 12 and AM 12", () => {
    expect(formatSchedule("0 12 * * *", t)).toContain("ampm=clock.pm,h=12");
    expect(formatSchedule("0 0 * * *", t)).toContain("ampm=clock.am,h=12");
  });
});
