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

  it("includes the callee's reply to the turn the peer asked for", () => {
    const rows = peekMessages(
      [
        msg("system", "alpha", "please review", {
          kind: "received",
          peer: "alpha",
        }),
        msg("system", "read_file", "path=foo", { kind: "tool", peer: "alpha" }),
        msg("assistant", "beta", "looks good", { peer: "alpha" }),
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

  // The bot told the user who won, in its own chat. Shown beside the thread
  // too, it was the same answer twice.
  it("leaves out what the bot says to the user, even right after a note", () => {
    const rows = peekMessages(
      [
        msg("system", "alpha", "rock", { kind: "received" }),
        msg("assistant", "beta", "alpha won"),
        msg("user", "user", "again"),
        msg("assistant", "beta", "ok"),
      ],
      "alpha",
      "beta",
      AGENTS,
    );
    expect(rows.map((m) => [m.from, m.text])).toEqual([["alpha", "rock"]]);
  });

  it("keeps an answer that repeats the tell", () => {
    const rows = peekMessages(
      [
        msg("system", "alpha", "보", { kind: "received", peer: "alpha" }),
        msg("assistant", "beta", "보", { peer: "alpha" }),
      ],
      "alpha",
      "beta",
      AGENTS,
    );
    expect(rows.map((m) => [m.from, m.text])).toEqual([
      ["alpha", "보"],
      ["beta", "보"],
    ]);
  });

  // The bot answered and ran `crew tell` back. The peer got the tell alone,
  // and showing the reply too was the same throw twice.
  it("lets a tell back stand for the turn's reply", () => {
    const rows = peekMessages(
      [
        msg("system", "alpha", "가위", { kind: "received", peer: "alpha" }),
        msg("system", "run_terminal_command", "crew tell alpha", {
          kind: "tool",
          peer: "alpha",
        }),
        msg("assistant", "beta", "**바위.** 내가 이겼다.", { peer: "alpha" }),
        msg("system", "to:alpha", "바위. 내가 이겼다.", {
          kind: "sent",
          peer: "alpha",
        }),
        msg("system", "alpha", "또 해", { kind: "received", peer: "alpha" }),
        msg("assistant", "beta", "보", { peer: "alpha" }),
      ],
      "alpha",
      "beta",
      AGENTS,
    );
    expect(rows.map((m) => [m.from, m.text])).toEqual([
      ["alpha", "가위"],
      ["beta", "바위. 내가 이겼다."],
      ["alpha", "또 해"],
      ["beta", "보"],
    ]);
  });

  it("keeps a reply to another peer out", () => {
    const rows = peekMessages(
      [msg("assistant", "beta", "for gamma", { peer: "gamma" })],
      "alpha",
      "beta",
      AGENTS,
    );
    expect(rows).toEqual([]);
  });

  it("shows the user's words when they were typed in the peer's chat", () => {
    const rows = peekMessages(
      [
        msg("system", "user", "@beta say hi", { peer: "alpha" }),
        msg("assistant", "beta", "hi", { peer: "alpha" }),
      ],
      "alpha",
      "beta",
      AGENTS,
    );
    expect(rows.map((m) => [m.from, m.text])).toEqual([
      ["user", "@beta say hi"],
      ["beta", "hi"],
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
          peer: "alpha",
        }),
        msg("assistant", "beta", "[crew from:alpha]\nplease review", {
          peer: "alpha",
        }),
        msg("assistant", "beta", "on it", { peer: "alpha" }),
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
