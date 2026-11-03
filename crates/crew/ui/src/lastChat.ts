const KEY = "crew.last-chat";

export function loadLastChat(): string | null {
  try {
    const id = localStorage.getItem(KEY)?.trim() ?? "";
    return id || null;
  } catch {
    return null;
  }
}

export function saveLastChat(id: string) {
  const trimmed = id.trim();
  if (!trimmed) return;
  try {
    localStorage.setItem(KEY, trimmed);
  } catch {
    /* private mode */
  }
}

/** Chat to show. The one already open stays. Otherwise the last one, when
 *  that bot is still in the list. Otherwise the first bot, once the sidebar
 *  layout is known. Before that, null, so a missing bot is not replaced by
 *  id order and then left there. */
export function pickOpenAgent(
  current: string | null,
  saved: string | null,
  agents: { id: string }[],
  firstId: string | null,
  layoutReady: boolean,
): string | null {
  if (current && agents.some((a) => a.id === current)) return current;
  if (saved && agents.some((a) => a.id === saved)) return saved;
  if (!layoutReady) return null;
  if (firstId && agents.some((a) => a.id === firstId)) return firstId;
  return agents[0]?.id ?? null;
}
