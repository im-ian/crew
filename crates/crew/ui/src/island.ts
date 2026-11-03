import { LONG_RUN_MS } from "./botSignals";
import type { AgentInfo, AgentStatus } from "./types";

/** What a bot did that is worth a word in the titlebar island. */
export type BotNoticeKind = "question" | "blocked" | "failure" | "success";
/** How a message that is not about a bot reads: done, careful, or broken. */
export type PlainTone = "ok" | "warn" | "error";

export type IslandNotice =
  | { seq: number; kind: BotNoticeKind; botId: string }
  | { seq: number; kind: PlainTone; text: string };

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

/** The one notice to show out of several at once: the most pressing. */
export function topNotice<T extends { kind: BotNoticeKind }>(notices: T[]): T | null {
  let top: T | null = null;
  for (const n of notices) if (!top || RANK[n.kind] > RANK[top.kind]) top = n;
  return top;
}

/** A notice the user has to act on stays until they do; the rest fade on their own. */
export function noticeStays(kind: IslandNotice["kind"]): boolean {
  return kind === "question" || kind === "blocked" || kind === "failure" || kind === "error";
}

/** How long a passing notice stays: long enough to read it, 2–7 seconds. */
export function noticeLife(text: string): number {
  return Math.min(7000, Math.max(2000, 1200 + text.length * 60));
}

/** "탈리가", "안드라스가", "민준이": the subject particle a Korean name takes. */
export function koSubject(name: string): string {
  const last = name.charCodeAt(name.length - 1);
  if (last < 0xac00 || last > 0xd7a3) return name + "이(가)";
  return name + ((last - 0xac00) % 28 ? "이" : "가");
}
