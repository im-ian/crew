import { describe, expect, it } from "vitest";
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
