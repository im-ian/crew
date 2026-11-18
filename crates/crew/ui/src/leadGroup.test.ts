import { describe, expect, it } from "vitest";
import {
  dropLeadKept,
  groupBots,
  ledGroup,
  shownLeadGroup,
  toggleLeadKept,
  type LeadKept,
} from "./leadGroup";
import type { AgentInfo, Group } from "./types";

function bot(id: string): AgentInfo {
  return { id, name: id, status: "idle", cmd: [], cwd: "", routines: [] };
}

const team: Group = {
  id: "g1",
  name: "Crew",
  collapsed: false,
  items: ["agent:b", "agent:lead", "agent:gone", "agent:a"],
  lead: "lead",
};
const other: Group = { id: "g2", name: "Other", collapsed: false, items: ["agent:x"] };

describe("ledGroup", () => {
  it("finds the group a bot leads", () => {
    expect(ledGroup([other, team], "lead")?.id).toBe("g1");
  });

  it("is null for a member that does not lead, or no bot", () => {
    expect(ledGroup([other, team], "a")).toBeNull();
    expect(ledGroup([other, team], "x")).toBeNull();
    expect(ledGroup([other, team], null)).toBeNull();
  });

  it("is null when the lead has left the group", () => {
    const left = { ...team, items: ["agent:a", "agent:b"] };
    expect(ledGroup([left], "lead")).toBeNull();
  });
});

describe("groupBots", () => {
  it("lists the group's bots in sidebar order, the lead with them", () => {
    const agents = [bot("a"), bot("b"), bot("lead"), bot("x")];
    expect(groupBots(team, agents).map((a) => a.id)).toEqual(["b", "lead", "a"]);
  });
});

describe("the group pane left open", () => {
  const other2: Group = {
    id: "g2",
    name: "Other",
    collapsed: false,
    items: ["agent:x", "agent:y"],
    lead: "x",
  };
  const groups = [team, other2];
  const open = (kept: LeadKept, id: string) => toggleLeadKept(kept, groups, id, false);

  it("is back when the lead's chat is open again after another bot", () => {
    const kept = open({}, "lead");
    expect(shownLeadGroup(kept, groups, "lead", false)?.id).toBe("g1");
    // Another bot, or a teammate picked in the pane: nothing beside it.
    expect(shownLeadGroup(kept, groups, "a", false)).toBeNull();
    expect(shownLeadGroup(kept, groups, "lead", false)?.id).toBe("g1");
  });

  it("closes only when the user closes it", () => {
    const kept = open({}, "lead");
    const closed = toggleLeadKept(kept, groups, "lead", true);
    expect(shownLeadGroup(closed, groups, "lead", false)).toBeNull();
    expect(shownLeadGroup(dropLeadKept(kept, "lead"), groups, "lead", false)).toBeNull();
  });

  it("is kept for each lead on its own", () => {
    const both = open(open({}, "lead"), "x");
    const one = dropLeadKept(both, "x");
    expect(shownLeadGroup(one, groups, "lead", false)?.id).toBe("g1");
    expect(shownLeadGroup(one, groups, "x", false)).toBeNull();
    expect(shownLeadGroup(both, groups, "x", false)?.id).toBe("g2");
  });

  it("gives way to a file or a side chat, and comes back after", () => {
    const kept = open({}, "lead");
    expect(shownLeadGroup(kept, groups, "lead", true)).toBeNull();
    expect(shownLeadGroup(kept, groups, "lead", false)?.id).toBe("g1");
  });

  it("opens again from the button while a file holds its place", () => {
    const kept = open({}, "lead");
    // Hidden behind a file, the button reads as not shown: it stays open.
    expect(toggleLeadKept(kept, groups, "lead", false)).toEqual(kept);
  });

  it("is ignored once the bot no longer leads that group", () => {
    const kept = open({}, "lead");
    const newLead = [{ ...team, lead: "a" }, other2];
    expect(shownLeadGroup(kept, newLead, "lead", false)).toBeNull();
    const left = [{ ...team, items: ["agent:a", "agent:b"] }, other2];
    expect(shownLeadGroup(kept, left, "lead", false)).toBeNull();
    const moved = [
      { ...team, items: ["agent:a"], lead: undefined },
      { ...other2, id: "g3", items: ["agent:lead"], lead: "lead" },
    ];
    expect(shownLeadGroup(kept, moved, "lead", false)).toBeNull();
  });

  it("does not open for a bot that leads nothing", () => {
    expect(open({}, "a")).toEqual({});
  });
});
