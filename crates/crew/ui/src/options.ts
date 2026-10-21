import type { TFn } from "./i18n";
import type { MessageKey } from "./locales";
import type { CliKind, ModelList } from "./types";

export const CLIS: { value: CliKind; label: string }[] = [
  { value: "grok", label: "Grok" },
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
];

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

export function cliFromCmd(cmd?: string[] | null): CliKind | null {
  const raw = cmd?.[0];
  if (!raw) return null;
  const base = raw.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (base === "grok") return "grok";
  if (base === "claude") return "claude";
  if (base === "codex") return "codex";
  return null;
}
