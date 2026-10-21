import { describe, expect, it } from "vitest";
import { notificationsEnabled } from "./notifyPref";

describe("notificationsEnabled", () => {
  it("stays on unless the setting is off", () => {
    expect(notificationsEnabled(null)).toBe(true);
    expect(notificationsEnabled("on")).toBe(true);
    expect(notificationsEnabled("")).toBe(true);
    expect(notificationsEnabled("off")).toBe(false);
  });
});
