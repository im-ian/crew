import { describe, expect, it } from "vitest";
import { threadRows, toolSummary } from "./tools";
import type { ChatMessage } from "./types";

function msg(id: string, kind?: ChatMessage["kind"]): ChatMessage {
  return { id, role: "system", from: "Bash", text: "", ts: 1, kind };
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
