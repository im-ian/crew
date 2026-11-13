import { useEffect, useState } from "react";
import { api } from "./api";
import { keepSame } from "./stableList";
import type { ChatMessage } from "./types";

/**
 * The rows of one split half. The open chat's rows come from `live`, which
 * also keeps them here; the other half polls its own bot, faster while it
 * works. Null until the first rows for `id` are in.
 */
export function usePaneMessages(
  id: string | null,
  live: ChatMessage[] | null,
  hot: boolean,
): ChatMessage[] | null {
  const [held, setHeld] = useState<{ id: string | null; rows: ChatMessage[] }>({
    id: null,
    rows: [],
  });

  useEffect(() => {
    if (!id || !live) return;
    setHeld((cur) => (cur.id === id && cur.rows === live ? cur : { id, rows: live }));
  }, [id, live]);

  const polling = !!id && !live;
  useEffect(() => {
    if (!polling || !id) return;
    let cancelled = false;
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      const rows = await api.getMessages(id).catch(() => null);
      busy = false;
      if (cancelled || !rows) return;
      setHeld((cur) => ({ id, rows: cur.id === id ? keepSame(cur.rows, rows) : rows }));
    };
    void tick();
    const timer = window.setInterval(() => void tick(), hot ? 300 : 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [id, polling, hot]);

  return held.id === id && id ? held.rows : null;
}
