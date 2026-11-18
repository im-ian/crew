import { convertFileSrc, invoke as tauriInvoke } from "@tauri-apps/api/core";
import { isWeb, webFileSrc, webInvoke } from "./web";

/** Tauri's `invoke` in the desktop window, HTTP to the laptop on a phone. */
export function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isWeb()) return webInvoke<T>(cmd, args);
  // The same arguments Tauri was always called with: none when there are none.
  return args === undefined ? tauriInvoke<T>(cmd) : tauriInvoke<T>(cmd, args);
}

/** A URL the page can load a file on the Mac from. */
export function fileSrc(path: string): string {
  return isWeb() ? webFileSrc(path) : convertFileSrc(path);
}
