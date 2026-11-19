import { describe, expect, it } from "vitest";
import { makeTeam, type TeamSteps } from "./makeTeam";
import type { TeamBot } from "./newTeam";

const bot = (name: string): TeamBot => ({ name, role: "", lead: false, picked: false, ai: { cli: "claude", model: "", effort: "" } });
const team = [bot("리드"), bot("개발자"), bot("QA")];

function recorder(fail?: { at?: number; reserve?: boolean }) {
  const log: string[] = [];
  const progress: [number, number][] = [];
  const steps: TeamSteps = {
    reserve: async (names) => {
      log.push(`reserve ${names.join(",")}`);
      if (fail?.reserve) throw new Error("daemon down");
      return names.map((_, i) => `id-${i}`);
    },
    place: (ids) => {
      log.push(`place ${ids.join(",")}`);
    },
    add: async (b, id) => {
      if (fail?.at !== undefined && id === `id-${fail.at}`) throw new Error(`no ${b.name}`);
      log.push(`add ${id}`);
    },
    drop: (ids) => log.push(`drop ${ids.join(",")}`),
    progress: (d, t) => progress.push([d, t]),
  };
  return { steps, log, progress };
}

describe("makeTeam", () => {
  it("places every bot in the group before any bot exists", async () => {
    const { steps, log, progress } = recorder();
    const r = await makeTeam(team, steps);
    expect(r).toEqual({ ok: true, made: ["id-0", "id-1", "id-2"] });
    expect(log).toEqual(["reserve 리드,개발자,QA", "place id-0,id-1,id-2", "add id-0", "add id-1", "add id-2"]);
    expect(progress).toEqual([[0, 3], [1, 3], [2, 3], [3, 3]]);
  });

  it("stops at a bot that fails, keeps the made ones, and takes the rest out", async () => {
    const { steps, log } = recorder({ at: 1 });
    const r = await makeTeam(team, steps);
    expect(r).toEqual({ ok: false, stage: "add", error: "no 개발자", made: ["id-0"], total: 3 });
    expect(log.slice(-2)).toEqual(["add id-0", "drop id-1,id-2"]);
  });

  it("makes nothing and places nothing when ids cannot be reserved", async () => {
    const { steps, log } = recorder({ reserve: true });
    const r = await makeTeam(team, steps);
    expect(r).toMatchObject({ ok: false, stage: "reserve", error: "daemon down", made: [] });
    expect(log).toEqual(["reserve 리드,개발자,QA"]);
  });
});
