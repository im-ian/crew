const KEY = "crew.chat-width";

export type ChatWidth = "full" | "narrow";

/** Missing or anything unknown stays full, matching a first launch. */
export function chatWidthOf(stored: string | null): ChatWidth {
  return stored === "narrow" ? "narrow" : "full";
}

export function loadChatWidth(): ChatWidth {
  try {
    return chatWidthOf(localStorage.getItem(KEY));
  } catch {
    return "full";
  }
}

export function saveChatWidth(width: ChatWidth) {
  try {
    localStorage.setItem(KEY, width);
  } catch {
    /* private mode */
  }
}
