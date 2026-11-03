import { describe, expect, it } from "vitest";
import { FIRST_DEFAULT, botDefaultOf, freeBotName } from "./botDefault";

describe("botDefaultOf", () => {
  it("starts on Grok when nothing is saved or it does not parse", () => {
    expect(botDefaultOf(null)).toEqual(FIRST_DEFAULT);
    expect(botDefaultOf("{")).toEqual(FIRST_DEFAULT);
    expect(botDefaultOf(JSON.stringify({ cli: "nope" }))).toEqual(FIRST_DEFAULT);
  });

  it("keeps a saved CLI, model, and think level", () => {
    expect(
      botDefaultOf(JSON.stringify({ cli: "claude", model: "opus", effort: "high", cmd: "x" })),
    ).toEqual({ cli: "claude", model: "opus", effort: "high", cmd: "" });
  });

  it("keeps a custom command, and drops a custom default without one", () => {
    expect(botDefaultOf(JSON.stringify({ cli: "custom", cmd: " my-ai --print " }))).toEqual({
      cli: "custom",
      model: "",
      effort: "",
      cmd: "my-ai --print",
    });
    expect(botDefaultOf(JSON.stringify({ cli: "custom", cmd: " " }))).toEqual(FIRST_DEFAULT);
  });
});

describe("freeBotName", () => {
  it("numbers a name that is taken", () => {
    expect(freeBotName("새 봇", [])).toBe("새 봇");
    expect(freeBotName("새 봇", ["새 봇"])).toBe("새 봇 2");
    expect(freeBotName("새 봇", ["새 봇", "새 봇 2", " 새 봇 3 "])).toBe("새 봇 4");
  });
});
