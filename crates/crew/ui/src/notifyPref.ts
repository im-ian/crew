const KEY = "crew.notify";

/** Missing or anything other than "off" stays on, matching a first launch. */
export function notificationsEnabled(stored: string | null): boolean {
  return stored !== "off";
}

export function loadNotify(): boolean {
  try {
    return notificationsEnabled(localStorage.getItem(KEY));
  } catch {
    return true;
  }
}

export function saveNotify(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    /* private mode */
  }
}

const LEAD_ONLY_KEY = "crew.notify-lead-only";

/**
 * In a sidebar group with a lead, only the lead's finishes notify. Missing or
 * anything other than "on" stays off, so every bot notifies as before.
 */
export function leadOnlyNotifyOf(stored: string | null): boolean {
  return stored === "on";
}

export function loadLeadOnlyNotify(): boolean {
  try {
    return leadOnlyNotifyOf(localStorage.getItem(LEAD_ONLY_KEY));
  } catch {
    return false;
  }
}

export function saveLeadOnlyNotify(on: boolean) {
  try {
    localStorage.setItem(LEAD_ONLY_KEY, on ? "on" : "off");
  } catch {
    /* private mode */
  }
}
