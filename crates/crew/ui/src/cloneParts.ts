/** What a clone takes besides its settings. The daemon's names. */
export type CloneParts = {
  avatar: boolean;
  routines: boolean;
  memory: boolean;
  /** The conversation so far. The copy's CLI reads it once, on its own session. */
  chat: boolean;
};

/** The duplicate dialog's checks: `parts` go to the daemon, `group` stays here. */
export type ClonePick = CloneParts & {
  /** Into the original's group, right below it. */
  group: boolean;
};

/** What a duplicate took before there was a choice: all of it but the chat. */
export function cloneDefaults(): ClonePick {
  return { avatar: true, routines: true, memory: true, group: true, chat: false };
}

const CHAT_CLIS = ["grok", "claude", "codex", "gemini", "agy", "copilot", "opencode"];

/**
 * A terminal's chat is read off its screen, and a copy's terminal would show
 * none of it, so only a bot that chats can bring its conversation.
 */
export function canCarryChat(agent: { cmd: string[]; headless?: boolean }): boolean {
  if (agent.headless) return true;
  const program = (agent.cmd[0] ?? "").split("/").pop()?.toLowerCase() ?? "";
  return CHAT_CLIS.includes(program);
}

/** The daemon's half of a pick. A chat the bot cannot bring is not asked for. */
export function partsOf(pick: ClonePick, carriesChat: boolean): CloneParts {
  return {
    avatar: pick.avatar,
    routines: pick.routines,
    memory: pick.memory,
    chat: pick.chat && carriesChat,
  };
}
