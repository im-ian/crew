import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(async () => "from tauri"),
  convertFileSrc: vi.fn((path: string) => `asset://localhost/${path}`),
}));
vi.mock("@tauri-apps/api/core", () => tauri);

import { fileSrc, invoke } from "./transport";
import {
  UNPAIRED,
  UNREACHABLE,
  getPairState,
  isWeb,
  pairCodeFromUrl,
  pairDevice,
  setPairState,
  webInvoke,
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
  it("posts the file as multipart field `file` and returns its path on the laptop", async () => {
    const { fetch, calls } = fakeFetch(() => json(200, { path: "/crew/uploads/photo.jpg" }));
    const path = await webUpload(new Blob(["jpg"]), "photo.jpg", fetch);
    expect(path).toBe("/crew/uploads/photo.jpg");
    expect(calls[0].url).toBe("/api/upload");
    const form = calls[0].init.body as FormData;
    const file = form.get("file") as File;
    expect(file.name).toBe("photo.jpg");
    expect(await file.text()).toBe("jpg");
  });

  it("marks the device unpaired on 401", async () => {
    const { fetch } = fakeFetch(() => json(401, {}));
    await expect(webUpload(new Blob(["x"]), "x", fetch)).rejects.toThrow(UNPAIRED);
    expect(getPairState()).toBe("unpaired");
  });

  it("rejects with the server's error text", async () => {
    const { fetch } = fakeFetch(() => json(413, { error: "file too large" }));
    await expect(webUpload(new Blob(["x"]), "x", fetch)).rejects.toBe("file too large");
  });
});

describe("pairDevice", () => {
  it("sends the trimmed code and counts the device paired", async () => {
    setPairState("unpaired");
    const { fetch, calls } = fakeFetch(() => json(200, {}));
    expect(await pairDevice("  AB12 ", fetch)).toBe("paired");
    expect(calls[0].url).toBe("/api/pair");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ code: "AB12" });
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

  it("passes on any other error", async () => {
    const { fetch } = fakeFetch(() => json(429, { error: "too many tries" }));
    expect(await pairDevice("0000", fetch)).toEqual({ error: "too many tries" });
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
