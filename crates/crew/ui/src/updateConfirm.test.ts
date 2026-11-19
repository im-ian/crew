import { describe, expect, it } from "vitest";
import { makeT } from "./i18n";
import { updateWarning } from "./components/UpdateConfirm";
import { botsAtWork } from "./updater";

describe("asking before an update", () => {
  it("counts bots working, waiting on the user, or watching background work", () => {
    expect(
      botsAtWork([
        { status: "working" },
        { status: "blocked" },
        { status: "idle", watch: [{ what: "CI" }] },
        { status: "idle", watch: [] },
        { status: "idle" },
        { status: "working", remote: "team" },
      ]),
    ).toBe(3);
    expect(botsAtWork([{ status: "idle" }])).toBe(0);
  });

  it("says how many and what happens to them", () => {
    const ko = updateWarning(makeT("ko"), 3);
    expect(ko).toContain("3개");
    expect(ko).toContain("백그라운드 작업은 다시 시작");
    expect(updateWarning(makeT("en"), 2)).toContain("2 bots");
  });
});
