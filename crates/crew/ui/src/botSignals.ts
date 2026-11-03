import { useSyncExternalStore } from "react";
import type { AgentInfo, AgentStatus } from "./types";

/**
 * What a bot's face needs beyond its status, shared by every face of the bot.
 * `runMs` is how long the run that last ended took, kept until the next one
 * ends, so a face can tell a long job from a quick one when it finishes.
 * `endedAt` is when that run ended in idle (0 while none has, or one is running).
 * `held` is set when the reader had not seen the bot's chat as the run ended,
 * and cleared when they look or the bot starts something else. A face reads
 * both to keep its reaction going until the reader looks, and since they live
 * here a face that mounts late, or is rebuilt, shows the same reaction.
 */
export type BotSignal = {
  failed: boolean;
  asking: boolean;
  runMs: number;
  endedAt: number;
  held: boolean;
};

const NONE: BotSignal = {
  failed: false,
  asking: false,
  runMs: 0,
  endedAt: 0,
  held: false,
};

const signals = new Map<string, BotSignal>();
const startedAt = new Map<string, number>();
const lastStatus = new Map<string, AgentStatus>();
let unreadIds = new Set<string>();
const listeners = new Set<() => void>();

function same(a: BotSignal, b: BotSignal): boolean {
  return (
    a.failed === b.failed &&
    a.asking === b.asking &&
    a.runMs === b.runMs &&
    a.endedAt === b.endedAt &&
    a.held === b.held
  );
}

/** Feed the list the window just read. Faces re-draw only when something changed. */
export function publishBotSignals(agents: AgentInfo[], now: number = Date.now()): void {
  let changed = false;
  const present = new Set<string>();
  for (const a of agents) {
    present.add(a.id);
    const was = lastStatus.get(a.id);
    lastStatus.set(a.id, a.status);
    const prev = signals.get(a.id) ?? NONE;
    let runMs = prev.runMs;
    let endedAt = prev.endedAt;
    let held = prev.held;
    if (a.status === "working") {
      if (!startedAt.has(a.id)) startedAt.set(a.id, now);
      endedAt = 0;
      held = false;
    } else {
      const began = startedAt.get(a.id);
      if (was === "working" && began !== undefined) {
        runMs = Math.max(0, now - began);
        // Only a run that comes to rest in idle earns a reaction.
        endedAt = a.status === "idle" ? now : 0;
        held = a.status === "idle" && unreadIds.has(a.id);
      }
      startedAt.delete(a.id);
    }
    const next: BotSignal = {
      failed: !!a.failed,
      asking: !!a.asking,
      runMs,
      endedAt,
      held,
    };
    if (!same(prev, next)) {
      signals.set(a.id, next);
      changed = true;
    }
  }
  for (const id of [...lastStatus.keys()]) {
    if (present.has(id)) continue;
    lastStatus.delete(id);
    startedAt.delete(id);
    if (signals.delete(id)) changed = true;
  }
  if (changed) for (const l of [...listeners]) l();
}

/**
 * Which bots' chats hold lines the reader has not seen. A reaction is held for
 * a chat that was unread as its run ended, or became so while the reaction's
 * moment was still running (the list and this arrive one after the other).
 * Looking at the chat lets it go. Later unread lines revive nothing.
 */
export function publishBotUnread(ids: Iterable<string>, now: number = Date.now()): void {
  const next = new Set(ids);
  const before = unreadIds;
  unreadIds = next;
  let changed = false;
  for (const id of new Set([...before, ...next])) {
    // A bot the list has not named yet picks this up when it does.
    if (!lastStatus.has(id)) continue;
    const prev = signals.get(id) ?? NONE;
    let held = prev.held;
    if (!next.has(id)) held = false;
    else if (!before.has(id) && prev.endedAt > 0 && now < prev.endedAt + afterglowOf(prev).ms) {
      held = true;
    }
    if (held === prev.held) continue;
    signals.set(id, { ...prev, held });
    changed = true;
  }
  if (changed) for (const l of [...listeners]) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The signal as it stands, without subscribing. */
export function peekBotSignal(id?: string | null): BotSignal {
  return id ? (signals.get(id) ?? NONE) : NONE;
}

export function useBotSignal(id?: string | null): BotSignal {
  return useSyncExternalStore(subscribe, () => peekBotSignal(id));
}

/** Tell `listener` whenever any bot's signal changes. For tests and non-React code. */
export const onBotSignals = subscribe;

/** A run this long reads as a real job, so finishing it earns more than a smile. */
export const LONG_RUN_MS = 30_000;

export type Afterglow = { kind: "happy" | "success" | "failure"; ms: number };

/** How a face looks for a moment after a run ends. A failure outlasts the rest. */
export function afterglowOf(signal: BotSignal | undefined): Afterglow {
  if (signal?.failed) return { kind: "failure", ms: 8000 };
  if ((signal?.runMs ?? 0) >= LONG_RUN_MS) return { kind: "success", ms: 2600 };
  return { kind: "happy", ms: 1600 };
}

/**
 * The reaction a face shows right now, and how long its usual moment has left
 * (0 once spent, when only a held reaction keeps it up). Null when the bot is
 * not idle or no run of its has ended in idle since the app began.
 */
export function afterglowAt(
  status: AgentStatus | null | undefined,
  signal: BotSignal | null | undefined,
  now: number,
): { kind: Afterglow["kind"]; left: number; shown: boolean } | null {
  if (status !== "idle" || !signal || signal.endedAt <= 0) return null;
  const { kind, ms } = afterglowOf(signal);
  const left = Math.max(0, signal.endedAt + ms - now);
  return { kind, left, shown: signal.held || left > 0 };
}
