import { afterEach, describe, expect, it, vi } from "vitest";
import { expandHome, loadHomeDir, setHomeDir } from "./homeDir";

afterEach(() => {
  setHomeDir(null);
  vi.unstubAllGlobals();
});

describe("homeDir", () => {
  it("leaves ~ as written until the home folder is known", () => {
    expect(expandHome("~/a.png")).toBe("~/a.png");
  });

  it("reads the home folder in the desktop window", async () => {
    await loadHomeDir(async () => "/Users/me/");
    expect(expandHome("~/a.png")).toBe("/Users/me/a.png");
  });

  it("does not on a phone, where the laptop's server expands ~", async () => {
    vi.stubGlobal("window", { __CREW_WEB__: true });
    const read = vi.fn(async () => "/Users/me");
    await loadHomeDir(read);
    expect(read).not.toHaveBeenCalled();
    expect(expandHome("~/a.png")).toBe("~/a.png");
  });

  it("keeps ~ when the home folder cannot be read", async () => {
    await loadHomeDir(async () => {
      throw new Error("no tauri");
    });
    expect(expandHome("~/a.png")).toBe("~/a.png");
  });
});
