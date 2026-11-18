import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(async () => "from tauri"),
  convertFileSrc: vi.fn((path: string) => `asset://localhost/${path}`),
}));
vi.mock("@tauri-apps/api/core", () => tauri);

import { fileSrc, invoke } from "./transport";
import {
  TOO_LARGE,
  UNPAIRED,
  UNREACHABLE,
  UPLOAD_LIMIT,
  checkSession,
  deviceName,
  getPairState,
  isWeb,
  pairCodeFromUrl,
  pairDevice,
  setPairState,
  webInvoke,
  uploadFailure,
  webUpload,
  withoutPairCode,
} from "./web";

type Call = { url: string; init: RequestInit };

/** A `fetch` that answers each call with `answer` and keeps what it was sent. */
function fakeFetch(answer: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return answer(call);
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  setPairState("unknown");
});

afterEach(() => {
  vi.unstubAllGlobals();
  tauri.invoke.mockClear();
});

describe("isWeb", () => {
  it("is off in the desktop window, which the server never marks", () => {
    expect(isWeb()).toBe(false);
    vi.stubGlobal("window", {});
    expect(isWeb()).toBe(false);
  });

  it("is on in the page the server marks", () => {
    vi.stubGlobal("window", { __CREW_WEB__: true });
    expect(isWeb()).toBe(true);
  });
});

describe("webInvoke", () => {
  it("posts the args as JSON to /api/invoke/<cmd> and reads the answer", async () => {
    const { fetch, calls } = fakeFetch(() => json(200, [{ id: "bot-1" }]));
    const got = await webInvoke("list_agents", { all: true }, fetch);
    expect(got).toEqual([{ id: "bot-1" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/invoke/list_agents");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.credentials).toBe("same-origin");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ all: true });
    expect(getPairState()).toBe("paired");
  });

  it("sends an empty object when the command takes no args", async () => {
    const { fetch, calls } = fakeFetch(() => json(200, null));
    expect(await webInvoke("daemon_ping", undefined, fetch)).toBeNull();
    expect(calls[0].init.body).toBe("{}");
  });

  it("reads an empty answer as null, as for a command with no return value", async () => {
    const { fetch } = fakeFetch(() => new Response("", { status: 200 }));
    expect(await webInvoke("set_groups", {}, fetch)).toBeNull();
  });

  it("rejects with the server's error text, as Tauri rejects with the command's", async () => {
    const { fetch } = fakeFetch(() => json(500, { error: "no such agent: x" }));
    await expect(webInvoke("stop_agent", { id: "x" }, fetch)).rejects.toBe("no such agent: x");
  });

  it("rejects with the status when the server says nothing", async () => {
    const { fetch } = fakeFetch(() => new Response("oops", { status: 502 }));
    await expect(webInvoke("list_agents", {}, fetch)).rejects.toBe("HTTP 502");
  });

  it("marks the device unpaired on 401, which brings back the code form", async () => {
    setPairState("paired");
    const { fetch } = fakeFetch(() => json(401, { error: "pair first" }));
    await expect(webInvoke("list_agents", {}, fetch)).rejects.toThrow(UNPAIRED);
    expect(getPairState()).toBe("unpaired");
  });

  it("reads a network failure as the laptop being gone", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("Load failed");
    }) as unknown as typeof globalThis.fetch;
    await expect(webInvoke("daemon_ping", {}, fetch)).rejects.toThrow(UNREACHABLE);
    expect(getPairState()).toBe("unknown");
  });

  it("answers the Mac window's own commands on the phone without a call", async () => {
    const open = vi.fn();
    vi.stubGlobal("window", { open });
    const { fetch, calls } = fakeFetch(() => json(200, null));
    expect(await webInvoke("pick_folder", {}, fetch)).toBeNull();
    expect(await webInvoke("list_nerd_fonts", {}, fetch)).toEqual([]);
    await webInvoke("set_dock_badge", { count: 3 }, fetch);
    // The phone's defaults must not overwrite the laptop's settings.
    await webInvoke("set_locale", { locale: "en" }, fetch);
    await webInvoke("set_user_name", { name: "" }, fetch);
    await webInvoke("open_url", { url: "https://example.com" }, fetch);
    expect(open).toHaveBeenCalledWith("https://example.com", "_blank", "noopener");
    await webInvoke("open_path", { path: "/Users/me/a b.png" }, fetch);
    expect(open).toHaveBeenLastCalledWith("/api/file?path=%2FUsers%2Fme%2Fa%20b.png", "_blank", "noopener");
    expect(calls).toHaveLength(0);
  });
});

describe("transport", () => {
  it("goes to Tauri in the desktop window", async () => {
    expect(await invoke("daemon_ping")).toBe("from tauri");
    expect(tauri.invoke.mock.calls).toEqual([["daemon_ping"]]);
    expect(fileSrc("/tmp/a.png")).toBe("asset://localhost//tmp/a.png");
  });

  it("goes over HTTP in the page the server marks", async () => {
    vi.stubGlobal("window", { __CREW_WEB__: true });
    const { fetch, calls } = fakeFetch(() => json(200, "pong"));
    vi.stubGlobal("fetch", fetch);
    expect(await invoke("daemon_ping")).toBe("pong");
    expect(calls[0].url).toBe("/api/invoke/daemon_ping");
    expect(tauri.invoke).not.toHaveBeenCalled();
    expect(fileSrc("/Users/me/up/a.png")).toBe("/api/file?path=%2FUsers%2Fme%2Fup%2Fa.png");
  });
});

describe("webUpload", () => {
  it("posts the bytes themselves under ?name= and returns the path on the laptop", async () => {
    const { fetch, calls } = fakeFetch(() => json(200, { path: "/crew/uploads/photo.jpg" }));
    const blob = new Blob(["jpg"]);
    const path = await webUpload(blob, "내 사진 1.jpg", fetch);
    expect(path).toBe("/crew/uploads/photo.jpg");
    expect(calls[0].url).toBe("/api/upload?name=%EB%82%B4%20%EC%82%AC%EC%A7%84%201.jpg");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.body).toBe(blob);
  });

  it("does not send a file over the limit, and reads 413 the same way", async () => {
    const { fetch, calls } = fakeFetch(() => json(413, { error: "too large" }));
    const big = { size: UPLOAD_LIMIT + 1 } as Blob;
    await expect(webUpload(big, "big.mov", fetch)).rejects.toThrow(TOO_LARGE);
    expect(calls).toHaveLength(0);
    await expect(webUpload(new Blob(["x"]), "x", fetch)).rejects.toThrow(TOO_LARGE);
  });

  it("marks the device unpaired on 401", async () => {
    const { fetch } = fakeFetch(() => json(401, {}));
    await expect(webUpload(new Blob(["x"]), "x", fetch)).rejects.toThrow(UNPAIRED);
    expect(getPairState()).toBe("unpaired");
  });

  it("rejects with the server's error text", async () => {
    const { fetch } = fakeFetch(() => json(500, { error: "disk full" }));
    await expect(webUpload(new Blob(["x"]), "x", fetch)).rejects.toBe("disk full");
  });
});

describe("uploadFailure", () => {
  it("names what the attach row tells the person", async () => {
    expect(uploadFailure(new Error(TOO_LARGE))).toBe("tooLarge");
    expect(uploadFailure(new Error(UNREACHABLE))).toBe("unreachable");
    expect(uploadFailure(new Error(UNPAIRED))).toBe("unpaired");
    expect(uploadFailure("disk full")).toEqual({ error: "disk full" });
    const offline = vi.fn(async () => {
      throw new TypeError("Load failed");
    }) as unknown as typeof globalThis.fetch;
    const err = await webUpload(new Blob(["x"]), "x", offline).catch((e) => e);
    expect(uploadFailure(err)).toBe("unreachable");
  });
});

describe("checkSession", () => {
  it("asks /api/session whether this device is paired", async () => {
    const ok = fakeFetch(() => json(200, { device: "d1" }));
    expect(await checkSession(ok.fetch)).toBe("paired");
    expect(ok.calls[0].url).toBe("/api/session");
    expect(ok.calls[0].init.method).toBe("GET");
    const no = fakeFetch(() => json(401, {}));
    expect(await checkSession(no.fetch)).toBe("unpaired");
  });

  it("leaves the state alone when the laptop does not answer", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("Load failed");
    }) as unknown as typeof globalThis.fetch;
    expect(await checkSession(fetch)).toBe("unreachable");
    expect(getPairState()).toBe("unknown");
  });
});

describe("pairDevice", () => {
  it("sends the trimmed code and counts the device paired", async () => {
    setPairState("unpaired");
    const { fetch, calls } = fakeFetch(() => json(200, {}));
    expect(await pairDevice("  AB12 ", fetch)).toBe("paired");
    expect(calls[0].url).toBe("/api/pair");
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ code: "AB12" });
    expect(getPairState()).toBe("paired");
  });

  it("calls a refused code wrong", async () => {
    for (const status of [400, 401, 403]) {
      const { fetch } = fakeFetch(() => json(status, { error: "bad code" }));
      expect(await pairDevice("0000", fetch)).toBe("wrong");
    }
  });

  it("tells a laptop that did not answer from a wrong code", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof globalThis.fetch;
    expect(await pairDevice("0000", fetch)).toBe("unreachable");
  });

  it("tells too many tries from a wrong code", async () => {
    const { fetch } = fakeFetch(() => json(429, { error: "too many tries" }));
    expect(await pairDevice("0000", fetch)).toBe("tooMany");
  });

  it("passes on any other error", async () => {
    const { fetch } = fakeFetch(() => json(500, { error: "router down" }));
    expect(await pairDevice("0000", fetch)).toEqual({ error: "router down" });
  });

  it("names the device for the laptop's list", () => {
    expect(deviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBe("iPhone");
    expect(deviceName("Mozilla/5.0 (Linux; Android 15)")).toBe("Android");
    expect(deviceName("Mozilla/5.0 (Macintosh)")).toBe("Browser");
  });
});

describe("the code in a QR address", () => {
  it("is read from ?pair=", () => {
    expect(pairCodeFromUrl("https://mac.ts.net:8443/?pair=AB12")).toBe("AB12");
    expect(pairCodeFromUrl("https://mac.ts.net:8443/")).toBeNull();
    expect(pairCodeFromUrl("https://mac.ts.net:8443/?pair=%20")).toBeNull();
  });

  it("is taken out of the address, and nothing else is", () => {
    expect(withoutPairCode("https://mac.ts.net/?pair=AB12")).toBe("/");
    expect(withoutPairCode("https://mac.ts.net/app/?x=1&pair=AB12#top")).toBe("/app/?x=1#top");
  });
});
