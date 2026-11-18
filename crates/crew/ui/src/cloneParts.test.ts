import { describe, expect, it } from "vitest";
import { canCarryChat, cloneDefaults, partsOf } from "./cloneParts";

describe("cloneDefaults", () => {
  it("checks what a duplicate always took, and leaves the chat out", () => {
    expect(cloneDefaults()).toEqual({
      avatar: true,
      routines: true,
      memory: true,
      group: true,
      chat: false,
    });
  });
});

describe("canCarryChat", () => {
  it("is for a bot that chats, not a terminal", () => {
    expect(canCarryChat({ cmd: ["claude"] })).toBe(true);
    expect(canCarryChat({ cmd: ["/opt/homebrew/bin/grok", "--always-approve"] })).toBe(true);
    expect(canCarryChat({ cmd: ["my-tool"], headless: true })).toBe(true);
    expect(canCarryChat({ cmd: ["bash"] })).toBe(false);
    expect(canCarryChat({ cmd: [] })).toBe(false);
  });
});

describe("partsOf", () => {
  it("keeps the group out of what goes to the daemon", () => {
    const pick = { ...cloneDefaults(), memory: false, chat: true, group: false };
    expect(partsOf(pick, true)).toEqual({ avatar: true, routines: true, memory: false, chat: true });
  });

  it("does not ask a terminal for its chat", () => {
    expect(partsOf({ ...cloneDefaults(), chat: true }, false).chat).toBe(false);
  });
});
