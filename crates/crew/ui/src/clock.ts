// `Intl.DateTimeFormat` is expensive to build and the thread rebuilds its rows
// on every streaming chunk, so keep one per locale.
const formatters = new Map<string, Intl.DateTimeFormat | null>();

function formatter(locale: string): Intl.DateTimeFormat | null {
  const hit = formatters.get(locale);
  if (hit !== undefined) return hit;
  let made: Intl.DateTimeFormat | null = null;
  try {
    made = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" });
  } catch {
    made = null;
  }
  formatters.set(locale, made);
  return made;
}

/** Wall clock beside a message, in the reader's locale. */
export function clockLabel(ts: number, locale: string): string {
  if (!ts) return "";
  return formatter(locale)?.format(new Date(ts)) ?? "";
}

/**
 * One label per row, blank where it would repeat the last one drawn. A run of
 * messages inside a minute reads as one moment, so only its first row is
 * stamped.
 *
 * Sameness is the day *and* the minute, not the rendered text: a transcript
 * outlives the day it was written, and 3:24 PM on Wednesday is not the 3:24 PM
 * above it from Tuesday.
 *
 * A row that shows no clock passes `0` and does not count as the last one
 * drawn — otherwise a note between two messages would swallow the stamp of
 * the minute it sits in.
 */
export function clockLabels(stamps: readonly number[], locale: string): string[] {
  let prev = "";
  return stamps.map((ts) => {
    const label = clockLabel(ts, locale);
    if (!label) return "";
    const at = new Date(ts);
    const key = `${at.toDateString()} ${label}`;
    if (key === prev) return "";
    prev = key;
    return label;
  });
}
