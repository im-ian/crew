import type { CliKind } from "./types";

export const CLIS: { value: CliKind; label: string }[] = [
  { value: "grok", label: "grok" },
  { value: "claude", label: "claude" },
  { value: "codex", label: "codex" },
];

export const EFFORTS: { value: string; label: string }[] = [
  { value: "", label: "기본" },
  { value: "low", label: "가볍게" },
  { value: "medium", label: "보통" },
  { value: "high", label: "꼼꼼하게" },
];

export function cliFromCmd(cmd?: string[] | null): CliKind | null {
  const raw = cmd?.[0];
  if (!raw) return null;
  const base = raw.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (base === "grok") return "grok";
  if (base === "claude") return "claude";
  if (base === "codex") return "codex";
  return null;
}
