import { describe, expect, it } from "vitest";
import { threadRows, toolSummary } from "./tools";
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
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["msg", "tools", "msg"]);
    expect(rows[1].kind === "tools" && rows[1].msgs.length).toBe(3);
  });

  it("keeps runs split by a message between them", () => {
    const rows = threadRows([msg("t1", "tool"), msg("a"), msg("t2", "tool")]);
    expect(rows.map((r) => r.kind)).toEqual(["tools", "msg", "tools"]);
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
    expect(rows.map((r) => r.kind)).toEqual(["notes", "notes"]);
    expect(rows.map((r) => (r.kind === "notes" ? r.peerId : ""))).toEqual([
      "jordy",
      "chunsik",
    ]);
  });

  it("leaves a lone note as it was — it is already one line", () => {
    const rows = threadRows([note("a", "jordy", "received")], roster);
    expect(rows.map((r) => r.kind)).toEqual(["msg"]);
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
    expect(rows.map((r) => r.kind)).toEqual(["msg", "msg", "msg"]);
  });

  it("keeps tool cards in their own run", () => {
    const rows = threadRows(
      [note("a", "jordy", "received"), msg("t1", "tool"), note("b", "jordy", "handoff")],
      roster,
    );
    expect(rows.map((r) => r.kind)).toEqual(["msg", "tools", "msg"]);
  });
});
