import { noteRef } from "./peek";
import type { AgentInfo, ChatMessage } from "./types";

export type ThreadRow =
  | { kind: "msg"; msg: ChatMessage }
  | { kind: "tools"; msgs: ChatMessage[] }
  | { kind: "notes"; peerId: string; msgs: ChatMessage[] };

/**
 * Consecutive tool cards collapse into one row so a long run reads as one line,
 * and so does a back-and-forth with one bot: sent, received and handoff notes
 * are one exchange, and four of them in a row is most of a screen.
 *
 * A note run is emitted even when it holds one note, so a row does not change
 * element type the moment a reply arrives — React would unmount the note the
 * reader had open and remount it inside a closed fold. `NoteGroup` draws the
 * fold head only once there is more than one.
 */
export function threadRows(
  list: ChatMessage[],
  agents: readonly AgentInfo[],
): ThreadRow[] {
  const rows: ThreadRow[] = [];
  for (const msg of list) {
    const last = rows[rows.length - 1];
    if (msg.kind === "tool") {
      if (last?.kind === "tools") last.msgs.push(msg);
      else rows.push({ kind: "tools", msgs: [msg] });
      continue;
    }
    const note = noteRef(msg, agents);
    if (note) {
      if (last?.kind === "notes" && last.peerId === note.otherId) {
        last.msgs.push(msg);
      } else {
        rows.push({ kind: "notes", peerId: note.otherId, msgs: [msg] });
      }
      continue;
    }
    rows.push({ kind: "msg", msg });
  }
  return rows;
}

const HEAD_KEYS = [
  "command",
  "file_path",
  "path",
  "pattern",
  "query",
  "url",
  "prompt",
  "description",
];

export type ToolArg = { key: string; value: string };

/** Arguments as lines, so an open card reads as a list and not as raw JSON. */
export function toolArgs(detail: string): ToolArg[] {
  const raw = (detail || "").trim();
  if (!raw) return [];
  if (raw.startsWith("{")) {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      const out = Object.entries(obj)
        .filter(([, v]) => v !== null && v !== undefined && v !== "")
        .map(([key, v]) => ({
          key,
          value: typeof v === "string" ? v : JSON.stringify(v, null, 2),
        }));
      if (out.length) return out;
    } catch {
      /* not json after all */
    }
  }
  return [{ key: "", value: raw }];
}

/** The one argument worth showing next to the tool name when it is collapsed. */
export function toolSummary(detail: string): string {
  const raw = (detail || "").trim();
  if (!raw) return "";
  let pick = raw;
  if (raw.startsWith("{")) {
    let obj: Record<string, unknown> | null = null;
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      obj = null;
    }
    if (obj) {
      const str = (k: string) =>
        typeof obj[k] === "string" && (obj[k] as string).trim()
          ? (obj[k] as string)
          : null;
      const key = HEAD_KEYS.find(str) ?? Object.keys(obj).find(str);
      pick = key ? String(obj[key]) : "";
    }
  }
  const line = pick.split("\n")[0]?.trim() ?? "";
  return line.length > 72 ? line.slice(0, 71) + "…" : line;
}
