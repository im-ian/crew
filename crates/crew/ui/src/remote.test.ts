import { describe, expect, it } from "vitest";
import {
  aliasError,
  freeAlias,
  isOnline,
  joinErrorField,
  localAgents,
  nameError,
  normalizeRemotes,
  portOk,
  remoteLabel,
  remoteOrder,
  remoteSections,
  representing,
  routerUrl,
  slugAlias,
  toggled,
} from "./remote";
import type { AgentInfo, RemoteInfo } from "./types";

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

  it("steps through open routers' bots after the local ones", () => {
    expect(remoteOrder(bots, [router("team"), router("lab")], ["lab"])).toEqual([
      { kind: "agent", id: "team/acc_1" },
      { kind: "agent", id: "team/acc_2" },
    ]);
  });

  it("finds the routers a local bot stands in for", () => {
    expect(representing("rep", [router("team"), router("lab", "other")])).toEqual(["team"]);
    expect(representing("impl", [router("team")])).toEqual([]);
  });
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
