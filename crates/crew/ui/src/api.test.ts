import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, newestOnly, oneAtATime } from "./api";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

const face = {
  id: "bot-3",
  model: null,
  effort: null,
  unsetModel: false,
  unsetEffort: false,
  title: null,
  role: null,
  description: null,
  unsetTitle: false,
  unsetRole: false,
  unsetDescription: false,
  shape: "cloud",
  color: "#f60",
  cwd: null,
  unsetCwd: false,
};

describe("api.setAgent", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
  });

  it("passes the whole payload to set_agent", async () => {
    await api.setAgent(face);
    // Whole payload, not a spot check: `set_agent` rejects a missing key, and
    // a wrapper that hand-picked which ones to forward is what broke it.
    expect(mocks.invoke.mock.calls[0]).toEqual(["set_agent", face]);
  });

  it("carries a caller's unsetCwd rather than a default", async () => {
    await api.setAgent({ ...face, cwd: null, unsetCwd: true });
    const [cmd, args] = mocks.invoke.mock.calls[0];
    expect(cmd).toBe("set_agent");
    expect(args).toMatchObject({ unsetCwd: true });
  });
});

describe("api.setCwd", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
  });

  it("sets only the working folder", async () => {
    await api.setCwd("bot-3", "/tmp/app");
    expect(mocks.invoke.mock.calls[0]).toEqual([
      "set_agent",
      {
        id: "bot-3",
        model: null,
        effort: null,
        unsetModel: false,
        unsetEffort: false,
        title: null,
        description: null,
        role: null,
        unsetTitle: false,
        unsetDescription: false,
        unsetRole: false,
        cwd: "/tmp/app",
        unsetCwd: false,
      },
    ]);
  });
});

describe("api.listModels", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
  });

  it("keeps an installed CLI's list but asks again for a missing one", async () => {
    mocks.invoke.mockResolvedValue({ models: ["sonnet"], installed: true });
    await api.listModels("claude");
    await api.listModels("claude");
    expect(mocks.invoke).toHaveBeenCalledTimes(1);

    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue({ models: [], installed: false });
    await api.listModels("grok");
    await api.listModels("grok");
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });
});

describe("newestOnly", () => {
  it("drops an answer that lands after a later call's", async () => {
    const pending: Array<(v: string) => void> = [];
    const fetch = newestOnly(
      () => new Promise<string>((resolve) => pending.push(resolve)),
    );
    const older = fetch();
    const newer = fetch();
    pending[1]("new");
    expect(await newer).toBe("new");
    pending[0]("old");
    expect(await older).toBeNull();
  });

  it("keeps an older answer that lands first", async () => {
    const pending: Array<(v: string) => void> = [];
    const fetch = newestOnly(
      () => new Promise<string>((resolve) => pending.push(resolve)),
    );
    const older = fetch();
    const newer = fetch();
    pending[0]("old");
    expect(await older).toBe("old");
    pending[1]("new");
    expect(await newer).toBe("new");
  });
});

describe("oneAtATime", () => {
  it("skips a turn while the last one is still out", async () => {
    const poll = oneAtATime();
    let release = () => {};
    const work = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const first = poll(work);
    await poll(work);
    expect(work).toHaveBeenCalledTimes(1);
    release();
    await first;
    void poll(work);
    expect(work).toHaveBeenCalledTimes(2);
  });

  it("frees the next turn after one that failed", async () => {
    const poll = oneAtATime();
    await expect(poll(() => Promise.reject(new Error("down")))).rejects.toThrow(
      "down",
    );
    const work = vi.fn(() => Promise.resolve());
    await poll(work);
    expect(work).toHaveBeenCalledTimes(1);
  });
});
