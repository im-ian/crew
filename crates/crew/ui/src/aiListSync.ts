import { api } from "./api";
import { aiListOf, startingList, type AiChoice } from "./aiList";
import { loadBotDefault, saveBotDefault } from "./botDefault";

/**
 * The list as the daemon keeps it. The first time, the old single default
 * moves in as its only entry. The top one is also kept as the plain default,
 * which the New bot form and ⌘⇧N read without waiting.
 */
export async function loadAiList(): Promise<AiChoice[]> {
  const kept = aiListOf(await api.getFallbackAis());
  const list = startingList(kept, loadBotDefault());
  if (!kept) await api.setFallbackAis(list);
  saveBotDefault(list[0]);
  return list;
}

export async function saveAiList(list: AiChoice[]): Promise<void> {
  if (list.length === 0) return;
  saveBotDefault(list[0]);
  await api.setFallbackAis(list);
}
