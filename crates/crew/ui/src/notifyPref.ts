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
