import { isWeb } from "./web";

/**
 * The user's home folder, for `~/…` paths a bot writes. The desktop window
 * reads it once at start; Tauri's file URLs do not know `~`. On a phone the
 * laptop's server expands `~` itself, so it stays as written there.
 */
let home: string | null = null;

export function setHomeDir(dir: string | null) {
  home = dir ? dir.replace(/\/+$/, "") : null;
}

/** `~` and `~/…` under the home folder; anything else, or no home known yet, as is. */
export function expandHome(path: string): string {
  if (!home) return path;
  if (path === "~") return home;
  if (path.startsWith("~/")) return home + path.slice(1);
  return path;
}

export async function loadHomeDir(
  read: () => Promise<string> = async () => (await import("@tauri-apps/api/path")).homeDir(),
): Promise<void> {
  if (isWeb()) return;
  try {
    setHomeDir(await read());
  } catch {
    /* A plain browser preview has no home to read. `~` stays as written. */
  }
}
