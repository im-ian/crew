import { describe, expect, it } from "vitest";
import type { ChatMessage, Role } from "./types";
import { peekMessages, peekPeerId, sentTarget } from "./peek";

const AGENTS = new Set(["alpha", "beta", "gamma"]);

function msg(
  role: Role,
  from: string,
  text: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id: extra.id || from + "-" + text.slice(0, 8),
    role,
    from,
    text,
    ts: extra.ts ?? 1,
    ...extra,
  };
}

describe("sentTarget", () => {
  it("reads the bot id off a to: from", () => {
    expect(sentTarget("to:beta")).toBe("beta");
    expect(sentTarget("beta")).toBe(null);
  });
});

describe("peekPeerId", () => {
  it("names the other bot on sent, received, and handoff rows", () => {
    expect(
      peekPeerId(msg("system", "to:beta", "hi", { kind: "sent" }), AGENTS),
    ).toBe("beta");
    expect(
      peekPeerId(msg("system", "beta", "hi", { kind: "received" }), AGENTS),
    ).toBe("beta");
    expect(
      peekPeerId(msg("system", "beta", "done", { kind: "handoff" }), AGENTS),
    ).toBe("beta");
  });

  it("infers sent/received when kind was not stored", () => {
    expect(peekPeerId(msg("system", "to:beta", "hi"), AGENTS)).toBe("beta");
    expect(peekPeerId(msg("system", "beta", "hi"), AGENTS)).toBe("beta");
  });

  it("skips channels, routines, and ordinary chat", () => {
    expect(
      peekPeerId(msg("system", "#room", "hi", { kind: "received" }), AGENTS),
    ).toBe(null);
    expect(peekPeerId(msg("system", "morning", "standup"), AGENTS)).toBe(null);
    expect(peekPeerId(msg("user", "user", "hello"), AGENTS)).toBe(null);
    expect(peekPeerId(msg("assistant", "alpha", "ok"), AGENTS)).toBe(null);
    expect(peekPeerId(msg("system", "to:nobody", "hi"), AGENTS)).toBe(null);
  });
});

describe("peekMessages", () => {
  it("rebuilds the initiator's sent + handoff as both speakers", () => {
    const rows = peekMessages(
      [
        msg("user", "user", "ask beta"),
        msg("assistant", "alpha", "I'll ask"),
        msg("system", "to:beta", "please review", { kind: "sent" }),
        msg("system", "beta", "looks good", { kind: "handoff" }),
        msg("assistant", "alpha", "Beta said looks good"),
      ],
      "beta",
      "alpha",
      AGENTS,
    );
    expect(rows.map((m) => [m.from, m.text])).toEqual([
      ["alpha", "please review"],
      ["beta", "looks good"],
    ]);
  });

  it("includes the callee's assistant reply after a received tell", () => {
    const rows = peekMessages(
      [
        msg("system", "alpha", "please review", { kind: "received" }),
        msg("system", "read_file", "path=foo", { kind: "tool" }),
        msg("assistant", "beta", "looks good"),
      ],
      "alpha",
      "beta",
      AGENTS,
    );
    expect(rows.map((m) => [m.from, m.text])).toEqual([
      ["alpha", "please review"],
      ["beta", "looks good"],
    ]);
  });

  it("stops following assistant turns after the user speaks", () => {
    const rows = peekMessages(
      [
        msg("system", "alpha", "please review", { kind: "received" }),
        msg("user", "user", "also fix the padding"),
        msg("assistant", "beta", "ok, padding next"),
      ],
      "alpha",
      "beta",
      AGENTS,
    );
    expect(rows.map((m) => [m.from, m.text])).toEqual([
      ["alpha", "please review"],
    ]);
  });

  it("keeps each peer's thread separate", () => {
    const rows = peekMessages(
      [
        msg("system", "to:beta", "review this", { kind: "sent" }),
        msg("system", "to:gamma", "ship it", { kind: "sent" }),
        msg("system", "beta", "nits only", { kind: "handoff" }),
        msg("system", "gamma", "shipped", { kind: "handoff" }),
      ],
      "beta",
      "alpha",
      AGENTS,
    );
    expect(rows.map((m) => [m.from, m.text])).toEqual([
      ["alpha", "review this"],
      ["beta", "nits only"],
    ]);
  });

  it("does not treat a routine or tool row as a bot transfer", () => {
    expect(
      peekPeerId(msg("system", "beta", "standup", { kind: "routine" }), AGENTS),
    ).toBe(null);
    expect(
      peekPeerId(msg("system", "beta", "path=foo", { kind: "tool" }), AGENTS),
    ).toBe(null);
    const rows = peekMessages(
      [
        msg("system", "alpha", "please review", { kind: "received" }),
        msg("system", "beta", "standup", { kind: "routine" }),
        msg("assistant", "beta", "looks good"),
      ],
      "alpha",
      "beta",
      AGENTS,
    );
    expect(rows.map((m) => [m.from, m.text])).toEqual([
      ["alpha", "please review"],
    ]);
  });

  it("drops envelope markers and a repeated echo of the tell", () => {
    const rows = peekMessages(
      [
        msg("system", "alpha", "[crew from:alpha]\nplease review", {
          kind: "received",
        }),
        msg("assistant", "beta", "[crew from:alpha]\nplease review"),
        msg("assistant", "beta", "on it"),
      ],
      "alpha",
      "beta",
      AGENTS,
    );
    expect(rows.map((m) => [m.from, m.text])).toEqual([
      ["alpha", "please review"],
      ["beta", "on it"],
    ]);
  });
});
