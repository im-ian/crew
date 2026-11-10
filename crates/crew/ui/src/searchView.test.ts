import { describe, expect, it } from "vitest";
import { listedHits, matchRuns } from "./searchView";
import type { SearchHit } from "./types";

describe("matchRuns", () => {
  it("marks every match in any case", () => {
    expect(matchRuns("Retry 1초, then 1초 again", "1초")).toEqual([
      { text: "Retry ", match: false },
      { text: "1초", match: true },
      { text: ", then ", match: false },
      { text: "1초", match: true },
      { text: " again", match: false },
    ]);
    expect(matchRuns("Login bug", "login")).toEqual([
      { text: "Login", match: true },
      { text: " bug", match: false },
    ]);
  });

  it("leaves text without a match or a query whole", () => {
    expect(matchRuns("nothing here", "xyz")).toEqual([{ text: "nothing here", match: false }]);
    expect(matchRuns("plain", "  ")).toEqual([{ text: "plain", match: false }]);
  });
});

describe("listedHits", () => {
  it("drops bot hits, which the filtered rail already shows", () => {
    const hit = (kind: string): SearchHit => ({ kind, id: kind, title: "", snippet: "" });
    expect(listedHits([hit("bot"), hit("message"), hit("routine")]).map((h) => h.kind)).toEqual([
      "message",
      "routine",
    ]);
  });
});
