import { CLIS } from "./options";
import type { CliKind, ModelList, PlanUsage } from "./types";

/** How much model a bot needs. Another CLI stands in at the same tier. */
export type Tier = "strong" | "normal" | "fast";

export const TIERS: readonly Tier[] = ["strong", "normal", "fast"];

/** One bot of a template. The daemon's `TemplateBot`. */
export type TemplateBot = {
  name: string;
  /** What it does. It goes in the bot's instructions. */
  role: string;
  cli: string;
  /** A model on `cli`. Empty takes the tier's model. */
  model: string;
  tier: Tier;
  /** low, medium, high, or empty for the CLI's own. */
  effort: string;
  /** A face shape. Colors are not kept: each bot gets one when it is made. */
  shape?: string | null;
};

/** The daemon's `Template`. */
export type Template = {
  /** Empty for one not saved yet. */
  id: string;
  name: string;
  description: string;
  bots: TemplateBot[];
  /** Index into `bots`. */
  lead?: number | null;
  memory: string;
  /** Each bot works in a worktree of its own. */
  worktree: boolean;
  /** Crew's own: it cannot be changed or removed, only copied. */
  builtin: boolean;
};

type CliName = Exclude<CliKind, "custom">;

/**
 * A tier's model on each CLI, tried in order. A name is used when the CLI
 * lists it (or lists nothing to check against); a pattern takes the first
 * listed model it matches; `""` is the CLI's own default, which always fits.
 * Claude's names are its lasting aliases. The others rename their models
 * often, so only their fast tier looks for a light model by name.
 */
export const TIER_MODELS: Record<CliName, Record<Tier, (string | RegExp)[]>> = {
  claude: { strong: ["opus"], normal: ["sonnet"], fast: ["haiku"] },
  codex: { strong: [""], normal: [""], fast: [/mini|luna|fast|nano/i, ""] },
  grok: { strong: [""], normal: [""], fast: [/fast|mini/i, ""] },
  agy: { strong: [/pro/i, ""], normal: [""], fast: [/flash|fast|lite/i, ""] },
  gemini: { strong: [""], normal: [""], fast: [""] },
  copilot: { strong: [""], normal: [""], fast: [""] },
  opencode: { strong: [""], normal: [""], fast: [""] },
};

function isCliName(cli: string): cli is CliName {
  return cli in TIER_MODELS;
}

/** The model `tier` runs on `cli`, given what that CLI lists. */
export function tierModel(cli: string, tier: Tier, list?: Pick<ModelList, "models">): string {
  if (!isCliName(cli)) return "";
  const models = list?.models ?? [];
  for (const rule of TIER_MODELS[cli][tier]) {
    if (typeof rule === "string") {
      if (!rule || models.length === 0 || models.includes(rule)) return rule;
    } else {
      const hit = models.find((m) => rule.test(m));
      if (hit) return hit;
    }
  }
  return "";
}

/** The tier a bot's model reads as, for a template made from a group. */
export function tierOf(cli: string, model: string): Tier {
  const m = model.trim();
  if (!m) return "normal";
  if (isCliName(cli)) {
    for (const tier of TIERS) {
      const fixed = TIER_MODELS[cli][tier].filter((r): r is string => typeof r === "string" && !!r);
      if (fixed.includes(m)) return tier;
    }
  }
  if (/haiku|mini|luna|fast|flash|lite|nano/i.test(m)) return "fast";
  if (/opus|pro\b|max/i.test(m)) return "strong";
  return "normal";
}

function takesEffort(cli: string): boolean {
  return CLIS.find((c) => c.value === cli)?.effort ?? false;
}

/** What the app knows of a CLI on this PC. */
export type CliState = {
  installed: boolean;
  /** A plan limit is used up and has not started over. */
  exhausted?: boolean;
  models?: string[];
};

export type Resolved = {
  cli: string;
  model: string;
  effort: string;
  /** The CLI the template wanted, when another stands in for it. */
  from?: string;
  /** Why the wanted CLI is not used: not here, or out of its limit. */
  reason?: "missing" | "exhausted";
};

/**
 * The AI a template bot is made on here. Its own CLI when that can run;
 * otherwise the first that can, in the user's AI order and then Crew's, on
 * the same tier and effort. With none, it stays on its own CLI and says why.
 */
export function resolveBot(
  bot: Pick<TemplateBot, "cli" | "model" | "tier" | "effort">,
  states: Partial<Record<string, CliState>>,
  order: readonly string[] = [],
): Resolved {
  const usable = (cli: string) => !!states[cli]?.installed && !states[cli]?.exhausted;
  const effortOn = (cli: string) => (takesEffort(cli) ? bot.effort : "");
  if (usable(bot.cli)) {
    const model = bot.model || tierModel(bot.cli, bot.tier, { models: states[bot.cli]?.models ?? [] });
    return { cli: bot.cli, model, effort: effortOn(bot.cli) };
  }
  const reason = states[bot.cli]?.installed ? "exhausted" : "missing";
  const seen = new Set<string>();
  const candidates = [...order, ...CLIS.map((c) => c.value)].filter((cli) => {
    if (cli === "custom" || cli === bot.cli || seen.has(cli)) return false;
    seen.add(cli);
    return isCliName(cli);
  });
  const stand = candidates.find(usable);
  if (!stand) {
    return { cli: bot.cli, model: bot.model, effort: effortOn(bot.cli), reason };
  }
  return {
    cli: stand,
    model: tierModel(stand, bot.tier, { models: states[stand]?.models ?? [] }),
    effort: effortOn(stand),
    from: bot.cli,
    reason,
  };
}

/**
 * The CLIs whose plan is used up now: a window at 100% that has not reset.
 * The same reading the daemon uses to skip a CLI before a turn. Antigravity
 * keeps a pool per model, so one full pool does not count against it.
 */
export function exhaustedClis(usage: readonly PlanUsage[], nowSec: number): Set<string> {
  const out = new Set<string>();
  for (const u of usage) {
    if (u.cli === "agy") continue;
    const full = (u.windows ?? []).some(
      (w) => w.usedPercent >= 100 && typeof w.resetsAt === "number" && w.resetsAt > nowSec,
    );
    if (full) out.add(u.cli);
  }
  return out;
}

/** A blank template to fill in. */
export function emptyTemplate(): Template {
  return {
    id: "",
    name: "",
    description: "",
    bots: [],
    lead: null,
    memory: "",
    worktree: true,
    builtin: false,
  };
}

/** Crew's template, as the user's own to change. */
export function copyTemplate(t: Template, name: string): Template {
  return {
    ...t,
    id: "",
    name,
    builtin: false,
    bots: t.bots.map((b) => ({ ...b })),
  };
}
