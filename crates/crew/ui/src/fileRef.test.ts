import { describe, expect, it } from "vitest";
import {
  codePathRef,
  fileRun,
  freshFileRow,
  opensInPanel,
  parseFileRef,
  resolveFilePath,
  sameFile,
} from "./fileRef";
import { fileErrorKey, fileLines, splitFilePath } from "./components/FileView";
import { threadRows } from "./tools";
import type { ChatMessage } from "./types";

const row = (id: string, kind?: ChatMessage["kind"], peer?: string): ChatMessage =>
  ({ id, role: "system", from: "dev", text: "/a/b.ts:3", ts: 0, kind, peer }) as ChatMessage;

describe("parseFileRef", () => {
  it("reads a trailing line, and a column after it", () => {
    expect(parseFileRef("/a/b.ts:12")).toEqual({ path: "/a/b.ts", line: 12 });
    expect(parseFileRef("/a/b.ts:12:4")).toEqual({ path: "/a/b.ts", line: 12 });
    expect(parseFileRef("/a/b.ts")).toEqual({ path: "/a/b.ts" });
  });
});

describe("codePathRef", () => {
  it("takes a path, a path at a line, or a code file's name", () => {
    expect(codePathRef("src/fontPref.ts:53")).toEqual({ path: "src/fontPref.ts", line: 53 });
    expect(codePathRef("crates/crew/src/files.rs")).toEqual({ path: "crates/crew/src/files.rs" });
    expect(codePathRef("~/x/Dockerfile")).toEqual({ path: "~/x/Dockerfile" });
    expect(codePathRef("config.rs")).toEqual({ path: "config.rs" });
  });

  it("leaves code that is not a file alone", () => {
    for (const code of ["npm test", "e.g.", "https://x.dev/a.ts", "@shikijs/core", "a.b.c()", "v1.2", "foo"]) {
      expect(codePathRef(code)).toBeNull();
    }
  });
});

describe("resolveFilePath", () => {
  it("reads a relative path in the bot's folder", () => {
    expect(resolveFilePath("src/a.ts", "/w/crew/")).toBe("/w/crew/src/a.ts");
    expect(resolveFilePath("./a.ts", "/w")).toBe("/w/a.ts");
    expect(resolveFilePath("~/a.ts")).toBe("~/a.ts");
    expect(resolveFilePath("src/a.ts")).toBeNull();
  });
});

describe("opensInPanel", () => {
  it("shows text and code, and leaves folders and documents to their apps", () => {
    expect(opensInPanel("/w/src/a.ts")).toBe(true);
    expect(opensInPanel("/w/notes.log")).toBe(true);
    expect(opensInPanel("/w/Makefile")).toBe(true);
    expect(opensInPanel("/w/src")).toBe(false);
    expect(opensInPanel("/w/src/")).toBe(false);
    expect(opensInPanel("/w/shot.png")).toBe(false);
    expect(opensInPanel("/w/spec.pdf")).toBe(false);
  });
});

describe("freshFileRow", () => {
  it("opens only a file row that came after the chat was loaded", () => {
    const list = [row("1", "file"), row("2"), row("3", "file")];
    expect(freshFileRow(undefined, list)).toBeNull();
    expect(freshFileRow(new Set(["1", "3"]), list)).toBeNull();
    expect(freshFileRow(new Set(["1"]), list)?.id).toBe("3");
  });
});

describe("files in the thread", () => {
  it("stay in the thread even in a turn another bot asked for", () => {
    const rows = threadRows([row("1", "file", "other")], []);
    expect(rows).toEqual([{ kind: "files", msgs: [expect.objectContaining({ id: "1" })] }]);
  });

  it("shown one after another are one card, past the tool calls between", () => {
    const said = { ...row("s"), role: "assistant", kind: undefined } as ChatMessage;
    const rows = threadRows([row("1", "file"), row("t1", "tool"), row("2", "file"), said, row("3", "file")], []);
    expect(rows.map((r) => r.kind)).toEqual(["files", "tools", "msg", "files"]);
    expect(rows[0].kind === "files" && rows[0].msgs.map((m) => m.id)).toEqual(["1", "2"]);
  });

  it("open together as tabs: the run around a row", () => {
    const said = { ...row("s"), role: "assistant", kind: undefined } as ChatMessage;
    const list = [row("1", "file"), row("t1", "tool"), row("2", "file"), said, row("3", "file")];
    expect(fileRun(list, "2").map((m) => m.id)).toEqual(["1", "2"]);
    expect(fileRun(list, "3").map((m) => m.id)).toEqual(["3"]);
    expect(fileRun(list, "nope")).toEqual([]);
  });

  it("are the same file at the same line", () => {
    expect(sameFile({ path: "/a" }, { path: "/a" })).toBe(true);
    expect(sameFile({ path: "/a", line: 2 }, { path: "/a" })).toBe(false);
    expect(sameFile(null, { path: "/a" })).toBe(false);
  });
});

describe("the file panel", () => {
  it("splits lines without a last empty one", () => {
    expect(fileLines("a\nb\n")).toEqual(["a", "b"]);
    expect(fileLines("")).toEqual([""]);
  });

  it("names the file and its folder, home as ~", () => {
    expect(splitFilePath("/Users/me/w/src/a.ts")).toEqual({ name: "a.ts", dir: "~/w/src" });
  });

  it("says why a file did not open", () => {
    expect(fileErrorKey("not found: /x")).toBe("file.notFound");
    expect(fileErrorKey("folder: /x")).toBe("file.folder");
    expect(fileErrorKey("binary: /x")).toBe("file.binary");
    expect(fileErrorKey(new Error("boom"))).toBe("file.failed");
  });
});
