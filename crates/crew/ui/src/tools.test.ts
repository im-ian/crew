import { describe, expect, it } from "vitest";
import { sideOnlyPeer } from "./components/ChatThread";
import {
  dotsAfter,
  momentStamp,
  threadRows,
  toolNames,
  toolSummary,
} from "./tools";
import type { AgentInfo, ChatMessage } from "./types";

function msg(id: string, kind?: ChatMessage["kind"]): ChatMessage {
  return { id, role: "system", from: "Bash", text: "", ts: 1, kind };
}

function agent(id: string): AgentInfo {
  return { id, name: id, status: "idle", cmd: ["cat"], cwd: "/tmp", routines: [] };
}

const roster = [agent("jordy"), agent("chunsik")];

function note(id: string, from: string, kind: ChatMessage["kind"]): ChatMessage {
  return { id, role: "system", from, text: "hi", ts: 1, kind };
}

describe("threadRows", () => {
  it("folds a run of tool cards into one row", () => {
    const rows = threadRows([
      msg("a"),
      msg("t1", "tool"),
      msg("t2", "tool"),
      msg("t3", "tool"),
      msg("b"),
    ], []);
    expect(rows.map((r) => r.kind)).toEqual(["msg", "tools", "msg"]);
    expect(rows[1].kind === "tools" && rows[1].msgs.length).toBe(3);
  });

  it("keeps runs split by a message between them", () => {
    const rows = threadRows([msg("t1", "tool"), msg("a"), msg("t2", "tool")], []);
    expect(rows.map((r) => r.kind)).toEqual(["tools", "msg", "tools"]);
  });
});

describe("dotsAfter", () => {
  it("passes over what lands below a reply still being written", () => {
    const reply: ChatMessage = { id: "r", role: "assistant", from: "jordy", text: "working", ts: 2 };
    const list: ChatMessage[] = [
      { id: "p", role: "user", from: "user", text: "check this", ts: 1 },
      reply,
      note("h", "chunsik", "handoff"),
      note("n", "to:chunsik", "sent"),
      { id: "q", role: "user", from: "user", text: "how is it going?", ts: 3, queued: true },
    ];
    expect(dotsAfter(list)?.id).toBe("r");
  });

  it("stays on the prompt while nothing has been written yet", () => {
    const list: ChatMessage[] = [
      { id: "p", role: "user", from: "user", text: "check this", ts: 1 },
      { id: "q", role: "user", from: "user", text: "and this", ts: 2, queued: true },
    ];
    expect(dotsAfter(list)?.id).toBe("p");
  });
});

describe("toolNames", () => {
  const tool = (from: string): ChatMessage => ({
    id: from,
    role: "system",
    from,
    text: "",
    ts: 1,
    kind: "tool",
  });

  it("lists each tool once, in the order it was first used", () => {
    expect(toolNames(["Read", "Grep", "Read", "Edit"].map(tool))).toEqual({
      names: ["Read", "Grep", "Edit"],
      more: 0,
    });
  });

  it("counts what does not fit and shortens MCP names", () => {
    const run = ["Read", "mcp__plugin_pw__browser_click", "Edit", "Bash", "Grep"];
    expect(toolNames(run.map(tool))).toEqual({
      names: ["Read", "browser_click", "Edit"],
      more: 2,
    });
  });
});

describe("toolSummary", () => {
  it("picks the argument that says what ran", () => {
    expect(toolSummary('{"description":"Echo","command":"echo hi"}')).toBe("echo hi");
    expect(toolSummary('{"file_path":"/tmp/a.rs"}')).toBe("/tmp/a.rs");
  });

  it("falls back to the first string argument", () => {
    expect(toolSummary('{"whatever":"x"}')).toBe("x");
    expect(toolSummary('{"n":3}')).toBe("");
  });

  it("keeps one line and survives non-json", () => {
    expect(toolSummary("ls -al\nmore")).toBe("ls -al");
    expect(toolSummary("")).toBe("");
    expect(toolSummary('{"command":"' + "x".repeat(200) + '"}').length).toBe(72);
  });
});

describe("threadRows note runs", () => {
  it("folds a back-and-forth with one bot into a single row", () => {
    const rows = threadRows(
      [
        note("s", "to:jordy", "sent"),
        note("r", "jordy", "received"),
        note("h1", "jordy", "handoff"),
        note("h2", "jordy", "handoff"),
      ],
      roster,
    );
    expect(rows.map((r) => r.kind)).toEqual(["notes"]);
    expect(rows[0].kind === "notes" && rows[0].msgs.length).toBe(4);
    expect(rows[0].kind === "notes" && rows[0].peerId).toBe("jordy");
  });

  it("starts a new run when the other bot changes", () => {
    const rows = threadRows(
      [
        note("a", "jordy", "received"),
        note("b", "jordy", "handoff"),
        note("c", "chunsik", "received"),
        note("d", "chunsik", "handoff"),
      ],
      roster,
    );
    expect(rows.map((r) => (r.kind === "notes" ? r.peerId : r.kind))).toEqual([
      "jordy",
      "chunsik",
    ]);
  });

  it("keeps a lone note in a run so a reply does not remount it", () => {
    // The row type has to stay put when the second note lands, or React
    // unmounts the note the reader had open. The head is the same chip either way.
    const rows = threadRows([note("a", "jordy", "received")], roster);
    expect(rows.map((r) => r.kind)).toEqual(["notes"]);
    expect(rows[0].kind === "notes" && rows[0].msgs.length).toBe(1);
  });

  it("does not fold across a message between the notes", () => {
    const rows = threadRows(
      [
        note("a", "jordy", "received"),
        { id: "u", role: "user", from: "user", text: "hi", ts: 1 },
        note("b", "jordy", "handoff"),
      ],
      roster,
    );
    expect(rows.map((r) => r.kind)).toEqual(["notes", "msg", "notes"]);
  });

  it("keeps tool cards in their own run", () => {
    const rows = threadRows(
      [note("a", "jordy", "received"), msg("t1", "tool"), note("b", "jordy", "handoff")],
      roster,
    );
    expect(rows.map((r) => r.kind)).toEqual(["notes", "tools", "notes"]);
  });

  it("folds a room the same way", () => {
    const rows = threadRows(
      [note("a", "#ship", "received"), note("b", "#ship", "received")],
      roster,
    );
    expect(rows[0].kind === "notes" && rows[0].peerId).toBe("#ship");
  });

  // The guards below are what keep `threadRows` and `SystemOrIncoming`
  // agreeing on what a note is. Drop any one of them and a row would be
  // grouped as a note and drawn as something else — vanishing into the fold.
  it("leaves the human's own message alone", () => {
    const rows = threadRows([note("a", "user", "received")], roster);
    expect(rows.map((r) => r.kind)).toEqual(["msg"]);
  });

  it("leaves a notice the daemon wrote alone", () => {
    const rows = threadRows([note("a", "crew", "received")], roster);
    expect(rows.map((r) => r.kind)).toEqual(["msg"]);
  });

  it("leaves a routine row alone", () => {
    const rows = threadRows([note("a", "jordy", "routine")], roster);
    expect(rows.map((r) => r.kind)).toEqual(["msg"]);
  });
});

describe("momentStamp", () => {
  const hour = 60 * 60 * 1000;

  it("uses a balloon's own time", () => {
    const rows = threadRows(
      [
        { id: "u", role: "user", from: "user", text: "hi", ts: 10 },
        { id: "a", role: "assistant", from: "jordy", text: "ok", ts: 11 },
      ],
      roster,
    );
    expect(rows.map(momentStamp)).toEqual([10, 11]);
  });

  it("ignores a tool run even when the run outlasts the hour", () => {
    const rows = threadRows(
      [
        { id: "t1", role: "system", from: "Bash", text: "", ts: 10, kind: "tool" },
        {
          id: "t2",
          role: "system",
          from: "Bash",
          text: "",
          ts: 10 + hour,
          kind: "tool",
        },
      ],
      [],
    );
    expect(rows[0].kind).toBe("tools");
    expect(momentStamp(rows[0])).toBe(0);
  });

  it("ignores a note run", () => {
    const rows = threadRows(
      [note("a", "jordy", "received"), { ...note("b", "jordy", "handoff"), ts: 10 + hour }],
      roster,
    );
    expect(rows[0].kind).toBe("notes");
    expect(momentStamp(rows[0])).toBe(0);
  });

  it("stamps a tell from the human and skips a notice", () => {
    const tell = threadRows(
      [{ id: "t", role: "system", from: "user", text: "hi", ts: 7 }],
      roster,
    );
    const notice = threadRows(
      [{ id: "n", role: "system", from: "crew", text: "hi", ts: 7 }],
      roster,
    );
    const routine = threadRows([note("r", "jordy", "routine")], roster);
    expect(momentStamp(tell[0])).toBe(7);
    expect(momentStamp(notice[0])).toBe(0);
    expect(momentStamp(routine[0])).toBe(0);
  });
});

describe("threadRows replies another bot asked for", () => {
  const reply = (
    id: string,
    extra: Partial<ChatMessage> = {},
  ): ChatMessage => ({
    id,
    role: "assistant",
    from: "chunsik",
    text: "바위.",
    ts: 1,
    peer: "jordy",
    ...extra,
  });

  // jordy told chunsik, chunsik answered and told jordy back. The answer is
  // already in jordy's chat; here it reads beside the thread, not in it.
  it("folds the reply into the run with the bot that asked", () => {
    const rows = threadRows(
      [
        note("r", "jordy", "received"),
        reply("a"),
        note("s", "to:jordy", "sent"),
      ],
      roster,
    );
    expect(rows.map((r) => r.kind)).toEqual(["notes"]);
    expect(rows[0].kind === "notes" && rows[0].msgs.map((m) => m.id)).toEqual(
      ["r", "a", "s"],
    );
  });

  // Folded into the run, a lone tool card made a run of no messages: "0".
  it("keeps the turn's tool cards with the tool cards", () => {
    const rows = threadRows(
      [
        note("r", "jordy", "received"),
        { ...msg("t", "tool"), peer: "jordy" },
        reply("a"),
      ],
      roster,
    );
    expect(rows.map((r) => r.kind)).toEqual(["notes", "tools", "notes"]);
  });

  it("folds the reply even with no note beside it", () => {
    const rows = threadRows(
      [{ id: "u", role: "user", from: "user", text: "hi", ts: 1 }, reply("a")],
      roster,
    );
    expect(rows.map((r) => (r.kind === "notes" ? r.peerId : r.kind))).toEqual([
      "msg",
      "jordy",
    ]);
  });

  it("keeps a card waiting on the user in the thread", () => {
    const rows = threadRows(
      [
        note("r", "jordy", "received"),
        reply("a", { approval: "pending" }),
        note("s", "to:jordy", "sent"),
      ],
      roster,
    );
    expect(rows.map((r) => r.kind)).toEqual(["notes", "msg", "notes"]);
  });

  it("leaves the bot's reply to the user in the thread", () => {
    const rows = threadRows(
      [note("r", "jordy", "received"), reply("a", { peer: null })],
      roster,
    );
    expect(rows.map((r) => r.kind)).toEqual(["notes", "msg"]);
  });
});

describe("sideOnlyPeer", () => {
  const agents = [{ id: "alpha" }] as AgentInfo[];
  const note = (id: string, from: string): ChatMessage => ({
    id,
    role: "system",
    from,
    text: "rock",
    ts: 1,
    kind: "received",
  });

  it("opens the latest side chat, deleted bot or not, or the one a hit is in", () => {
    const list = [note("1", "alpha"), note("2", "bot-gone")];
    expect(sideOnlyPeer(list, agents)).toBe("bot-gone");
    expect(sideOnlyPeer(list, agents, "1")).toBe("alpha");
  });

  it("opens nothing once the chat has a conversation of its own", () => {
    const hello: ChatMessage = {
      id: "2",
      role: "user",
      from: "user",
      text: "hi",
      ts: 2,
    };
    expect(sideOnlyPeer([note("1", "alpha"), hello], agents)).toBe(null);
    expect(sideOnlyPeer([], agents)).toBe(null);
  });
});
