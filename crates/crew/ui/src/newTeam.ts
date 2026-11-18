import type { TFn } from "./i18n";
import { cliLabel } from "./options";
import { resolveBot, type CliState, type Resolved, type Template } from "./templates";
import type { CliKind } from "./types";

/** The Select's first row: a group with no bots. */
export const NO_TEMPLATE = "";

/** The Select's rows in order: no template, Crew's, the user's. */
export function templateOrder(list: readonly Template[]): string[] {
  return [
    NO_TEMPLATE,
    ...list.filter((t) => t.builtin).map((t) => t.id),
    ...list.filter((t) => !t.builtin).map((t) => t.id),
  ];
}

/** ↑ and ↓ in the Select. It stops at either end. */
export function stepTemplate(order: readonly string[], current: string, delta: number): string {
  const at = Math.max(0, order.indexOf(current));
  return order[Math.max(0, Math.min(order.length - 1, at + delta))] ?? NO_TEMPLATE;
}

/** The AI the user picked for one bot before making the group. */
export type BotAi = { cli: string; model: string; effort: string };

export type TeamBot = {
  name: string;
  role: string;
  shape?: string | null;
  lead: boolean;
  /** What it is made on: the template's AI, a stand-in, or the user's pick. */
  ai: Resolved;
  /** The user picked this one's AI. */
  picked: boolean;
};

/** The bots a group gets from `t` on this PC. */
export function teamOf(
  t: Template | null,
  states: Partial<Record<string, CliState>>,
  order: readonly string[],
  picks: Readonly<Record<number, BotAi>>,
): TeamBot[] {
  if (!t) return [];
  return t.bots.map((bot, i) => {
    const pick = picks[i];
    return {
      name: bot.name,
      role: bot.role,
      shape: bot.shape,
      lead: t.lead === i,
      ai: pick ? { ...pick } : resolveBot(bot, states, order),
      picked: !!pick,
    };
  });
}

/**
 * The line under a bot whose AI is not the template's: "No Claude → Codex".
 * With no AI to stand in, it says so; a bot the user set says nothing.
 */
export function swapLine(bot: TeamBot, t: TFn): string | null {
  if (bot.picked || !bot.ai.reason) return null;
  const wanted = cliLabel((bot.ai.from ?? bot.ai.cli) as CliKind, t);
  const why = bot.ai.reason === "exhausted" ? t("newGroup.swap.limit", { cli: wanted }) : t("newGroup.swap.missing", { cli: wanted });
  if (!bot.ai.from) return t("newGroup.swap.none", { why });
  const model = bot.ai.model ? ` ${bot.ai.model}` : "";
  return `${why} → ${cliLabel(bot.ai.cli as CliKind, t)}${model}`;
}

/** The group memory and worktree fields: a new template fills what the user has not typed over. */
export type GroupFields = {
  memory: string;
  worktree: boolean;
  memoryEdited: boolean;
  worktreeEdited: boolean;
};

export function refill(fields: GroupFields, t: Template | null): GroupFields {
  return {
    ...fields,
    memory: fields.memoryEdited ? fields.memory : (t?.memory ?? ""),
    worktree: fields.worktreeEdited ? fields.worktree : (t?.worktree ?? true),
  };
}
