import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: vi.fn() }));

import { leadOnlyNotifyOf, notificationsEnabled } from "./notifyPref";

describe("notificationsEnabled", () => {
  it("stays on unless the setting is off", () => {
    expect(notificationsEnabled(null)).toBe(true);
    expect(notificationsEnabled("on")).toBe(true);
    expect(notificationsEnabled("")).toBe(true);
    expect(notificationsEnabled("off")).toBe(false);
  });
});

describe("leadOnlyNotifyOf", () => {
  it("stays off unless the setting is on", () => {
    expect(leadOnlyNotifyOf(null)).toBe(false);
    expect(leadOnlyNotifyOf("")).toBe(false);
    expect(leadOnlyNotifyOf("off")).toBe(false);
    expect(leadOnlyNotifyOf("yes")).toBe(false);
    expect(leadOnlyNotifyOf("on")).toBe(true);
  });
});

describe("the alert switches follow the daemon", () => {
  const store = new Map<string, string>();

  async function fresh() {
    vi.resetModules();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    return import("./notifyPref");
  }

  beforeEach(() => store.clear());
  afterEach(() => vi.unstubAllGlobals());

  it("shows what the daemon holds over what this device remembered", async () => {
    // This device remembered lead-only as on; the daemon says it is off.
    store.set("crew.notify-lead-only", "on");
    store.set("crew.notify", "on");
    const m = await fresh();
    expect(m.getNotifyPrefs()).toEqual({ enabled: true, leadOnly: true });
    await m.refreshNotifyPrefs(async () => ({ enabled: true, leadOnly: false }));
    expect(m.getNotifyPrefs()).toEqual({ enabled: true, leadOnly: false });
    // The remembered copy follows, for the page's own banner check.
    expect(m.loadLeadOnlyNotify()).toBe(false);
    expect(m.loadNotify()).toBe(true);
  });

  it("reading writes nothing back, and a failed read leaves what is shown", async () => {
    const m = await fresh();
    const write = vi.fn(async () => undefined);
    await m.refreshNotifyPrefs(async () => ({ enabled: false, leadOnly: true }));
    expect(write).not.toHaveBeenCalled();
    await m.refreshNotifyPrefs(async () => {
      throw new Error("laptop away");
    });
    expect(m.getNotifyPrefs()).toEqual({ enabled: false, leadOnly: true });
  });

  it("tells the daemon only the switch that was moved, and tells listeners", async () => {
    const m = await fresh();
    await m.refreshNotifyPrefs(async () => ({ enabled: true, leadOnly: false }));
    const heard = vi.fn();
    m.subscribeNotifyPrefs(heard);
    const writeLead = vi.fn(async () => undefined);
    const writeNotify = vi.fn(async () => undefined);
    expect(await m.changeLeadOnlyNotify(true, writeLead)).toBe(true);
    expect(writeLead).toHaveBeenCalledWith(true);
    expect(writeNotify).not.toHaveBeenCalled();
    expect(m.getNotifyPrefs()).toEqual({ enabled: true, leadOnly: true });
    expect(heard).toHaveBeenCalledTimes(1);
    expect(await m.changeNotify(false, writeNotify)).toBe(true);
    expect(m.getNotifyPrefs()).toEqual({ enabled: false, leadOnly: true });
    expect(store.get("crew.notify")).toBe("off");
    expect(store.get("crew.notify-lead-only")).toBe("on");
  });

  it("takes a switch back when the daemon did not take it", async () => {
    const m = await fresh();
    await m.refreshNotifyPrefs(async () => ({ enabled: true, leadOnly: false }));
    const ok = await m.changeLeadOnlyNotify(true, async () => {
      throw new Error("laptop away");
    });
    expect(ok).toBe(false);
    expect(m.getNotifyPrefs()).toEqual({ enabled: true, leadOnly: false });
    expect(store.get("crew.notify-lead-only")).toBe("off");
  });
});
