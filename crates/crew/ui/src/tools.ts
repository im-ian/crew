import { noteRef } from "./peek";
import type { AgentInfo, ChatMessage } from "./types";

const SHOW_KEY = "crew.tools";

/** Tool cards are noise for most readers, so they stay hidden until asked for. */
export function loadShowTools(): boolean {
  try {
    return localStorage.getItem(SHOW_KEY) === "on";
  } catch {
    return false;
  }
}

export function saveShowTools(show: boolean) {
  try {
    localStorage.setItem(SHOW_KEY, show ? "on" : "off");
  } catch {
    /* private mode */
  }
}

export type ThreadRow =
  | { kind: "msg"; msg: ChatMessage }
  | { kind: "tools"; msgs: ChatMessage[] }
  | { kind: "notes"; peerId: string; msgs: ChatMessage[] };

/**
 * Consecutive tool cards collapse into one row so a long run reads as one line,
 * and so does a back-and-forth with one bot: sent, received and handoff notes,
 * and the reply to a turn that bot asked for, are one exchange (`runPeer`), and
 * four of them in a row is most of a screen.
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
    const peer = runPeer(msg, agents);
    if (peer) {
      if (last?.kind === "notes" && last.peerId === peer) {
        last.msgs.push(msg);
      } else {
        rows.push({ kind: "notes", peerId: peer, msgs: [msg] });
      }
      continue;
    }
    if (msg.kind === "tool") {
      if (last?.kind === "tools") last.msgs.push(msg);
      else rows.push({ kind: "tools", msgs: [msg] });
      continue;
    }
    rows.push({ kind: "msg", msg });
  }
  return rows;
}

/**
 * The row the wait dots follow. A reply still being written stays above what
 * lands in its chat meanwhile (a queued message, a teammate's reply, a "sent
 * to" notice), so those are passed over.
 */
export function dotsAfter(
  list: readonly ChatMessage[],
): ChatMessage | undefined {
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m.queued || m.kind === "handoff" || m.kind === "sent") continue;
    return m;
  }
  return undefined;
}

/**
 * Time a row contributes to the centered clock. A tool run, a folded note,
 * and a notice that is not a balloon pass `0`: they sit in the same stretch
 * as a message, and a real stamp there would swallow that message's divider
 * or hide a gap that comes after the run.
 */
export function momentStamp(row: ThreadRow): number {
  if (row.kind !== "msg") return 0;
  const m = row.msg;
  if (m.role === "system" && m.from !== "user") return 0;
  return m.ts || 0;
}

/**
 * The bot whose exchange a row folds into: the other end of a note, or the
 * bot that asked for the turn the row came from. That turn's reply is already
 * in the asker's chat, so here it reads beside the thread. A card waiting on
 * the user stays in the thread, where it can be answered, and a tool card
 * stays with the tool cards, where the tools switch shows or hides it.
 */
export function runPeer(
  msg: ChatMessage,
  agents: readonly AgentInfo[],
): string | null {
  const note = noteRef(msg, agents);
  if (note) return note.otherId;
  if (msg.kind === "tool" || msg.choice || msg.approval) return null;
  return msg.peer || null;
}

/**
 * What a folded tool run did, by name: distinct, in first-use order, so the
 * chip says "Read · Grep · Edit" instead of only a count. An MCP tool keeps
 * its last segment — `mcp__server__browser_click` would fill the row alone.
 */
export function toolNames(
  msgs: readonly ChatMessage[],
  max = 3,
): { names: string[]; more: number } {
  const seen: string[] = [];
  for (const m of msgs) {
    const name = (m.from || "tool").split("__").pop() || "tool";
    if (!seen.includes(name)) seen.push(name);
  }
  return { names: seen.slice(0, max), more: Math.max(0, seen.length - max) };
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
