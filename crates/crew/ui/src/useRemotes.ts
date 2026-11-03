import { useCallback, useEffect, useRef, useState } from "react";
import { api, newestOnly, oneAtATime } from "./api";
import { normalizeRemotes } from "./remote";
import type { RemoteInfo } from "./types";

const POLL_MS = 2000;

/**
 * Routers this PC is signed up to. The daemon has no push for them, so this
 * asks on the bot list's slow beat. A failed ask keeps what is shown: a
 * daemon without the router commands has never answered, so that is nothing.
 */
export function useRemotes() {
  const [remotes, setRemotes] = useState<RemoteInfo[]>([]);
  const list = useRef(newestOnly(api.remoteList)).current;
  const poll = useRef(oneAtATime()).current;
  const last = useRef("[]");

  const refresh = useCallback(async () => {
    let next: RemoteInfo[] | null;
    try {
      next = await list();
    } catch {
      return;
    }
    if (!next) return;
    const clean = normalizeRemotes(next);
    // The same list every two seconds must not re-render the rail.
    const key = JSON.stringify(clean);
    if (key === last.current) return;
    last.current = key;
    setRemotes(clean);
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void poll(refresh), POLL_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  return { remotes, refreshRemotes: refresh };
}
