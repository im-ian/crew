import { LONG_RUN_MS } from "./botSignals";
import type { AgentInfo, AgentStatus } from "./types";

/** What a bot did that is worth a word in the titlebar island. */
export type BotNoticeKind = "question" | "blocked" | "failure" | "success";
/** How a message that is not about a bot reads: done, careful, or broken. */
export type PlainTone = "ok" | "warn" | "error";

/**
 * `stays`: it waits for the user to close it instead of fading on its own.
 * `piled`: it has been up for a while and folded into the pile under the
 * titlebar, so it no longer takes a row of its own.
 */
export type IslandNotice =
  | { seq: number; stays: boolean; piled: boolean; kind: BotNoticeKind; botId: string }
  | { seq: number; stays: boolean; piled: boolean; kind: PlainTone; text: string };

/** How many notices the island holds, pile included; a newer one pushes the oldest out. */
export const STACK_MAX = 30;

/** What the island needs to remember about a bot between two lists. */
export type BotSnap = {
  status: AgentStatus;
  asking: boolean;
  failed: boolean;
  /** When the run in progress began, so its end can tell a long job from a quick one. */
  startedAt: number | null;
};

// A question or an approval waits on the user, so they outrank how a run ended.
const RANK: Record<BotNoticeKind, number> = {
  question: 4,
  blocked: 3,
  failure: 2,
  success: 1,
};

/**
 * Compare two agent lists and say what each bot just did. A bot seen for the
 * first time says nothing: the app opening is not news. Only a long run that
 * ends earns a success, the same bar the face's dance uses, so a quick reply
 * does not light the island every few seconds.
 */
export function botNotices(
  prev: Map<string, BotSnap>,
  agents: AgentInfo[],
  now: number,
): { notices: { botId: string; kind: BotNoticeKind }[]; snaps: Map<string, BotSnap> } {
  const snaps = new Map<string, BotSnap>();
  const notices: { botId: string; kind: BotNoticeKind }[] = [];
  for (const a of agents) {
    const was = prev.get(a.id);
    const asking = !!a.asking;
    const failed = !!a.failed;
    const working = a.status === "working";
    const startedAt = working
      ? was?.status === "working"
        ? was.startedAt
        : now
      : null;
    snaps.set(a.id, { status: a.status, asking, failed, startedAt });
    if (!was) continue;
    let kind: BotNoticeKind | null = null;
    const pick = (k: BotNoticeKind) => {
      if (!kind || RANK[k] > RANK[kind]) kind = k;
    };
    if (asking && !was.asking) pick("question");
    if (a.status === "blocked" && was.status !== "blocked") pick("blocked");
    if (was.status === "working" && a.status === "idle") {
      if (failed) pick("failure");
      else if (was.startedAt !== null && now - was.startedAt >= LONG_RUN_MS) pick("success");
    }
    if (kind) notices.push({ botId: a.id, kind });
  }
  return { notices, snaps };
}

/** Several at once, least pressing first, so what waits on the user lands on top. */
export function byRank<T extends { kind: BotNoticeKind }>(notices: T[]): T[] {
  return [...notices].sort((a, b) => RANK[a.kind] - RANK[b.kind]);
}

/**
 * The stack with `next` on top. A newer word about the same bot, or the same
 * words again, takes the old one's place instead of stacking twice; past
 * `STACK_MAX` the oldest goes. `dropped` is what left, for its clock.
 */
export function pushNotice(
  stack: readonly IslandNotice[],
  next: IslandNotice,
  max = STACK_MAX,
): { stack: IslandNotice[]; dropped: IslandNotice[] } {
  const same = (n: IslandNotice) =>
    "botId" in next
      ? "botId" in n && n.botId === next.botId
      : "text" in n && n.text === next.text && n.kind === next.kind;
  const all = [next, ...stack.filter((n) => !same(n))];
  const dropped = stack.filter(same);
  // Past the limit, what only passed on news goes before what waits on the user.
  while (all.length > max) {
    let at = all.length - 1;
    for (let i = all.length - 1; i > 0; i--) {
      if (!noticeStays(all[i].kind)) {
        at = i;
        break;
      }
    }
    dropped.push(...all.splice(at, 1));
  }
  return { stack: all, dropped };
}

// How much a notice asks of the user, for the one that tints the pile.
const URGENCY: Record<IslandNotice["kind"], number> = {
  question: 6,
  blocked: 5,
  failure: 4,
  error: 4,
  warn: 3,
  success: 2,
  ok: 1,
};

/** The kind that most needs the user, out of a non-empty list. */
export function mostPressing(notices: readonly IslandNotice[]): IslandNotice["kind"] {
  let top = notices[0].kind;
  for (const n of notices) if (URGENCY[n.kind] > URGENCY[top]) top = n.kind;
  return top;
}

/** A notice the user has to act on stays until they do; the rest fade on their own. */
export function noticeStays(kind: IslandNotice["kind"]): boolean {
  return kind === "question" || kind === "blocked" || kind === "failure" || kind === "error";
}

/** How a passing notice leaves: on its own, or when the user closes it. A Settings choice. */
export type NoticeKeep = "auto" | "keep";

/**
 * How long a passing notice stays, or null for until it is closed: such a
 * notice folds into the pile after `NOTICE_LIFE_MS` instead. A brief word like
 * "Copied" goes quickly whatever Settings say; it only confirms what the user
 * just did.
 */
export function noticeLife(
  kind: IslandNotice["kind"],
  keep: NoticeKeep,
  brief = false,
): number | null {
  if (brief) return BRIEF_LIFE_MS;
  if (noticeStays(kind) || keep === "keep") return null;
  return NOTICE_LIFE_MS;
}

export const BRIEF_LIFE_MS = 3000;
export const NOTICE_LIFE_MS = 5000;

/** What is left of a notice's life when the pointer leaves it: never less than a beat to go. */
export function lifeAfterHover(left: number): number {
  return Math.max(1200, left);
}

/** "탈리가", "안드라스가", "민준이": the subject particle a Korean name takes. */
export function koSubject(name: string): string {
  const last = name.charCodeAt(name.length - 1);
  if (last < 0xac00 || last > 0xd7a3) return name + "이(가)";
  return name + ((last - 0xac00) % 28 ? "이" : "가");
}
