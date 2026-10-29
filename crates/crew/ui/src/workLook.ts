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
// bot, so they share this instead of picking their own.
type Key = string | symbol;
const held = new Map<Key, WorkLook>();
const lastUsed = new Map<Key, WorkLook>();

/** The look this run already has, or a fresh one that avoids the previous run's. */
export function claimWorkLook(key: Key, rand: () => number = Math.random): WorkLook {
  const have = held.get(key);
  if (have) return have;
  const next = pickWorkLook(lastUsed.get(key) ?? null, rand);
  held.set(key, next);
  lastUsed.set(key, next);
  return next;
}

/** The run is over. The next claim draws again. */
export function releaseWorkLook(key: Key): void {
  held.delete(key);
}

/**
 * The look for a bot's current run, null while it is not working. It is drawn
 * when work starts and held until work stops, and every face of the same bot
 * (`id`) shows the same one. A face without an id keeps its own.
 */
export function useWorkLook(working: boolean, id?: string | null): WorkLook | null {
  const own = useRef<symbol>(Symbol("work-look"));
  const key: Key = id || own.current;
  const [look, setLook] = useState<WorkLook | null>(() =>
    working ? claimWorkLook(key) : null,
  );
  useLayoutEffect(() => {
    if (!working) {
      releaseWorkLook(key);
      setLook(null);
      return;
    }
    const next = claimWorkLook(key);
    if (next !== look) setLook(next);
  }, [working, key]);
  return working ? look : null;
}
