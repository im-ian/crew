import { useSyncExternalStore } from "react";
import { api } from "./api";
import { applyCodeFont, applyFont, loadCodeFont, loadFont } from "./fontPref";
import { applyFontSize, fontSizeOf, loadFontSize } from "./fontSize";
import { getPairState, isWeb, subscribePair } from "./web";

/**
 * How the laptop's window shows chat. The window keeps these in its own
 * storage and mirrors them to the daemon; a paired phone reads them back, so
 * chat looks the same there. The phone does not write them.
 */
export type DisplayPrefs = {
  font: string;
  codeFont: string;
  fontSize: string;
  /** The name the user goes by (Settings › Display), when set. */
  userName?: string | null;
};

/** What the window shows now, from its own storage. */
export function currentDisplayPrefs(): DisplayPrefs {
  return { font: loadFont(), codeFont: loadCodeFont(), fontSize: loadFontSize() };
}

/** The laptop's window tells the daemon. A phone has nothing of its own to tell. */
export function mirrorDisplayPrefs(send = api.setDisplayPrefs) {
  if (isWeb()) return;
  void send(currentDisplayPrefs()).catch(() => {});
}

export function applyDisplayPrefs(prefs: DisplayPrefs) {
  applyFont(prefs.font);
  applyCodeFont(prefs.codeFont);
  applyFontSize(fontSizeOf(prefs.fontSize));
}

let laptop: DisplayPrefs | null = null;
const listeners = new Set<() => void>();

export function getLaptopPrefs(): DisplayPrefs | null {
  return laptop;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The laptop's settings on a phone; null on the laptop or until read. */
export function useLaptopPrefs(): DisplayPrefs | null {
  return useSyncExternalStore(subscribe, getLaptopPrefs, getLaptopPrefs);
}

/** Read the laptop's settings and show chat by them. */
export async function loadLaptopPrefs(read = api.getDisplayPrefs): Promise<void> {
  try {
    const next = await read();
    laptop = next;
    applyDisplayPrefs(next);
    for (const fn of listeners) fn();
  } catch {
    /* Not paired yet, or the laptop is away: read again when it is back. */
  }
}

/** On a phone: read once paired, and again whenever the page comes back. */
export function followLaptopPrefs(doc: Document = document) {
  if (!isWeb()) return;
  const readIfPaired = () => {
    if (getPairState() === "paired") void loadLaptopPrefs();
  };
  subscribePair(readIfPaired);
  doc.addEventListener("visibilitychange", () => {
    if (doc.visibilityState === "visible") readIfPaired();
  });
  readIfPaired();
}
