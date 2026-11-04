import { describe, expect, it } from "vitest";
import { botLabel, botSearchText } from "./botLabel";
import type { AgentInfo, Group } from "./types";

const bot = (id: string, name?: string) => ({ id, name }) as AgentInfo;

const groups: Group[] = [
  { id: "g1", name: "Crew", collapsed: false, items: ["agent:dev", "agent:art"] },
  { id: "g2", name: "제이더플로어", collapsed: false, items: ["agent:jtf"] },
];

describe("botLabel", () => {
  it("puts the group before the name", () => {
    expect(botLabel(bot("jtf", "개발자"), groups, null)).toBe("제이더플로어 · 개발자");
    expect(botLabel(bot("jtf", "개발자"), groups, "dev")).toBe("제이더플로어 · 개발자");
  });

  it("leaves the group off for a bot in the open chat's group", () => {
    expect(botLabel(bot("art", "애니메이터"), groups, "dev")).toBe("애니메이터");
    expect(botLabel(bot("dev", "개발자"), groups, "dev")).toBe("개발자");
  });

  it("names a loose bot alone", () => {
    expect(botLabel(bot("solo", "혼자"), groups, "dev")).toBe("혼자");
    expect(botLabel(bot("solo"), groups, null)).toBe("solo");
  });

  it("names a teammate's bot by its server", () => {
    const remote = { ...bot("alpha/7", "실바"), remote: "alpha" } as AgentInfo;
    expect(botLabel(remote, groups, "dev")).toBe("alpha · 실바");
  });

  it("says the group to a loose bot's chat", () => {
    expect(botLabel(bot("dev", "개발자"), groups, "solo")).toBe("Crew · 개발자");
  });
});

describe("botSearchText", () => {
  const find = (q: string, a: AgentInfo) =>
    botSearchText(a, groups).toLowerCase().includes(q.toLowerCase());

  it("finds a bot by its name, id or group", () => {
    const dev = bot("dev", "개발자");
    expect(find("개발자", dev)).toBe(true);
    expect(find("dev", dev)).toBe(true);
    expect(find("crew", dev)).toBe(true);
  });

  it("finds a bot by its label, typed as shown or with a space", () => {
    const dev = bot("dev", "개발자");
    expect(find("Crew · 개발자", dev)).toBe(true);
    expect(find("crew 개발자", dev)).toBe(true);
    expect(find("제이더플로어", dev)).toBe(false);
  });
});
