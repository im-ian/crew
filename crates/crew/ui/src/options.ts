import type { TFn } from "./i18n";
import type { MessageKey } from "./locales";
import type { CliKind } from "./types";

export const CLIS: { value: CliKind; label: string }[] = [
  { value: "grok", label: "grok" },
  { value: "claude", label: "claude" },
  { value: "codex", label: "codex" },
];

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
