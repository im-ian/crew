import { moveAi } from "./aiList";
import { groupLead } from "./groups";
import { groupBots } from "./leadGroup";
import { cliFromCmd, cliLabel, EFFORT_LABEL } from "./options";
import type { TFn } from "./i18n";
import { tierModel, tierOf, type Template, type TemplateBot } from "./templates";
import type { AgentInfo, Group } from "./types";

/** `bots` with one moved, the lead still on the same bot. */
export function moveBot(t: Template, from: number, to: number): Template {
  const order = moveAi(
    t.bots.map((_, i) => i),
    from,
    to,
  );
  const lead = t.lead == null ? null : order.indexOf(t.lead);
  return { ...t, bots: order.map((i) => t.bots[i]), lead: lead != null && lead >= 0 ? lead : null };
}

/** Without the bot at `at`. Taking the lead out leaves none. */
export function removeBot(t: Template, at: number): Template {
  const bots = t.bots.filter((_, i) => i !== at);
  let lead = t.lead ?? null;
  if (lead === at) lead = null;
  else if (lead != null && lead > at) lead -= 1;
  return { ...t, bots, lead };
}

/** The star: one lead, and a second press takes it off. */
export function toggleLead(t: Template, at: number): Template {
  return { ...t, lead: t.lead === at ? null : at };
}

export function changeBot(t: Template, at: number, next: Partial<TemplateBot>): Template {
  return { ...t, bots: t.bots.map((b, i) => (i === at ? { ...b, ...next } : b)) };
}

/** A new bot on the user's first AI. */
export function addBot(t: Template, name: string, ai: { cli: string; model: string; effort: string }, shape: string): Template {
  const cli = ai.cli === "custom" ? "claude" : ai.cli;
  const model = ai.cli === "custom" ? "" : ai.model;
  const bot: TemplateBot = {
    name,
    role: "",
    cli,
    model,
    tier: tierOf(cli, model),
    effort: ai.cli === "custom" ? "" : ai.effort,
    shape,
  };
  return { ...t, bots: [...t.bots, bot] };
}

/** What is missing before it can be saved, or null. */
export function templateProblem(t: Template): "name" | "botName" | null {
  if (!t.name.trim()) return "name";
  if (t.bots.some((b) => !b.name.trim())) return "botName";
  return null;
}

/**
 * A group as a template: its bots' settings in sidebar order, its lead, its
 * memory and its worktree switch. Not the chats, the bots' own memory or the
 * folder. A teammate's bot and one run by a typed command cannot be made
 * again from a template, so they are left out and counted.
 */
export function templateFromGroup(
  group: Group,
  agents: readonly AgentInfo[],
  memory: string,
): { template: Template; skipped: number } {
  const lead = groupLead(group);
  const bots: TemplateBot[] = [];
  let leadAt: number | null = null;
  let skipped = 0;
  for (const a of groupBots(group, agents)) {
    const cli = cliFromCmd(a.cmd, a.headless);
    if (a.remote || !cli || cli === "custom") {
      skipped += 1;
      continue;
    }
    if (a.id === lead) leadAt = bots.length;
    const model = a.model?.trim() ?? "";
    bots.push({
      name: a.name,
      role: a.role?.trim() ?? "",
      cli,
      model,
      tier: tierOf(cli, model),
      effort: a.effort ?? "",
      shape: a.avatar_shape ?? null,
    });
  }
  return {
    template: {
      id: "",
      name: group.name,
      description: "",
      bots,
      lead: leadAt,
      memory,
      worktree: group.worktree !== "off",
      builtin: false,
    },
    skipped,
  };
}

/** "Claude · opus · Effort Thorough": the model the bot gets here, or its tier's. */
export function templateBotLine(
  bot: Pick<TemplateBot, "cli" | "model" | "tier" | "effort">,
  t: TFn,
  models?: string[],
): string {
  const cli = bot.cli as Parameters<typeof cliLabel>[0];
  const model = bot.model || tierModel(bot.cli, bot.tier, models ? { models } : undefined) || t("model.default");
  const parts = [cliLabel(cli, t), model];
  if (bot.effort) parts.push(`${t("field.effort")} ${t(EFFORT_LABEL[bot.effort] ?? "effort.default")}`);
  return parts.join(" · ");
}
