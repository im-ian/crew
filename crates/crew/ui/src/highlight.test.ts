import { describe, expect, it } from "vitest";
import { compileGrammarRegex, highlightLines, langFor } from "./highlight";

// The TextMate line-comment rule the JS/TS grammars share.
const COMMENT = "(^[\\t ]+)?((//)(?:\\s*((@)internal)(?=\\s|$))?)";
const SAMPLE = "const a = []; // see `x\nconst b = 2;";

describe("langFor", () => {
  it("reads the grammar off the name", () => {
    expect(langFor("/a/b/fontPref.ts")).toBe("typescript");
    expect(langFor("src/App.TSX")).toBe("tsx");
    expect(langFor("/x/Dockerfile")).toBe("docker");
    expect(langFor("notes.txt")).toBeNull();
    expect(langFor("LICENSE")).toBeNull();
  });
});

describe("compileGrammarRegex", () => {
  it("writes an optional leading ^ as a lookbehind, not a bare anchor", () => {
    const re = compileGrammarRegex(COMMENT);
    expect(re.source).not.toMatch(/^\(\^/);
    expect(re.source).toContain("(?<=");
    expect(re.exec("const a = []; // hi")?.index).toBe(14);
  });
});

describe("highlightLines", () => {
  it("colors a comment after code, and a backtick in it opens nothing", async () => {
    const lines = await highlightLines(SAMPLE, "typescript");
    expect(lines).toHaveLength(2);
    const comment = lines![0].find((t) => t.text.includes("//"));
    expect(comment?.text).toBe("// see `x");
    expect(comment?.dark).toBe("#6A737D");
    expect(lines![1].map((t) => t.text).join("")).toBe("const b = 2;");
    expect(lines![1][0]).toMatchObject({ text: "const", dark: "#F97583" });
  });
});
