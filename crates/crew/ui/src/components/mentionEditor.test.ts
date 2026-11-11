import { describe, expect, it } from "vitest";
import { mentionBefore, mentionCandidates, typedHandle } from "./mentionEditor";
import type { AgentInfo, Group } from "../types";

const bot = (id: string, name: string, remote?: string) => ({ id, name, remote }) as AgentInfo;

const agents = [
  bot("dev", "개발자"),
  bot("art", "애니메이터"),
  bot("jtf", "개발자"),
  bot("acme/acc_1", "민지", "acme"),
];
const groups: Group[] = [
  { id: "g1", name: "Crew", collapsed: false, items: ["agent:dev", "agent:art"] },
  { id: "g2", name: "제이더플로어", collapsed: false, items: ["agent:jtf"] },
];
const ids = (q: string, skip?: string) => mentionCandidates(agents, groups, q, skip).bots.map((a) => a.id);

describe("mentionCandidates", () => {
  it("offers every bot but the one the text goes to", () => {
    expect(ids("", "dev")).toEqual(["art", "jtf", "acme/acc_1"]);
  });

  it("finds a bot by its name, id, group or server", () => {
    expect(ids("개발")).toEqual(["dev", "jtf"]);
    expect(ids("art")).toEqual(["art"]);
    expect(ids("제이더")).toEqual(["jtf"]);
    expect(ids("acme")).toEqual(["acme/acc_1"]);
  });

  it("puts the open chat's groupmates first, the rest after a line", () => {
    expect(ids("", "jtf")).toEqual(["dev", "art", "acme/acc_1"]);
    expect(mentionCandidates(agents, groups, "", "jtf").near).toBe(0);
    const g = [{ id: "g", name: "G", collapsed: false, items: ["agent:jtf", "agent:art"] }];
    const r = mentionCandidates(agents, g, "", "jtf");
    expect(r.bots.map((a) => a.id)).toEqual(["art", "dev", "acme/acc_1"]);
    expect(r.near).toBe(1);
  });

  it("keeps groupmates inside the eight", () => {
    const many = Array.from({ length: 12 }, (_, i) => bot(`b${i}`, `봇${i}`));
    const g = [{ id: "g", name: "G", collapsed: false, items: ["agent:b0", "agent:b11"] }];
    const r = mentionCandidates(many, g, "봇", "b0");
    expect(r.bots[0].id).toBe("b11");
    expect(r.near).toBe(1);
  });

  it("offers eight at most", () => {
    const many = Array.from({ length: 12 }, (_, i) => bot(`b${i}`, `봇${i}`));
    expect(mentionCandidates(many, [], "봇").bots).toHaveLength(8);
  });
});

describe("a # before the caret", () => {
  it("opens the group menu the way @ opens the bot one", () => {
    expect(mentionBefore("봐줘 #cr")).toEqual({ start: 3, query: "cr", sigil: "#" });
    expect(mentionBefore("@de")).toEqual({ start: 0, query: "de", sigil: "@" });
    expect(mentionBefore("issue#cr")).toBeNull();
  });

  it("turns a typed group name into its chip", () => {
    expect(typedHandle("봐줘 #crew", agents, groups)).toEqual({ group: groups[0] });
    expect(typedHandle("#233", agents, groups)).toBeNull();
    expect(typedHandle("@dev", agents, groups)).toEqual({ agent: agents[0] });
  });
});
