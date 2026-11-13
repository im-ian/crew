import { describe, expect, it } from "vitest";
import {
  UNGROUPED_ID,
  focusedGroupId,
  groupIdOf,
  groupOrderChanges,
  moveGroup,
  moveItem,
  adoptNewGroups,
  folderName,
  normalizeGroups,
  parseItemKey,
  groupCwd,
  pruneLayout,
  firstOpenAgent,
  railOrder,
  setGroupFolder,
  setGroupLead,
  settleLeads,
  groupLead,
  toPersist,
  visibleUngroupedKeys,
} from "./groups";
import type { AgentInfo, Group } from "./types";

function agent(id: string, name = id): AgentInfo {
  return { id, name, status: "idle", cmd: ["cat"], cwd: "/tmp", routines: [] };
}
function group(id: string, items: string[], collapsed = false): Group {
  return { id, name: id, collapsed, items };
}

describe("parseItemKey", () => {
  it("round-trips an agent key and rejects a room key", () => {
    expect(parseItemKey("agent:a1")).toEqual({ kind: "agent", id: "a1" });
    expect(parseItemKey("channel:room")).toBeNull();
    expect(parseItemKey("agent:a:1")).toEqual({ kind: "agent", id: "a:1" });
    for (const bad of ["", "a1", "agent:", ":a1", "group:g1"]) {
      expect(parseItemKey(bad), bad).toBeNull();
    }
  });
});

describe("normalizeGroups", () => {
  it("drops malformed rows, duplicate ids, and unparseable keys", () => {
    const raw = [
      { id: "g1", name: "One", items: ["agent:a1", "agent:a1", "junk", 7] },
      { id: "g1", name: "Dupe", items: [] },
      { id: "", name: "No id", items: [] },
      { id: "g2", name: "  ", items: [] },
      "nope",
      null,
    ];
    const { groups } = normalizeGroups(raw);
    expect(groups.map((g) => g.id)).toEqual(["g1"]);
    expect(groups[0].items).toEqual(["agent:a1"]);
  });

  it("keeps a loose bot between folders", () => {
    const raw = [
      { id: UNGROUPED_ID, name: "", items: ["agent:a1"] },
      { id: "g1", name: "One", items: ["agent:a2"] },
      { id: UNGROUPED_ID, name: "", items: ["agent:a3"] },
    ];
    const layout = normalizeGroups(raw);
    expect(layout.order).toEqual(["agent:a1", "g1", "agent:a3"]);
    expect(layout.groups.map((g) => g.id)).toEqual(["g1"]);
    expect(normalizeGroups(toPersist(layout))).toEqual(layout);
  });

  it("pulls the ungrouped bucket out of the saved list", () => {
    const { groups, ungrouped } = normalizeGroups([
      { id: "g1", name: "One", items: ["agent:a1"] },
      { id: UNGROUPED_ID, name: "", items: ["channel:room", "agent:a2", "agent:a2"] },
    ]);
    expect(groups.map((g) => g.id)).toEqual(["g1"]);
    expect(ungrouped).toEqual(["agent:a2"]);
  });

  it("gives an empty layout for anything that is not a list", () => {
    expect(normalizeGroups(null)).toEqual({ groups: [], ungrouped: [] });
    expect(normalizeGroups({})).toEqual({ groups: [], ungrouped: [] });
  });

  it("survives a save/load round trip", () => {
    const layout = {
      groups: [group("g1", ["agent:a1"])],
      ungrouped: ["agent:a2"],
    };
    expect(normalizeGroups(toPersist(layout))).toEqual(layout);
  });

  it("omits the bucket when nothing is ungrouped", () => {
    expect(toPersist({ groups: [group("g1", [])], ungrouped: [] })).toHaveLength(1);
  });

  it("keeps a group folder across a save and drops a blank one", () => {
    const layout = {
      groups: [
        { id: "g1", name: "app", collapsed: false, items: ["agent:a1"], path: "/tmp/app" },
      ],
      ungrouped: [] as string[],
    };
    expect(normalizeGroups(toPersist(layout))).toEqual(layout);
    const blank = normalizeGroups([
      { id: "g1", name: "app", items: [], path: "  " },
    ]);
    expect(blank.groups[0].path).toBeUndefined();
  });
});

describe("folderName", () => {
  it("uses the last segment and ignores a trailing slash", () => {
    expect(folderName("/Users/a/crew")).toBe("crew");
    expect(folderName("/Users/a/crew/")).toBe("crew");
    expect(folderName("crew")).toBe("crew");
    expect(folderName("")).toBe("");
    expect(groupCwd({ path: " /tmp/app " })).toBe("/tmp/app");
    expect(groupCwd({ path: "  " })).toBeNull();
    expect(groupCwd(null)).toBeNull();
  });
});

describe("setGroupFolder", () => {
  const layout = {
    groups: [group("g1", ["agent:a1"]), group("g2", [])],
    ungrouped: ["agent:a2"],
  };

  it("gives one group a folder and takes it away with a blank one", () => {
    const set = setGroupFolder(layout, "g1", " /tmp/app ");
    expect(set.groups[0].path).toBe("/tmp/app");
    expect(set.groups[0].items).toEqual(["agent:a1"]);
    expect(set.groups[1].path).toBeUndefined();
    expect(set.ungrouped).toEqual(["agent:a2"]);
    const cleared = setGroupFolder(set, "g1", "  ");
    expect("path" in cleared.groups[0]).toBe(false);
    expect(cleared.groups[0]).toEqual(layout.groups[0]);
  });
});

describe("adoptNewGroups", () => {
  const local = {
    groups: [group("g1", ["agent:a1"], false)],
    ungrouped: ["agent:a2"],
  };

  it("takes a new folder and moves its bots out of the ones already open", () => {
    const next = adoptNewGroups(local, [
      { id: "g1", name: "renamed", items: ["agent:a1", "agent:a9"] },
      { id: "gnew", name: "작업", items: ["agent:a1", "agent:a2"] },
    ]);
    expect(next).toEqual({
      groups: [
        group("g1", []),
        { id: "gnew", name: "작업", collapsed: false, items: ["agent:a1", "agent:a2"] },
      ],
      ungrouped: [],
    });
  });

  it("leaves the open layout alone when the file has no new folder", () => {
    expect(
      adoptNewGroups(local, [{ id: "g1", name: "renamed", items: [] }]),
    ).toBeNull();
  });

  it("keeps a bot in the later new folder when two new folders name it", () => {
    const next = adoptNewGroups(
      { groups: [], ungrouped: [] },
      [
        { id: "g2", name: "먼저", items: ["agent:a1"] },
        { id: "g3", name: "나중", items: ["agent:a1"] },
      ],
    );
    expect(next?.groups.map((g) => [g.id, g.items])).toEqual([
      ["g2", []],
      ["g3", ["agent:a1"]],
    ]);
  });
});

describe("moveItem", () => {
  it("keeps the group folder when a bot moves in", () => {
    const layout = {
      groups: [{ id: "g1", name: "app", collapsed: false, items: [], path: "/tmp/app" }],
      ungrouped: ["agent:a1"],
    };
    const next = moveItem(layout, "agent:a1", "g1", null, ["agent:a1"]);
    expect(next.groups[0].path).toBe("/tmp/app");
    expect(next.groups[0].items).toEqual(["agent:a1"]);
    expect(next.ungrouped).toEqual([]);
  });
});

describe("moveItem", () => {
  const layout = {
    groups: [group("g1", ["agent:a1", "agent:a2"]), group("g2", [])],
    ungrouped: ["agent:a3"],
  };

  it("drops an item before the key it was dropped on", () => {
    const next = moveItem(layout, "agent:a3", "g1", "agent:a2", ["agent:a3"]);
    expect(next.groups[0].items).toEqual(["agent:a1", "agent:a3", "agent:a2"]);
    expect(next.ungrouped).toEqual([]);
  });

  it("appends when it was dropped on the group itself", () => {
    const next = moveItem(layout, "agent:a3", "g2", null, ["agent:a3"]);
    expect(next.groups[1].items).toEqual(["agent:a3"]);
  });

  it("takes an item out of its group when dropped outside", () => {
    const next = moveItem(layout, "agent:a1", null, "agent:a3", ["agent:a3"]);
    expect(next.groups[0].items).toEqual(["agent:a2"]);
    expect(next.ungrouped).toEqual(["agent:a1", "agent:a3"]);
  });

  it("refuses a bad key, a room key, a self drop, or a group that is gone", () => {
    expect(moveItem(layout, "junk", "g1", null, [])).toBe(layout);
    expect(moveItem(layout, "channel:room", "g1", null, [])).toBe(layout);
    expect(moveItem(layout, "agent:a1", "g1", "agent:a1", [])).toBe(layout);
    expect(moveItem(layout, "agent:a1", "missing", null, [])).toBe(layout);
  });
});

describe("moveGroup", () => {
  const layout = {
    groups: [group("g1", ["agent:a1"]), group("g2", []), group("g3", ["agent:a2"])],
    ungrouped: ["agent:a3"],
  };

  it("inserts a group before another and keeps its chats", () => {
    const next = moveGroup(layout, "g3", "g1");
    expect(next.groups.map((g) => g.id)).toEqual(["g3", "g1", "g2"]);
    expect(next.groups[0].items).toEqual(["agent:a2"]);
    expect(next.ungrouped).toEqual(["agent:a3"]);
  });

  it("moves a group under a loose bot when it is dropped at the bottom", () => {
    const next = moveGroup(layout, "g1", null);
    expect(next.groups.map((g) => g.id)).toEqual(["g2", "g3", "g1"]);
    expect(next.groups[2].items).toEqual(["agent:a1"]);
    expect(next.order).toEqual(["g2", "g3", "agent:a3", "g1"]);
  });

  it("puts a folder between loose bots and a loose bot between folders", () => {
    const betweenBots = moveGroup(layout, "g1", null);
    const parked = moveGroup(betweenBots, "g2", "g1");
    expect(parked.order).toEqual(["g3", "agent:a3", "g2", "g1"]);
    const botFirst = moveItem(layout, "agent:a3", null, "g1", ["agent:a3"]);
    expect(botFirst.order).toEqual(["agent:a3", "g1", "g2", "g3"]);
    expect(botFirst.ungrouped).toEqual(["agent:a3"]);
  });

  it("leaves the layout alone when the drop would not move it", () => {
    expect(moveGroup(layout, "g1", "g2")).toBe(layout);
    expect(moveGroup(layout, "g3", "agent:a3")).toBe(layout);
    expect(moveGroup(layout, "g2", "g2")).toBe(layout);
    expect(moveGroup(layout, "missing", "g1")).toBe(layout);
    expect(moveGroup(layout, "g1", "missing")).toBe(layout);
    expect(groupOrderChanges(["g1", "g2"], "g1", "g2")).toBe(false);
    expect(groupOrderChanges(["g1", "g2"], "g2", "g1")).toBe(true);
  });
});

describe("railOrder", () => {
  const agents = [agent("a1"), agent("a2"), agent("a3")];

  it("walks groups first, then the ungrouped rest", () => {
    const order = railOrder(
      [group("g1", ["agent:a2"])],
      ["agent:a3"],
      agents,
    );
    expect(order).toEqual([
      { kind: "agent", id: "a2" },
      { kind: "agent", id: "a3" },
      { kind: "agent", id: "a1" },
    ]);
  });

  it("skips the children of a collapsed group without listing them again", () => {
    const order = railOrder([group("g1", ["agent:a2"], true)], [], agents);
    expect(order.some((o) => o.id === "a2")).toBe(false);
  });

  it("ignores a missing bot and a leftover room key", () => {
    const order = railOrder(
      [group("g1", ["agent:ghost", "channel:room"])],
      [],
      agents,
    );
    expect(order.map((o) => o.id)).not.toContain("ghost");
    expect(order.map((o) => o.id)).not.toContain("room");
  });
});

describe("firstOpenAgent", () => {
  const agents = [agent("a1", "가"), agent("a2", "나"), agent("a3", "다")];

  it("opens a loose bot that was placed above the folders", () => {
    expect(
      firstOpenAgent(
        [group("g1", ["agent:a2"])],
        ["agent:a1"],
        agents,
        ["agent:a1", "g1"],
      ),
    ).toBe("a1");
  });

  it("is the first visible row, folders before loose bots", () => {
    expect(
      firstOpenAgent([group("g1", ["agent:a2"])], ["agent:a1"], agents),
    ).toBe("a2");
  });

  it("skips a collapsed folder and uses the next visible bot", () => {
    expect(
      firstOpenAgent(
        [group("g1", ["agent:a2"], true), group("g2", ["agent:a3"])],
        ["agent:a1"],
        agents,
      ),
    ).toBe("a3");
  });

  it("opens the first folder bot when every row is hidden", () => {
    expect(
      firstOpenAgent(
        [group("g1", ["agent:a2", "agent:a1"], true)],
        [],
        [agent("a1"), agent("a2")],
      ),
    ).toBe("a2");
  });

  it("ignores a bot that is not in the list", () => {
    expect(firstOpenAgent([group("g1", ["agent:ghost"])], [], agents)).toBe("a1");
  });
});

describe("visibleUngroupedKeys", () => {
  it("keeps the saved order, then sorts newcomers by name", () => {
    const agents = [agent("a1", "나비"), agent("a2", "가람"), agent("a3", "다올")];
    const keys = visibleUngroupedKeys([], ["agent:a3"], agents);
    expect(keys).toEqual(["agent:a3", "agent:a2", "agent:a1"]);
  });

  it("leaves out whatever already sits in a group", () => {
    const agents = [agent("a1"), agent("a2")];
    expect(visibleUngroupedKeys([group("g1", ["agent:a1"])], [], agents)).toEqual([
      "agent:a2",
    ]);
  });
});

describe("pruneLayout and groupIdOf", () => {
  it("forgets rows for bots that no longer exist", () => {
    const pruned = pruneLayout(
      {
        groups: [group("g1", ["agent:a1", "agent:ghost", "channel:room"])],
        ungrouped: ["channel:gone"],
      },
      [agent("a1")],
    );
    expect(pruned.groups[0].items).toEqual(["agent:a1"]);
    expect(pruned.ungrouped).toEqual([]);
  });

  it("reports which group holds an item", () => {
    const groups = [group("g1", ["agent:a1"])];
    expect(groupIdOf(groups, "agent", "a1")).toBe("g1");
    expect(groupIdOf(groups, "agent", "a2")).toBeNull();
  });
});

describe("group lead", () => {
  const agents = [agent("a1"), agent("a2"), agent("a3")];
  const lead = (g: Group, id: string): Group => ({ ...g, lead: id });

  it("keeps a lead that sits in its group and drops one that does not", () => {
    const { groups } = normalizeGroups([
      { id: "g1", name: "app", items: ["agent:a1", "agent:a2"], lead: "a2" },
      { id: "g2", name: "web", items: ["agent:a3"], lead: "a1" },
    ]);
    expect(groups[0].lead).toBe("a2");
    expect("lead" in groups[1]).toBe(false);
  });

  it("sets and clears a lead, and will not set one outside the group", () => {
    const layout = { groups: [group("g1", ["agent:a1", "agent:a2"])], ungrouped: [] };
    const set = setGroupLead(layout, "g1", "a2");
    expect(groupLead(set.groups[0])).toBe("a2");
    expect("lead" in setGroupLead(set, "g1", null).groups[0]).toBe(false);
    expect("lead" in setGroupLead(layout, "g1", "a3").groups[0]).toBe(false);
  });

  it("is let go when its bot moves out or is deleted", () => {
    const layout = { groups: [lead(group("g1", ["agent:a1", "agent:a2"]), "a1")], ungrouped: [] };
    const moved = settleLeads(moveItem(layout, "agent:a1", null, null, []));
    expect("lead" in moved.groups[0]).toBe(false);
    const pruned = pruneLayout(layout, [agent("a2")]);
    expect("lead" in pruned.groups[0]).toBe(false);
    expect(settleLeads(layout)).toBe(layout);
  });

  it("survives a save and a folder change", () => {
    const layout = {
      groups: [{ ...lead(group("g1", ["agent:a1"]), "a1"), path: "/tmp/app" }],
      ungrouped: [],
    };
    expect(toPersist(layout)[0].lead).toBe("a1");
    expect(setGroupFolder(layout, "g1", "").groups[0].lead).toBe("a1");
  });

  it("stays in the keyboard order of a collapsed group, alone", () => {
    const order = railOrder(
      [lead(group("g1", ["agent:a1", "agent:a2"], true), "a2")],
      [],
      agents,
    );
    expect(order.map((o) => o.id)).toEqual(["a2", "a3"]);
  });
});

describe("focusedGroupId", () => {
  const groups = [group("g1", ["agent:a1"]), group("g2", ["agent:a2"])];

  it("follows the open chat's group when nothing is pinned", () => {
    expect(focusedGroupId(groups, null, "agent", "a1")).toBe("g1");
  });

  it("is none for a loose bot or no chat", () => {
    expect(focusedGroupId(groups, null, "agent", "loose")).toBeNull();
    expect(focusedGroupId(groups, null, "agent", null)).toBeNull();
  });

  it("keeps a pinned group over the open chat's", () => {
    expect(focusedGroupId(groups, "g2", "agent", "a1")).toBe("g2");
    expect(focusedGroupId(groups, "g2", "agent", "loose")).toBe("g2");
  });

  it("drops a pin whose group is gone", () => {
    expect(focusedGroupId(groups, "gone", "agent", "a1")).toBe("g1");
  });
});
