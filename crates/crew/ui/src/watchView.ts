import type { TFn } from "./i18n";
import type { AgentInfo } from "./types";

/** It answered, and its CLI is up only for background work such as a CI watch. */
export function isWatching(agent: AgentInfo | null | undefined): boolean {
  return agent?.status === "working" && !!agent.watch?.length;
}

/** What it watches and for how long, counted from the oldest task. */
export function watchLabel(agent: AgentInfo, now: number, t: TFn): string {
  const watch = agent.watch ?? [];
  if (!watch.length) return "";
  const since = Math.min(...watch.map((w) => w.since));
  const minutes = Math.max(0, Math.floor((now - since) / 60_000));
  const head =
    minutes < 1
      ? t("header.statusWatchingNew")
      : t("header.statusWatching", { minutes });
  const what = watch
    .map((w) => w.what.trim())
    .filter(Boolean)
    .join(", ");
  return what ? `${head} · ${what}` : head;
}
