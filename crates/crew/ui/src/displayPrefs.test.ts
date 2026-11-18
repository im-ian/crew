import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: vi.fn() }));

import {
  getLaptopPrefs,
  loadLaptopPrefs,
  mirrorDisplayPrefs,
  type DisplayPrefs,
} from "./displayPrefs";

function fakeRoot() {
  const props = new Map<string, string>();
  const style = {
    setProperty: (k: string, v: string) => props.set(k, v),
    removeProperty: (k: string) => props.delete(k),
  };
  vi.stubGlobal("document", { documentElement: { style } });
  return props;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mirrorDisplayPrefs", () => {
  it("tells the daemon what the laptop's window shows", () => {
    vi.stubGlobal("localStorage", {
      getItem: (k: string) =>
        ({ "crew.font-family": "Pretendard", "crew.font-size": "large" })[k] ?? null,
    });
    const send = vi.fn(async () => undefined);
    mirrorDisplayPrefs(send);
    expect(send).toHaveBeenCalledWith({ font: "Pretendard", codeFont: "", fontSize: "large" });
  });

  it("sends nothing from a phone, which follows the laptop", () => {
    vi.stubGlobal("window", { __CREW_WEB__: true });
    const send = vi.fn(async () => undefined);
    mirrorDisplayPrefs(send);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("loadLaptopPrefs", () => {
  it("shows chat as the laptop does and keeps what it read", async () => {
    const props = fakeRoot();
    const laptop: DisplayPrefs = {
      font: "Pretendard",
      codeFont: "D2Coding",
      fontSize: "large",
      userName: "대호",
    };
    await loadLaptopPrefs(async () => laptop);
    expect(getLaptopPrefs()).toEqual(laptop);
    expect(props.get("--font-user")).toContain('"Pretendard"');
    expect(props.get("--mono-user")).toContain('"D2Coding"');
    expect(props.get("--chat-scale")).toBeDefined();
  });

  it("keeps the last read when the laptop is away", async () => {
    fakeRoot();
    const before = getLaptopPrefs();
    await loadLaptopPrefs(async () => {
      throw new Error("away");
    });
    expect(getLaptopPrefs()).toBe(before);
  });
});
