import { useCallback, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  check,
  type DownloadEvent,
  type Update,
} from "@tauri-apps/plugin-updater";

export type { DownloadEvent, Update };

const UPDATE_OWNER = "im-ian";
const UPDATE_REPO = "crew";
const DISMISS_KEY = "crew.updater.dismissed";

/** Canonical public release page for a published Crew version. */
export function canonicalReleaseUrl(version: string): string {
  return `https://github.com/${UPDATE_OWNER}/${UPDATE_REPO}/releases/tag/v${version}`;
}

export async function checkForUpdate(): Promise<Update | null> {
  const update = await check();
  return update ?? null;
}

export async function getCurrentVersion(): Promise<string> {
  return getVersion();
}

/**
 * Download and install an update, then relaunch. macOS Tauri builds do
 * not restart on their own after `downloadAndInstall`.
 */
export async function installUpdate(
  update: Update,
  onProgress?: (event: DownloadEvent) => void,
): Promise<void> {
  await update.downloadAndInstall((event) => {
    onProgress?.(event);
  });
  await relaunch();
}

export function loadDismissedVersion(): string | null {
  try {
    return localStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

export function saveDismissedVersion(version: string) {
  try {
    localStorage.setItem(DISMISS_KEY, version);
  } catch {
    /* private mode */
  }
}

export function shouldNotify(
  available: Update | null,
  dismissedVersion: string | null,
): boolean {
  if (!available) return false;
  return dismissedVersion !== available.version;
}

export function useUpdater() {
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [available, setAvailable] = useState<Update | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(
    loadDismissedVersion,
  );
  const busyRef = useRef(false);

  const init = useCallback(async () => {
    try {
      setCurrentVersion(await getCurrentVersion());
    } catch (err) {
      console.warn("[updater] getCurrentVersion failed", err);
    }
  }, []);

  const checkNow = useCallback(async (manual = false) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    if (manual) setError(null);
    try {
      setAvailable(await checkForUpdate());
      if (manual) setError(null);
    } catch (err) {
      if (manual) {
        setError(err instanceof Error ? err.message : String(err));
      } else {
        console.warn("[updater] check failed", err);
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  const install = useCallback(async () => {
    if (!available || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await installUpdate(available, (event) => {
        if (event.event === "Started" || event.event === "Finished") {
          console.info("[updater]", event.event, event);
        }
      });
    } catch (err) {
      console.error("[updater] install failed", err);
      setError(err instanceof Error ? err.message : String(err));
      busyRef.current = false;
      setBusy(false);
    }
  }, [available]);

  const dismiss = useCallback(() => {
    if (!available) return;
    saveDismissedVersion(available.version);
    setDismissedVersion(available.version);
  }, [available]);

  const clearError = useCallback(() => setError(null), []);

  return {
    currentVersion,
    available,
    busy,
    error,
    shouldNotify: shouldNotify(available, dismissedVersion),
    init,
    check: checkNow,
    install,
    dismiss,
    clearError,
  };
}

export type UpdaterApi = ReturnType<typeof useUpdater>;
