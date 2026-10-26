import { describe, expect, it } from "vitest";
import { deliveryFrom, sendSteers } from "./deliveryPref";

describe("deliveryFrom", () => {
  it("stays on the queue unless interrupt was saved", () => {
    expect(deliveryFrom(null)).toBe("queue");
    expect(deliveryFrom("")).toBe("queue");
    expect(deliveryFrom("queue")).toBe("queue");
    expect(deliveryFrom("nope")).toBe("queue");
    expect(deliveryFrom("interrupt")).toBe("interrupt");
  });
});

describe("sendSteers", () => {
  it("queues a normal send, and the shortcut still cuts in", () => {
    expect(sendSteers(false, "queue", true)).toBe(false);
    expect(sendSteers(true, "queue", true)).toBe(true);
  });

  it("cuts in on a normal send when interrupt is the default", () => {
    expect(sendSteers(false, "interrupt", true)).toBe(true);
    expect(sendSteers(true, "interrupt", true)).toBe(true);
  });

  it("does not steer once the bot is idle", () => {
    expect(sendSteers(true, "interrupt", false)).toBe(false);
    expect(sendSteers(false, "queue", false)).toBe(false);
  });
});
