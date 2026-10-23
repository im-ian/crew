// `Intl.DateTimeFormat` is expensive to build and the thread rebuilds its rows
// on every streaming chunk, so keep one per locale.
const times = new Map<string, Intl.DateTimeFormat | null>();
const days = new Map<string, Intl.DateTimeFormat | null>();
const listDays = new Map<string, Intl.DateTimeFormat | null>();
const listYears = new Map<string, Intl.DateTimeFormat | null>();

function cached(
  store: Map<string, Intl.DateTimeFormat | null>,
  locale: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat | null {
  const hit = store.get(locale);
  if (hit !== undefined) return hit;
  let made: Intl.DateTimeFormat | null = null;
  try {
    made = new Intl.DateTimeFormat(locale, options);
  } catch {
    made = null;
  }
  store.set(locale, made);
  return made;
}

/** A pause this long starts a new moment. Anything shorter stays in the last one. */
export const CLOCK_GAP_MS = 60 * 60 * 1000;

/** Wall clock for a message, in the reader's locale. */
export function clockLabel(ts: number, locale: string): string {
  if (!ts) return "";
  return cached(times, locale, { hour: "numeric", minute: "2-digit" })?.format(new Date(ts)) ?? "";
}

function dayLabel(ts: number, locale: string): string {
  return cached(days, locale, { month: "long", day: "numeric" })?.format(new Date(ts)) ?? "";
}

/**
 * The clock a hover shows for one message. Today is the time. An older
 * message keeps the date, so Tuesday's 3:24 does not look like today's.
 */
/** Date and time kept apart so a narrow chip can shorten the date only. */
export function messageClockParts(
  ts: number,
  locale: string,
  now = Date.now(),
): { day: string; time: string } {
  if (!ts) return { day: "", time: "" };
  const time = clockLabel(ts, locale);
  if (!time) return { day: "", time: "" };
  if (new Date(ts).toDateString() === new Date(now).toDateString()) {
    return { day: "", time };
  }
  return { day: dayLabel(ts, locale), time };
}

export function messageClock(ts: number, locale: string, now = Date.now()): string {
  const { day, time } = messageClockParts(ts, locale, now);
  if (!time) return "";
  return day ? `${day} ${time}` : time;
}

/**
 * One centered stamp per quiet stretch. The first moment is stamped, and so
 * is the next row once an hour has passed since the previous one. A run of
 * messages inside that hour reads as one moment.
 *
 * The gap is measured from the previous non-zero stamp. A `0` is not a
 * moment and does not move the hour.
 *
 * A stamp from another day carries the date. The clock alone would make
 * Tuesday's 3:24 PM look like the 3:24 PM already on screen from today.
 */
export function clockLabels(
  stamps: readonly number[],
  locale: string,
  now = Date.now(),
): string[] {
  let prev = 0;
  return stamps.map((ts) => {
    if (!ts) return "";
    const gap = prev ? ts - prev : CLOCK_GAP_MS;
    if (ts >= prev) prev = ts;
    if (gap < CLOCK_GAP_MS) return "";
    return messageClock(ts, locale, now);
  });
}

/**
 * What a chat row in the rail shows. Today is the wall clock. An older row is
 * only the date: the rail is too narrow for the thread's date-and-time stamp.
 * A row from another year keeps the year.
 */
export function listStamp(ts: number, locale: string, now = Date.now()): string {
  if (!ts) return "";
  const at = new Date(ts);
  const today = new Date(now);
  if (
    at.getFullYear() === today.getFullYear() &&
    at.getMonth() === today.getMonth() &&
    at.getDate() === today.getDate()
  ) {
    return clockLabel(ts, locale);
  }
  const withYear = at.getFullYear() !== today.getFullYear();
  return (
    cached(
      withYear ? listYears : listDays,
      locale,
      withYear
        ? { year: "numeric", month: "numeric", day: "numeric" }
        : { month: "numeric", day: "numeric" },
    )?.format(at) ?? ""
  );
}
