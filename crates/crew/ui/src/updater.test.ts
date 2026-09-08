import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Update } from "@tauri-apps/plugin-updater";

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  getVersion: vi.fn(),
  relaunch: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-updater", () => ({ check: mocks.check }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: mocks.getVersion }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: mocks.relaunch }));

import {
  canonicalReleaseUrl,
  checkForUpdate,
  installUpdate,
  shouldNotify,
} from "./updater";

function fakeUpdate(overrides: Partial<Update> = {}): Update {
  return {
    version: "0.2.0",
    currentVersion: "0.1.0",
    body: "Bug fixes",
    downloadAndInstall: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as Update;
}

beforeEach(() => {
  mocks.check.mockReset();
  mocks.getVersion.mockReset();
  mocks.relaunch.mockReset();
  mocks.relaunch.mockResolvedValue(undefined);
});

describe("in-app updater", () => {
  it("builds the canonical GitHub release URL for a version", () => {
    expect(canonicalReleaseUrl("0.2.0")).toBe(
      "https://github.com/im-ian/crew/releases/tag/v0.2.0",
    );
  });

  it("returns the plugin update handle when a newer release exists", async () => {
    const update = fakeUpdate();
    mocks.check.mockResolvedValue(update);
    await expect(checkForUpdate()).resolves.toBe(update);

    mocks.check.mockResolvedValue(null);
    await expect(checkForUpdate()).resolves.toBeNull();
  });

  it("downloads, installs, then relaunches", async () => {
    const update = fakeUpdate();
    const onProgress = vi.fn();
    await installUpdate(update, onProgress);

    expect(update.downloadAndInstall).toHaveBeenCalledTimes(1);
    const progress = vi.mocked(update.downloadAndInstall).mock.calls[0]?.[0];
    expect(typeof progress).toBe("function");
    progress?.({ event: "Started", data: { contentLength: 10 } });
    expect(onProgress).toHaveBeenCalledWith({
      event: "Started",
      data: { contentLength: 10 },
    });
    expect(mocks.relaunch).toHaveBeenCalledTimes(1);
  });

  it("does not relaunch when downloadAndInstall fails", async () => {
    const update = fakeUpdate({
      downloadAndInstall: vi.fn().mockRejectedValue(new Error("signature failed")),
    });
    await expect(installUpdate(update)).rejects.toThrow(/signature failed/);
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });

  it("hides the banner after Later, then shows it again for a newer version", () => {
    const first = fakeUpdate({ version: "0.2.0" });
    expect(shouldNotify(first, null)).toBe(true);
    expect(shouldNotify(first, "0.2.0")).toBe(false);
    expect(shouldNotify(fakeUpdate({ version: "0.3.0" }), "0.2.0")).toBe(true);
    expect(shouldNotify(null, "0.2.0")).toBe(false);
  });
});
