/** Wall clock beside a message, in the reader's locale. */
export function clockLabel(ts: number, locale: string): string {
  if (!ts) return "";
  try {
    return new Intl.DateTimeFormat(locale, {
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(ts));
  } catch {
    return "";
  }
}

/**
 * One label per row, blank where it would repeat the last one drawn. A run of
 * messages inside a minute reads as one moment, so only its first row is
 * stamped.
 *
 * A row that shows no clock passes `0` and does not count as the last one
 * drawn — otherwise a note between two messages would swallow the stamp of
 * the minute it sits in.
 */
export function clockLabels(stamps: readonly number[], locale: string): string[] {
  let prev = "";
  return stamps.map((ts) => {
    if (!ts) return "";
    const label = clockLabel(ts, locale);
    if (!label || label === prev) return "";
    prev = label;
    return label;
  });
}
