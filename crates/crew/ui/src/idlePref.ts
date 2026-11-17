const KEY = "crew.idleSummary";

/** Minutes of silence before an idle card. `0` is off. Nothing under 10. */
export type IdleEvery = 0 | 10 | 30 | 60;

/**
 * Missing or unknown values are 10 minutes, the default.
 * A stored value under 10 is not a choice, so it falls back too.
 */
export function idleFrom(stored: string | null): IdleEvery {
  if (stored === "off" || stored === "0") return 0;
  if (stored === "30") return 30;
  if (stored === "60") return 60;
  if (stored === "10") return 10;
  return 10;
}

export function loadIdleEvery(): IdleEvery {
  try {
    return idleFrom(localStorage.getItem(KEY));
  } catch {
    return 10;
  }
}

export function saveIdleEvery(every: IdleEvery) {
  try {
    localStorage.setItem(KEY, every === 0 ? "off" : String(every));
  } catch {
    /* private mode */
  }
}
