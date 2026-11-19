import type { TeamBot } from "./newTeam";

/** How making a group's bots went. `made` are the ids of the bots that exist. */
export type TeamResult =
  | { ok: true; made: string[] }
  | {
      ok: false;
      /** `reserve`: nothing was made. `add`: the bots in `made` were. */
      stage: "reserve" | "add";
      error: string;
      made: string[];
      total: number;
    };

export type TeamSteps = {
  /** Ids for the bots, before any exists. */
  reserve: (names: string[]) => Promise<string[]>;
  /** Put the ids in the group, lead included, and save it. They are not bots yet. */
  place: (ids: string[]) => void | Promise<void>;
  /** Make one bot with its reserved id. */
  add: (bot: TeamBot, id: string) => Promise<void>;
  /** Take the ids that were never made back out of the group. */
  drop: (ids: string[]) => void;
  /** `done` of `total` made. */
  progress: (done: number, total: number) => void;
};

function message(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : String(err);
}

/**
 * Make a template's bots inside their group from the start: reserve their
 * ids, place them in the group, then make each bot under its id. The rail
 * never shows one outside the group. It stops at the first bot that fails,
 * keeps the ones already made, and takes the rest back out of the group.
 */
export async function makeTeam(team: TeamBot[], steps: TeamSteps): Promise<TeamResult> {
  const total = team.length;
  let ids: string[];
  try {
    ids = await steps.reserve(team.map((b) => b.name));
  } catch (err) {
    return { ok: false, stage: "reserve", error: message(err), made: [], total };
  }
  if (ids.length !== total) {
    return { ok: false, stage: "reserve", error: "the ids did not come back", made: [], total };
  }
  await steps.place(ids);
  const made: string[] = [];
  steps.progress(0, total);
  for (let i = 0; i < total; i++) {
    try {
      await steps.add(team[i], ids[i]);
    } catch (err) {
      steps.drop(ids.slice(i));
      return { ok: false, stage: "add", error: message(err), made, total };
    }
    made.push(ids[i]);
    steps.progress(made.length, total);
  }
  return { ok: true, made };
}

/** How making a new group went, for the dialog: on failure, the group's name. */
export type GroupMade =
  | { ok: true; made: string[] }
  | (Extract<TeamResult, { ok: false }> & { groupName: string });
