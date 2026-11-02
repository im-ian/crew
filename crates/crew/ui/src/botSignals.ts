import { useSyncExternalStore } from "react";
import type { AgentInfo, AgentStatus } from "./types";

/**
 * What a bot's face needs beyond its status, shared by every face of the bot.
 * `runMs` is how long the run that last ended took, kept until the next one
 * ends, so a face can tell a long job from a quick one when it finishes.
 */
export type BotSignal = { failed: boolean; asking: boolean; runMs: number };

const NONE: BotSignal = { failed: false, asking: false, runMs: 0 };

const signals = new Map<string, BotSignal>();
const startedAt = new Map<string, number>();
const lastStatus = new Map<string, AgentStatus>();
const listeners = new Set<() => void>();

function same(a: BotSignal, b: BotSignal): boolean {
  return a.failed === b.failed && a.asking === b.asking && a.runMs === b.runMs;
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
    if (a.status === "working") {
      if (!startedAt.has(a.id)) startedAt.set(a.id, now);
    } else {
      const began = startedAt.get(a.id);
      if (was === "working" && began !== undefined) runMs = Math.max(0, now - began);
      startedAt.delete(a.id);
    }
    const next: BotSignal = { failed: !!a.failed, asking: !!a.asking, runMs };
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
