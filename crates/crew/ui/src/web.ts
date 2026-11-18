/**
 * The same UI served over HTTP to a phone, not inside the Tauri window.
 * Every Tauri call the UI makes goes through `transport.ts`, which asks
 * `isWeb()` here. The server marks the page it serves with
 * `window.__CREW_WEB__ = true`; the desktop window never has it.
 */

declare global {
  interface Window {
    __CREW_WEB__?: boolean;
  }
}

export function isWeb(): boolean {
  return typeof window !== "undefined" && window.__CREW_WEB__ === true;
}

/** The laptop did not answer: asleep, off the tailnet, or Crew is closed. */
export const UNREACHABLE = "crew-web: the laptop did not answer";
/** This phone is not paired, or its pairing was removed on the laptop. */
export const UNPAIRED = "crew-web: this device is not paired";
/** The file is over what the laptop takes in one upload. */
export const TOO_LARGE = "crew-web: the file is too large";

/** What `/api/upload` takes in one file. */
export const UPLOAD_LIMIT = 100 * 1024 * 1024;

type Fetch = typeof fetch;

/** How long a call waits before the laptop counts as gone. */
const CALL_WAIT_MS = 60_000;
/** The ping decides the connection banner, so it gives up sooner. */
const PING_WAIT_MS = 10_000;

export type PairState = "unknown" | "paired" | "unpaired";

let pairState: PairState = "unknown";
const pairListeners = new Set<() => void>();

export function getPairState(): PairState {
  return pairState;
}

export function setPairState(next: PairState) {
  if (next === pairState) return;
  pairState = next;
  for (const fn of pairListeners) fn();
}

export function subscribePair(fn: () => void): () => void {
  pairListeners.add(fn);
  return () => pairListeners.delete(fn);
}

/** `/api/file?path=…`, for what `convertFileSrc` gives the desktop window. */
export function webFileSrc(path: string): string {
  return `/api/file?path=${encodeURIComponent(path)}`;
}

/**
 * Commands that act on the Mac's window rather than on Crew: the phone has
 * no dock badge, no folder dialog, and opens a link itself.
 */
const LOCAL: Record<string, (args: Record<string, unknown>) => unknown> = {
  // The laptop's window mirrors these settings to the daemon from its own
  // storage. A phone starts with defaults of its own, and mirroring them
  // would overwrite the laptop's choice the moment the page opened.
  set_locale: () => undefined,
  set_user_name: () => undefined,
  set_notifications: () => undefined,
  set_lead_only_notify: () => undefined,
  set_display_prefs: () => undefined,
  set_dock_badge: () => undefined,
  set_escape_layer: () => undefined,
  list_nerd_fonts: () => [],
  pick_folder: () => null,
  peek_pending_focus: () => null,
  take_pending_focus: () => null,
  open_url: ({ url }) => {
    window.open(String(url), "_blank", "noopener");
  },
  open_path: ({ path }) => {
    window.open(webFileSrc(String(path)), "_blank", "noopener");
  },
};

async function send(
  url: string,
  init: RequestInit,
  waitMs: number,
  fetchFn: Fetch,
): Promise<Response> {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), waitMs);
  try {
    return await fetchFn(url, { ...init, credentials: "same-origin", signal: stop.signal });
  } catch {
    // A network error and a timeout read the same to the person holding
    // the phone: the laptop is not there.
    throw new Error(UNREACHABLE);
  } finally {
    clearTimeout(timer);
  }
}

/** The server's `{ "error": "..." }`, or the status when it sent none. */
async function failure(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  if (body && typeof body === "object" && "error" in body) {
    return String((body as { error: unknown }).error);
  }
  return `HTTP ${res.status}`;
}

/**
 * Tauri's `invoke` over `POST /api/invoke/<cmd>`. A command error rejects
 * with the server's text, as Tauri rejects with the command's string, so
 * `errMsg` and every caller read it the same way.
 */
export async function webInvoke<T>(
  cmd: string,
  args: Record<string, unknown> = {},
  fetchFn: Fetch = fetch,
): Promise<T> {
  const local = LOCAL[cmd];
  if (local) return local(args) as T;
  const res = await send(
    `/api/invoke/${encodeURIComponent(cmd)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    },
    cmd === "daemon_ping" ? PING_WAIT_MS : CALL_WAIT_MS,
    fetchFn,
  );
  if (res.status === 401) {
    setPairState("unpaired");
    throw new Error(UNPAIRED);
  }
  if (!res.ok) throw await failure(res);
  setPairState("paired");
  // A command with no return value answers `null`, or nothing at all.
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

/**
 * Save a file the phone picked under the laptop's uploads, as the bytes
 * themselves. Its path there, the same shape `save_upload` gives.
 */
export async function webUpload(file: Blob, name: string, fetchFn: Fetch = fetch): Promise<string> {
  if (file.size > UPLOAD_LIMIT) throw new Error(TOO_LARGE);
  const res = await send(
    `/api/upload?name=${encodeURIComponent(name)}`,
    { method: "POST", headers: { "content-type": "application/octet-stream" }, body: file },
    CALL_WAIT_MS * 5,
    fetchFn,
  );
  if (res.status === 401) {
    setPairState("unpaired");
    throw new Error(UNPAIRED);
  }
  if (res.status === 413) throw new Error(TOO_LARGE);
  if (!res.ok) throw await failure(res);
  const body = (await res.json()) as { path?: unknown };
  if (typeof body?.path !== "string") throw new Error("upload answered without a path");
  return body.path;
}

export type UploadFailure = "tooLarge" | "unreachable" | "unpaired" | { error: string };

/** Why an upload failed, in the words the attach row shows. */
export function uploadFailure(err: unknown): UploadFailure {
  const text = err instanceof Error ? err.message : String(err);
  if (text === TOO_LARGE) return "tooLarge";
  if (text === UNREACHABLE) return "unreachable";
  if (text === UNPAIRED) return "unpaired";
  return { error: text };
}

/**
 * Whether this device is paired, from `GET /api/session`. A laptop that does
 * not answer leaves it as it was: the app shows the connection banner.
 */
export async function checkSession(fetchFn: Fetch = fetch): Promise<PairState | "unreachable"> {
  let res: Response;
  try {
    res = await send("/api/session", { method: "GET" }, PING_WAIT_MS, fetchFn);
  } catch {
    return "unreachable";
  }
  if (res.status === 401) setPairState("unpaired");
  else if (res.ok) setPairState("paired");
  return getPairState();
}

/** How the laptop's list of paired devices names this one. */
export function deviceName(userAgent: string): string {
  if (/iPhone/.test(userAgent)) return "iPhone";
  if (/iPad/.test(userAgent)) return "iPad";
  if (/Android/.test(userAgent)) return "Android";
  return "Browser";
}

export type PairResult = "paired" | "wrong" | "tooMany" | "unreachable" | { error: string };

/** Trade the code the laptop shows for this device's cookie. */
export async function pairDevice(code: string, fetchFn: Fetch = fetch): Promise<PairResult> {
  let res: Response;
  try {
    res = await send(
      "/api/pair",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: code.trim(),
          name: deviceName(typeof navigator === "undefined" ? "" : navigator.userAgent),
        }),
      },
      CALL_WAIT_MS,
      fetchFn,
    );
  } catch {
    return "unreachable";
  }
  if (res.ok) {
    setPairState("paired");
    return "paired";
  }
  if (res.status === 400 || res.status === 401 || res.status === 403) return "wrong";
  if (res.status === 429) return "tooMany";
  return { error: await failure(res) };
}

/** The QR opens `…/?pair=<code>`. */
export const PAIR_PARAM = "pair";

export function pairCodeFromUrl(href: string): string | null {
  try {
    const code = new URL(href).searchParams.get(PAIR_PARAM)?.trim();
    return code || null;
  } catch {
    return null;
  }
}

/** The address without the code, so it is not kept in history or a bookmark. */
export function withoutPairCode(href: string): string {
  const url = new URL(href);
  url.searchParams.delete(PAIR_PARAM);
  return url.pathname + url.search + url.hash;
}
