import type { CliKind } from "./types";

const KEY = "crew.bot-default";

/** The AI a new bot starts on: the New bot form's first value and ⌘⇧N's bot. */
export type BotDefault = {
  cli: CliKind;
  model: string;
  effort: string;
  /** Only for "custom". The message is appended as the last argument. */
  cmd: string;
};

const CLI_KINDS: CliKind[] = [
  "grok",
  "claude",
  "codex",
  "agy",
  "gemini",
  "copilot",
  "opencode",
  "custom",
];

/** Grok on its own default, like a first launch. */
export const FIRST_DEFAULT: BotDefault = { cli: "grok", model: "", effort: "", cmd: "" };

/** Missing or broken storage falls back to the first-launch default. */
export function botDefaultOf(stored: string | null): BotDefault {
  if (!stored) return FIRST_DEFAULT;
  try {
    const v = JSON.parse(stored) as Partial<Record<keyof BotDefault, unknown>>;
    const cli = CLI_KINDS.find((c) => c === v.cli);
    if (!cli) return FIRST_DEFAULT;
    const text = (x: unknown) => (typeof x === "string" ? x : "");
    const cmd = cli === "custom" ? text(v.cmd).trim() : "";
    // A custom default with no command could not make a bot.
    if (cli === "custom" && !cmd) return FIRST_DEFAULT;
    return { cli, model: text(v.model), effort: text(v.effort), cmd };
  } catch {
    return FIRST_DEFAULT;
  }
}

export function loadBotDefault(): BotDefault {
  try {
    return botDefaultOf(localStorage.getItem(KEY));
  } catch {
    return FIRST_DEFAULT;
  }
}

export function saveBotDefault(value: BotDefault) {
  try {
    localStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    /* private mode */
  }
}

/** `base`, or `base 2`, `base 3`… when a bot already has that name. */
export function freeBotName(base: string, taken: Iterable<string>): string {
  const names = new Set([...taken].map((n) => n.trim()));
  if (!names.has(base)) return base;
  for (let n = 2; ; n++) {
    const name = `${base} ${n}`;
    if (!names.has(name)) return name;
  }
}
