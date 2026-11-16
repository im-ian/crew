import type { TFn } from "./i18n";
import type { AgentInfo } from "./types";
import { showsWatch, watchLabel } from "./watchView";

/** Which colour a status word takes: `.head-status.is-<tone>`. */
export type StatusTone = "working" | "watching" | "blocked" | "exited" | "waiting" | "idle";

export type StatusView = { tone: StatusTone; text: string };

/**
 * What a bot is doing, as the chat header says it. Idle says nothing there.
 * A watch names what it watches; a teammate's bot with a question open is
 * waiting on its owner, not on this user.
 */
export function statusView(agent: AgentInfo | null | undefined, now: number, t: TFn): StatusView | null {
  if (!agent) return null;
  if (showsWatch(agent)) return { tone: "watching", text: watchLabel(agent, now, t) };
  return wordFor(agent, t);
}

/**
 * One short word for a row in a list: idle reads as such, and a watch drops
 * what it watches, which the bot's own header still shows.
 */
export function briefStatus(agent: AgentInfo, t: TFn): StatusView {
  if (showsWatch(agent)) return { tone: "watching", text: t("header.statusWatchingNew") };
  return wordFor(agent, t) ?? { tone: "idle", text: t("header.statusIdle") };
}

/**
 * The bots `agent` waits on, as the screen shows it: only while it rests.
 * Needs review and working say more about it, and an exited bot says nothing.
 */
export function waitingOn(agent: AgentInfo | null | undefined): string[] {
  if (!agent || agent.status !== "idle") return [];
  return agent.waiting_on ?? [];
}

function wordFor(agent: AgentInfo, t: TFn): StatusView | null {
  if (agent.remote && agent.asking) return { tone: "blocked", text: t("header.statusOwner") };
  if (agent.status === "working") return { tone: "working", text: t("header.statusWorking") };
  if (agent.status === "blocked") return { tone: "blocked", text: t("header.statusBlocked") };
  if (agent.status === "exited") return { tone: "exited", text: t("header.statusExited") };
  if (waitingOn(agent).length) return { tone: "waiting", text: t("header.statusWaiting") };
  return null;
}
