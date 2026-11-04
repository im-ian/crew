import { describe, expect, it } from "vitest";
import { UNGROUPED_ID } from "./groups";
import {
  aliasError,
  chatOrder,
  folderBefore,
  freeAlias,
  isOnline,
  joinErrorField,
  localAgents,
  moveRailSection,
  moveRemoteBot,
  moved,
  nameError,
  normalizeRemoteLayout,
  normalizeRemotes,
  placedReps,
  placeRep,
  portOk,
  railSections,
  remoteLabel,
  remoteSections,
  representing,
  routerUrl,
  slugAlias,
  toggled,
  unplaceRep,
} from "./remote";
import type { AgentInfo, Group, RemoteInfo } from "./types";

function local(id: string, name = id): AgentInfo {
  return { id, name, status: "idle", cmd: ["cat"], cwd: "/tmp", routines: [] };
}

function remote(alias: string, account: string, name: string, online = true): AgentInfo {
  return {
    id: `${alias}/${account}`,
    name,
    status: "idle",
    cmd: [],
    cwd: "",
    routines: [],
    remote: alias,
    remote_online: online,
  };
}

function router(alias: string, bot = "rep"): RemoteInfo {
  return {
    alias,
    url: "wss://r.example.com:7420",
    name: "ian",
    bot,
    connected: true,
    members: [],
    delegates: [],
    trusted: [],
    blocked: [],
  };
}

describe("routerUrl", () => {
  it("builds wss or ws from a bare host and port", () => {
    expect(routerUrl("router.example.com", "7420", true)).toBe(
      "wss://router.example.com:7420",
    );
    expect(routerUrl(" 10.0.0.2 ", "9000", false)).toBe("ws://10.0.0.2:9000");
  });

  it("falls back to the router's port when the field is blank", () => {
    expect(routerUrl("r.example.com", "", true)).toBe("wss://r.example.com:7420");
  });

  it("takes an address with a scheme as it is", () => {
    expect(routerUrl("ws://r.local:1234/", "7420", true)).toBe("ws://r.local:1234");
    expect(routerUrl("WSS://r.example.com", "9", false)).toBe("WSS://r.example.com");
  });

  it("is empty with no address", () => {
    expect(routerUrl("  ", "7420", true)).toBe("");
  });
});

describe("portOk", () => {
  it("takes blank or 1–65535", () => {
    for (const ok of ["", "1", "7420", "65535"]) expect(portOk(ok), ok).toBe(true);
    for (const bad of ["0", "65536", "-1", "80a", "7.4"]) expect(portOk(bad), bad).toBe(false);
  });
});

describe("nameError", () => {
  it("follows the router's rule", () => {
    expect(nameError("ian")).toBeNull();
    expect(nameError("춘식이_2")).toBeNull();
    expect(nameError("a-b")).toBeNull();
    expect(nameError("  ")).toBe("empty");
    expect(nameError("a".repeat(33))).toBe("long");
    expect(nameError("가".repeat(32))).toBeNull();
    expect(nameError("ian park")).toBe("bad");
    expect(nameError("ian/park")).toBe("bad");
    expect(nameError("ian.park")).toBe("bad");
  });
});

describe("aliasError", () => {
  it("keeps to handle characters and stays unique", () => {
    expect(aliasError("team", [])).toBeNull();
    expect(aliasError("", [])).toBe("empty");
    expect(aliasError("팀", [])).toBe("bad");
    expect(aliasError("my/team", [])).toBe("bad");
    expect(aliasError("x".repeat(33), [])).toBe("long");
    expect(aliasError("Team", ["team"])).toBe("taken");
  });
});

describe("slugAlias", () => {
  it("turns a title into a handle", () => {
    expect(slugAlias("Acme Team")).toBe("acme-team");
    expect(slugAlias("  --Crew Router!!  ")).toBe("crew-router");
    expect(slugAlias("Café")).toBe("cafe");
  });

  it("falls back when nothing ASCII is left", () => {
    expect(slugAlias("우리 팀")).toBe("team");
    expect(slugAlias("")).toBe("team");
  });
});

describe("freeAlias", () => {
  it("numbers an alias another router has", () => {
    expect(freeAlias("team", [])).toBe("team");
    expect(freeAlias("team", ["Team"])).toBe("team-2");
    expect(freeAlias("team", ["team", "team-2"])).toBe("team-3");
  });
});

describe("joinErrorField", () => {
  it("puts a taken name under the name", () => {
    expect(joinErrorField("이름이 이미 있어요")).toBe("name");
    expect(joinErrorField("name_taken")).toBe("name");
    expect(joinErrorField("invite_required")).toBe("invite");
    expect(joinErrorField("초대 코드가 맞지 않아요")).toBe("invite");
    expect(joinErrorField("connection refused")).toBeNull();
  });
});

describe("remote bots", () => {
  const bots = [
    local("impl"),
    remote("team", "acc_2", "zed"),
    remote("team", "acc_1", "amy", false),
    remote("lab", "acc_9", "kim"),
  ];

  it("leaves remote bots out of the local list", () => {
    expect(localAgents(bots).map((a) => a.id)).toEqual(["impl"]);
    const only = [local("a")];
    expect(localAgents(only)).toBe(only);
  });

  it("labels a remote bot with its router", () => {
    expect(remoteLabel(bots[1])).toBe("team/zed");
    expect(remoteLabel(bots[0])).toBe("impl");
  });

  it("is online unless a remote PC is away", () => {
    expect(isOnline(bots[0])).toBe(true);
    expect(isOnline(bots[1])).toBe(true);
    expect(isOnline(bots[2])).toBe(false);
    expect(isOnline({ ...bots[1], remote_online: undefined })).toBe(true);
  });

  it("makes one section per router in list order, bots by name", () => {
    const sections = remoteSections(bots, [router("team"), router("empty")]);
    expect(sections.map((s) => s.alias)).toEqual(["team", "empty", "lab"]);
    expect(sections[0].bots.map((b) => b.name)).toEqual(["amy", "zed"]);
    expect(sections[1].bots).toEqual([]);
    expect(sections[2].remote).toBeNull();
  });

  it("puts saved bots first, then the rest by name", () => {
    const more = [...bots, remote("team", "acc_3", "bob")];
    const [team] = remoteSections(more, [router("team")], "ko", {
      team: ["team/acc_2", "gone/acc_0", "team/acc_1"],
    });
    expect(team.bots.map((b) => b.name)).toEqual(["zed", "amy", "bob"]);
  });

  it("steps through open routers' bots after the local ones", () => {
    const empty = { groups: [], ungrouped: [] };
    const saved = { sections: [], bots: {} };
    expect(chatOrder(empty, bots, [router("team"), router("lab")], ["lab"], saved)).toEqual([
      { kind: "agent", id: "impl" },
      { kind: "agent", id: "team/acc_1" },
      { kind: "agent", id: "team/acc_2" },
    ]);
  });

  it("steps through a router where the rail put it", () => {
    const rail = { groups: [folder("g1", ["agent:impl"])], ungrouped: [] };
    const saved = { sections: ["remote:lab", "g1"], bots: { team: ["team/acc_2"] } };
    expect(
      chatOrder(rail, bots, [router("team"), router("lab")], [], saved).map((r) => r.id),
    ).toEqual(["lab/acc_9", "impl", "team/acc_2", "team/acc_1"]);
  });

  it("puts this PC's representative in its own router once it was put there", () => {
    const withRep = [...bots, local("rep")];
    const routers = [router("team"), router("lab", "other")];
    expect(placedReps(remoteSections(withRep, routers)).size).toBe(0);

    const saved = { sections: [], bots: { team: ["team/acc_2", "rep"], lab: ["rep"] } };
    const sections = remoteSections(withRep, routers, "ko", saved.bots);
    expect(sections[0].bots.map((b) => b.id)).toEqual(["team/acc_2", "rep", "team/acc_1"]);
    // Not the bot that represents this PC on lab.
    expect(sections[1].bots.map((b) => b.id)).toEqual(["lab/acc_9"]);
    expect([...placedReps(sections)]).toEqual(["rep"]);
    expect(
      chatOrder({ groups: [], ungrouped: [] }, withRep, routers, [], saved).map((r) => r.id),
    ).toEqual(["impl", "team/acc_2", "rep", "team/acc_1", "lab/acc_9"]);
  });

  it("finds the routers a local bot stands in for", () => {
    expect(representing("rep", [router("team"), router("lab", "other")])).toEqual(["team"]);
    expect(representing("impl", [router("team")])).toEqual([]);
  });
});

function folder(id: string, items: string[] = []): Group {
  return { id, name: id, collapsed: false, items };
}

describe("rail sections", () => {
  const U = UNGROUPED_ID;

  it("puts a router this PC has not placed after the loose bots", () => {
    expect(railSections(["g1", "g2"], ["team", "lab"], [])).toEqual([
      "g1",
      "g2",
      U,
      "remote:team",
      "remote:lab",
    ]);
  });

  it("puts a saved router back above the folder it was saved above", () => {
    expect(railSections(["g1", "g2"], ["team"], ["remote:team", "g1", "g2", U])).toEqual([
      "remote:team",
      "g1",
      "g2",
      U,
    ]);
    // The folders' own order is the layout's; the router follows its folder.
    expect(railSections(["g2", "g1"], ["team"], ["g1", "remote:team", "g2", U])).toEqual([
      "remote:team",
      "g2",
      "g1",
      U,
    ]);
    expect(railSections(["g1"], ["team"], ["g1", "remote:team", U])).toEqual([
      "g1",
      "remote:team",
      U,
    ]);
  });

  it("skips vanished folders and routers, and adds new routers last", () => {
    expect(
      railSections(["g2"], ["team", "new"], ["remote:gone", "remote:team", "g1", "g2", U]),
    ).toEqual(["remote:team", "g2", U, "remote:new"]);
  });

  it("moves a router among folders", () => {
    const keys = ["g1", "g2", U, "remote:team"];
    expect(moved(keys, "remote:team", "g1")).toEqual(["remote:team", "g1", "g2", U]);
    expect(moved(keys, "remote:team", "g2")).toEqual(["g1", "remote:team", "g2", U]);
    expect(moved(keys, "remote:team", U)).toEqual(["g1", "g2", "remote:team", U]);
    expect(moved(keys, "remote:team", null)).toEqual(keys);
    expect(moved(keys, "remote:team", "nowhere")).toEqual(keys);
  });

  it("tells the layout which folder a moved folder now goes before", () => {
    const keys = ["remote:team", "g2", "g1", U];
    expect(folderBefore(keys, "g2", ["g1", "g2"])).toBe("g1");
    expect(folderBefore(keys, "g1", ["g1", "g2"])).toBeNull();
  });

  it("saves only the sections and bots still here", () => {
    const sections = remoteSections([remote("team", "a", "amy")], [router("team")]);
    const saved = {
      sections: ["remote:gone"],
      bots: { team: ["team/a", "team/old"], gone: ["gone/x"] },
    };
    expect(
      moveRailSection(saved, ["g1", U, "remote:team"], sections, "remote:team", "g1"),
    ).toEqual({ sections: ["remote:team", "g1", U], bots: { team: ["team/a"] } });
  });

  it("moves a bot within its router only", () => {
    const sections = remoteSections(bots(), [router("team"), router("lab")]);
    const saved = { sections: ["remote:lab", "g1"], bots: {} };
    const next = moveRemoteBot(saved, sections, "team", "team/acc_2", "team/acc_1");
    expect(next).toEqual({
      sections: saved.sections,
      bots: { team: ["team/acc_2", "team/acc_1"] },
    });
    // Another router's bot, or a spot in another router, moves nothing.
    expect(moveRemoteBot(saved, sections, "team", "lab/acc_9", null).bots).toEqual({});
    expect(moveRemoteBot(saved, sections, "team", "team/acc_2", "lab/acc_9").bots).toEqual({
      team: ["team/acc_1", "team/acc_2"],
    });
  });

  it("puts this PC's representative in and takes it back out", () => {
    const all = [...bots(), local("rep")];
    const routers = [router("team"), router("lab")];
    const saved = { sections: ["g1"], bots: {} };
    let sections = remoteSections(all, routers, "ko", saved.bots);
    const inTeam = placeRep(saved, sections, "team", "rep", "team/acc_2");
    expect(inTeam.bots.team).toEqual(["team/acc_1", "rep", "team/acc_2"]);
    expect(inTeam.sections).toEqual(["g1"]);

    sections = remoteSections(all, routers, "ko", inTeam.bots);
    const last = placeRep(inTeam, sections, "team", "rep", null);
    expect(last.bots.team).toEqual(["team/acc_1", "team/acc_2", "rep"]);
    const inLab = placeRep(inTeam, sections, "lab", "rep", null);
    expect(inLab.bots).toEqual({ team: ["team/acc_1", "team/acc_2"], lab: ["lab/acc_9", "rep"] });

    expect(unplaceRep(inTeam, sections, "rep").bots).toEqual({ team: ["team/acc_1", "team/acc_2"] });
  });

  it("reads back only a well formed saved layout", () => {
    expect(normalizeRemoteLayout(null)).toEqual({ sections: [], bots: {} });
    expect(
      normalizeRemoteLayout({ sections: ["g1", 3], bots: { team: ["a", null], bad: "x" } }),
    ).toEqual({ sections: ["g1"], bots: { team: ["a"], bad: [] } });
  });

  function bots() {
    return [
      remote("team", "acc_2", "zed"),
      remote("team", "acc_1", "amy"),
      remote("lab", "acc_9", "kim"),
    ];
  }
});

describe("toggled", () => {
  it("adds a missing id and drops a present one", () => {
    expect(toggled(["a"], "b")).toEqual(["a", "b"]);
    expect(toggled(["a", "b"], "a")).toEqual(["b"]);
  });
});

describe("normalizeRemotes", () => {
  it("drops anything that is not a router", () => {
    expect(normalizeRemotes(null)).toEqual([]);
    expect(normalizeRemotes([router("team"), null, { url: "x" }])).toHaveLength(1);
  });
});
