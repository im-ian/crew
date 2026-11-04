import { describe, expect, it } from "vitest";
import { mentionCandidates } from "./mentionEditor";
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
const ids = (q: string, skip?: string) => mentionCandidates(agents, groups, q, skip).map((a) => a.id);

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

  it("offers eight at most", () => {
    const many = Array.from({ length: 12 }, (_, i) => bot(`b${i}`, `봇${i}`));
    expect(mentionCandidates(many, [], "봇")).toHaveLength(8);
  });
});
