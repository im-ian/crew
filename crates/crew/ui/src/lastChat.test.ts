import { afterEach, describe, expect, it, vi } from "vitest";
import { loadLastChat, pickOpenAgent, saveLastChat } from "./lastChat";

const agents = [{ id: "a" }, { id: "b" }, { id: "c" }];

describe("pickOpenAgent", () => {
  it("keeps the chat already open", () => {
    expect(pickOpenAgent("b", "a", agents, "c", true)).toBe("b");
  });

  it("reopens the last chat when nothing is open yet", () => {
    expect(pickOpenAgent(null, "b", agents, "a", true)).toBe("b");
    expect(pickOpenAgent("gone", "b", agents, "a", true)).toBe("b");
  });

  it("uses the first bot when the last one is not in the list", () => {
    expect(pickOpenAgent(null, "gone", agents, "c", true)).toBe("c");
    expect(pickOpenAgent("gone", "also-gone", agents, "c", true)).toBe("c");
  });

  it("waits for the sidebar before guessing a first bot", () => {
    expect(pickOpenAgent(null, "gone", agents, "c", false)).toBeNull();
    expect(pickOpenAgent(null, null, agents, null, false)).toBeNull();
  });

  it("falls back to the list's first id when the sidebar has no row", () => {
    expect(pickOpenAgent(null, null, agents, null, true)).toBe("a");
    expect(pickOpenAgent(null, null, [], null, true)).toBeNull();
  });
});

describe("last chat storage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("remembers the id and ignores a blank one", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    });
    expect(loadLastChat()).toBeNull();
    saveLastChat("  bot-1  ");
    expect(loadLastChat()).toBe("bot-1");
    saveLastChat("   ");
    expect(loadLastChat()).toBe("bot-1");
  });

  it("treats a storage failure as no saved chat", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    expect(loadLastChat()).toBeNull();
    expect(() => saveLastChat("bot-1")).not.toThrow();
  });
});
