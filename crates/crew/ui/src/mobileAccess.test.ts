import { describe, expect, it } from "vitest";
import { addressKind, minutesSeconds, phoneAddresses } from "./mobileAccess";

describe("mobile", () => {
  it("counts a code down", () => {
    expect(minutesSeconds(192)).toEqual({ m: 3, s: 12 });
    expect(minutesSeconds(-4)).toEqual({ m: 0, s: 0 });
  });
});

describe("phone addresses", () => {
  const dns = "http://mac.tail55bae5.ts.net:47823";
  const ip = "http://100.111.145.71:47823";
  const local = "http://127.0.0.1:47823";

  it("tells the kinds apart", () => {
    expect(addressKind(dns)).toBe("dns");
    expect(addressKind(ip)).toBe("ip");
    expect(addressKind(local)).toBe("local");
    expect(addressKind("http://[::1]:47823")).toBe("local");
    expect(addressKind("http://[fd7a:115c:a1e0::1]:47823")).toBe("ip");
  });

  it("puts the MagicDNS name first, then the IP, and this Mac's last", () => {
    const { main, others } = phoneAddresses([local, ip, dns]);
    expect(main).toEqual({ url: dns, kind: "dns", label: "mac.tail55bae5.ts.net:47823" });
    expect(others.map((a) => a.kind)).toEqual(["ip", "local"]);
  });

  it("falls back to the IP, and has none for this Mac alone", () => {
    expect(phoneAddresses([local, ip]).main?.url).toBe(ip);
    expect(phoneAddresses([local])).toEqual({ main: null, others: [{ url: local, kind: "local", label: "127.0.0.1:47823" }] });
    expect(phoneAddresses([])).toEqual({ main: null, others: [] });
  });
});
