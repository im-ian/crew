import type { TFn } from "./i18n";
import type { MessageKey } from "./locales";
import type { CliKind, ModelList } from "./types";

export const CLIS: { value: CliKind; label: string; effort: boolean }[] = [
  { value: "grok", label: "Grok", effort: true },
  { value: "claude", label: "Claude", effort: true },
  { value: "codex", label: "Codex", effort: true },
  { value: "agy", label: "Antigravity", effort: true },
  { value: "gemini", label: "Gemini", effort: false },
  { value: "copilot", label: "Copilot", effort: false },
  { value: "opencode", label: "OpenCode", effort: true },
  { value: "custom", label: "Command", effort: false },
];

const CLI_BY_BIN: Record<string, CliKind> = {
  grok: "grok",
  claude: "claude",
  codex: "codex",
  agy: "agy",
  gemini: "gemini",
  copilot: "copilot",
  opencode: "opencode",
};

export function cliLabel(cli: CliKind, t: TFn): string {
  if (cli === "custom") return t("cli.custom");
  return CLIS.find((c) => c.value === cli)?.label ?? cli;
}

// Claude takes fixed aliases, so each can say what it is for; grok and codex
// list whatever their CLI reports.
const MODEL_HINTS: Record<string, MessageKey> = {
  haiku: "model.hint.fast",
  sonnet: "model.hint.balanced",
  opus: "model.hint.deep",
};

export type ModelRow = { value: string; label: string; hint?: string };

export function modelRows(
  list: ModelList | undefined,
  value: string,
  t: TFn,
): ModelRow[] {
  const rows: ModelRow[] = [
    { value: "", label: t("model.default"), hint: list?.default || t("model.cliDefault") },
  ];
  const seen = new Set<string>([""]);
  // A saved model the CLI no longer lists still shows, last.
  for (const model of [...(list?.models ?? []), value]) {
    if (seen.has(model)) continue;
    seen.add(model);
    const hint = MODEL_HINTS[model];
    rows.push({ value: model, label: model, hint: hint ? t(hint) : undefined });
  }
  return rows;
}

export const EFFORTS = ["", "low", "medium", "high"] as const;

export function effortOptions(t: TFn): { value: string; label: string }[] {
  return EFFORTS.map((value) => ({
    value,
    label: t((value ? `effort.${value}` : "effort.default") as MessageKey),
  }));
}

export function cliFromCmd(cmd?: string[] | null, headless?: boolean): CliKind | null {
  const raw = cmd?.[0];
  if (!raw) return headless ? "custom" : null;
  const base = raw.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const known = CLI_BY_BIN[base];
  if (known) return known;
  return headless ? "custom" : null;
}

export function formatCmd(cmd?: string[] | null): string {
  return (cmd ?? []).map(quoteArg).join(" ");
}

function quoteArg(arg: string): string {
  if (arg === "" || /[\s"']/.test(arg)) {
    return `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return arg;
}

const EFFORT_LABEL: Record<string, MessageKey> = {
  low: "effort.low",
  medium: "effort.medium",
  high: "effort.high",
};

// An empty model is the CLI default; pass that id when the list has reported it.
export function modelLine(
  agent: {
    cmd?: string[] | null;
    model?: string | null;
    effort?: string | null;
    headless?: boolean;
  },
  defaultModel: string | null | undefined,
  t: TFn,
): string | null {
  const cli = cliFromCmd(agent.cmd, agent.headless);
  if (!cli) return null;
  const spec = CLIS.find((c) => c.value === cli);
  const name = cliLabel(cli, t);
  if (cli === "custom") {
    const bin = agent.cmd?.[0]?.split(/[\\/]/).pop() || name;
    return `${name} · ${bin}`;
  }
  const model = agent.model?.trim() || defaultModel?.trim() || t("model.default");
  if (!spec?.effort) return `${name} · ${model}`;
  const effort = t(EFFORT_LABEL[agent.effort?.trim() || ""] ?? "effort.default");
  return `${name} · ${model} · ${t("field.effort")} ${effort}`;
}

// Undefined: the CLI is missing, so ask again later. Null: it is installed and
// reported no default id. A string is that id.
export function pinnedDefault(list: {
  installed: boolean;
  default?: string | null;
}): string | null | undefined {
  if (!list.installed) return undefined;
  return list.default?.trim() || null;
}
