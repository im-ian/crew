import { useLayoutEffect, useRef, useState } from "react";

/** How a bot looks while it works. One is drawn each time work starts. */
export const WORK_LOOKS = ["hustle", "magnifier", "laptop", "checklist", "keyboard"] as const;
export type WorkLook = (typeof WORK_LOOKS)[number];

/** Never the one just used, so back-to-back runs do not look the same. */
export function pickWorkLook(
  prev: WorkLook | null,
  rand: () => number = Math.random,
): WorkLook {
  const pool = prev ? WORK_LOOKS.filter((look) => look !== prev) : WORK_LOOKS;
  return pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))];
}

// One look per bot per run. The rail, the header and the chat each draw the same
// bot, so they share this instead of picking their own. A run lasts while at
// least one face of the bot is working, so a face that is not working (a mention
// chip) never ends it, and a run whose faces all unmount does not leak its look.
type Key = string | symbol;
const held = new Map<Key, WorkLook>();
const working = new Map<Key, number>();
const lastUsed = new Map<Key, WorkLook>();

/** A face starts working. The run's look is drawn by the first one and shared. */
export function acquireWorkLook(key: Key, rand: () => number = Math.random): WorkLook {
  working.set(key, (working.get(key) ?? 0) + 1);
  const have = held.get(key);
  if (have) return have;
  const next = pickWorkLook(lastUsed.get(key) ?? null, rand);
  held.set(key, next);
  lastUsed.set(key, next);
  return next;
}

/** A face stops working or unmounts. The last one out ends the run. */
export function releaseWorkLook(key: Key): void {
  const left = (working.get(key) ?? 0) - 1;
  if (left > 0) {
    working.set(key, left);
    return;
  }
  working.delete(key);
  held.delete(key);
}

/**
 * The look for a bot's current run, null while this face is not working. It is
 * drawn when work starts and held until the bot's last working face stops, and
 * every face of the same bot (`id`) shows the same one. A face without an id
 * keeps its own.
 */
export function useWorkLook(isWorking: boolean, id?: string | null): WorkLook | null {
  const own = useRef<symbol>(Symbol("work-look"));
  const key: Key = id || own.current;
  const [look, setLook] = useState<WorkLook | null>(null);
  useLayoutEffect(() => {
    if (!isWorking) {
      setLook(null);
      return;
    }
    setLook(acquireWorkLook(key));
    return () => releaseWorkLook(key);
  }, [isWorking, key]);
  return isWorking ? look : null;
}
