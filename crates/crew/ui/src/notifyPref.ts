import { api } from "./api";
import { getPairState, isWeb, subscribePair } from "./web";

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

/**
 * What the daemon's alerts are set to. The daemon's files are the value: the
 * window and a paired phone both read it when they open and change it with the
 * two switches, never writing what they remember. What this file keeps in
 * `localStorage` is only a copy of the last thing read, for the page's own
 * banner check, which cannot wait for a read.
 */
export type NotifyPrefs = { enabled: boolean; leadOnly: boolean };

type Read = () => Promise<NotifyPrefs>;
type Write = (on: boolean) => Promise<unknown>;

let current: NotifyPrefs = { enabled: loadNotify(), leadOnly: loadLeadOnlyNotify() };
const listeners = new Set<() => void>();

export function getNotifyPrefs(): NotifyPrefs {
  return current;
}

export function subscribeNotifyPrefs(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function adopt(next: NotifyPrefs) {
  if (next.enabled === current.enabled && next.leadOnly === current.leadOnly) return;
  current = next;
  saveNotify(next.enabled);
  saveLeadOnlyNotify(next.leadOnly);
  for (const fn of listeners) fn();
}

/** Read the daemon's switches and show them. A failed read leaves what is shown. */
export async function refreshNotifyPrefs(read: Read = () => api.getNotifyPrefs()): Promise<void> {
  try {
    const got = await read();
    adopt({ enabled: !!got.enabled, leadOnly: !!got.leadOnly });
  } catch {
    /* Not paired yet, or the laptop is away: read again when it is back. */
  }
}

/**
 * The user moved a switch: show it, tell the daemon, and take it back if the
 * daemon did not take it, so the screen never claims what the daemon lacks.
 */
async function change(
  key: keyof NotifyPrefs,
  on: boolean,
  write: Write,
): Promise<boolean> {
  const before = current;
  adopt({ ...current, [key]: on });
  try {
    await write(on);
    return true;
  } catch {
    adopt(before);
    return false;
  }
}

export function changeNotify(on: boolean, write: Write = (v) => api.setNotifications(v)) {
  return change("enabled", on, write);
}

export function changeLeadOnlyNotify(on: boolean, write: Write = (v) => api.setLeadOnlyNotify(v)) {
  return change("leadOnly", on, write);
}

/** Read now, and again whenever the page comes back: the other device may have changed it. */
export function followNotifyPrefs(doc: Document = document) {
  // A phone can read only once it is paired.
  if (isWeb()) {
    subscribePair(() => {
      if (getPairState() === "paired") void refreshNotifyPrefs();
    });
  }
  void refreshNotifyPrefs();
  doc.addEventListener("visibilitychange", () => {
    if (doc.visibilityState === "visible") void refreshNotifyPrefs();
  });
}

/** For tests: the shown values from storage again, and no listeners. */
export function resetNotifyPrefs() {
  current = { enabled: loadNotify(), leadOnly: loadLeadOnlyNotify() };
  listeners.clear();
}
