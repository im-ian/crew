import { describe, expect, it } from "vitest";
import { groupBots, ledGroup } from "./leadGroup";
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
