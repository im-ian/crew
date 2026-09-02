import { describe, expect, it } from "vitest";
import {
  UNGROUPED_ID,
  groupIdOf,
  moveItem,
  normalizeGroups,
  parseItemKey,
  pruneLayout,
  railOrder,
  toPersist,
  visibleUngroupedKeys,
} from "./groups";
import type { AgentInfo, ChannelInfo, Group } from "./types";

function agent(id: string, name = id): AgentInfo {
  return { id, name, status: "idle", cmd: ["cat"], cwd: "/tmp", routines: [] };
}
function channel(id: string, name = id): ChannelInfo {
  return { id, name, members: [] };
}
function group(id: string, items: string[], collapsed = false): Group {
  return { id, name: id, collapsed, items };
}

describe("parseItemKey", () => {
  it("round-trips the two kinds and rejects junk", () => {
    expect(parseItemKey("agent:a1")).toEqual({ kind: "agent", id: "a1" });
    expect(parseItemKey("channel:room")).toEqual({ kind: "channel", id: "room" });
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

  it("pulls the ungrouped bucket out of the saved list", () => {
    const { groups, ungrouped } = normalizeGroups([
      { id: "g1", name: "One", items: ["agent:a1"] },
      { id: UNGROUPED_ID, name: "", items: ["channel:room", "channel:room"] },
    ]);
    expect(groups.map((g) => g.id)).toEqual(["g1"]);
    expect(ungrouped).toEqual(["channel:room"]);
  });

  it("gives an empty layout for anything that is not a list", () => {
    expect(normalizeGroups(null)).toEqual({ groups: [], ungrouped: [] });
    expect(normalizeGroups({})).toEqual({ groups: [], ungrouped: [] });
  });

  it("survives a save/load round trip", () => {
    const layout = {
      groups: [group("g1", ["agent:a1"])],
      ungrouped: ["channel:room"],
    };
    expect(normalizeGroups(toPersist(layout))).toEqual(layout);
  });

  it("omits the bucket when nothing is ungrouped", () => {
    expect(toPersist({ groups: [group("g1", [])], ungrouped: [] })).toHaveLength(1);
  });
});

describe("moveItem", () => {
  const layout = {
    groups: [group("g1", ["agent:a1", "agent:a2"]), group("g2", [])],
    ungrouped: ["channel:room"],
  };

  it("drops an item before the key it was dropped on", () => {
    const next = moveItem(layout, "channel:room", "g1", "agent:a2", ["channel:room"]);
    expect(next.groups[0].items).toEqual(["agent:a1", "channel:room", "agent:a2"]);
    expect(next.ungrouped).toEqual([]);
  });

  it("appends when it was dropped on the group itself", () => {
    const next = moveItem(layout, "channel:room", "g2", null, ["channel:room"]);
    expect(next.groups[1].items).toEqual(["channel:room"]);
  });

  it("takes an item out of its group when dropped outside", () => {
    const next = moveItem(layout, "agent:a1", null, "channel:room", ["channel:room"]);
    expect(next.groups[0].items).toEqual(["agent:a2"]);
    expect(next.ungrouped).toEqual(["agent:a1", "channel:room"]);
  });

  it("refuses a bad key, a self drop, or a group that is gone", () => {
    expect(moveItem(layout, "junk", "g1", null, [])).toBe(layout);
    expect(moveItem(layout, "agent:a1", "g1", "agent:a1", [])).toBe(layout);
    expect(moveItem(layout, "agent:a1", "missing", null, [])).toBe(layout);
  });
});

describe("railOrder", () => {
  const agents = [agent("a1"), agent("a2")];
  const channels = [channel("room")];

  it("walks groups first, then the ungrouped rest", () => {
    const order = railOrder(
      [group("g1", ["agent:a2"])],
      ["channel:room"],
      agents,
      channels,
    );
    expect(order).toEqual([
      { kind: "agent", id: "a2" },
      { kind: "channel", id: "room" },
      { kind: "agent", id: "a1" },
    ]);
  });

  it("skips the children of a collapsed group without listing them again", () => {
    const order = railOrder([group("g1", ["agent:a2"], true)], [], agents, channels);
    expect(order.some((o) => o.id === "a2")).toBe(false);
  });

  it("ignores items whose bot or channel is gone", () => {
    const order = railOrder([group("g1", ["agent:ghost"])], [], agents, channels);
    expect(order.map((o) => o.id)).not.toContain("ghost");
  });
});

describe("visibleUngroupedKeys", () => {
  it("keeps the saved order, then sorts newcomers by name", () => {
    const agents = [agent("a1", "나비"), agent("a2", "가람"), agent("a3", "다올")];
    const keys = visibleUngroupedKeys([], ["agent:a3"], agents, []);
    expect(keys).toEqual(["agent:a3", "agent:a2", "agent:a1"]);
  });

  it("leaves out whatever already sits in a group", () => {
    const agents = [agent("a1"), agent("a2")];
    expect(visibleUngroupedKeys([group("g1", ["agent:a1"])], [], agents, [])).toEqual([
      "agent:a2",
    ]);
  });
});

describe("pruneLayout and groupIdOf", () => {
  it("forgets rows for bots that no longer exist", () => {
    const pruned = pruneLayout(
      { groups: [group("g1", ["agent:a1", "agent:ghost"])], ungrouped: ["channel:gone"] },
      [agent("a1")],
      [],
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
