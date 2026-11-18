import { describe, expect, it } from "vitest";
import { minutesSeconds, phoneUrl, type MobileStatus } from "./mobileAccess";

const base: MobileStatus = { enabled: true, port: 47823, urls: [], tailnet: null, tailscale: true, devices: [] };

describe("mobile", () => {
  it("shows a tailnet address before loopback", () => {
    expect(phoneUrl({ ...base, urls: ["http://mac.ts.net:47823", "http://127.0.0.1:47823"] })).toBe("http://mac.ts.net:47823");
    expect(phoneUrl({ ...base, urls: ["http://127.0.0.1:47823"] })).toBeNull();
  });

  it("counts a code down", () => {
    expect(minutesSeconds(192)).toEqual({ m: 3, s: 12 });
    expect(minutesSeconds(-4)).toEqual({ m: 0, s: 0 });
  });
});
