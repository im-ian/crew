import { splitReply } from "./reply";
import type { AgentInfo, ChatMessage } from "./types";

export function sentTarget(from: string): string | null {
  return from.startsWith("to:") ? from.slice(3) : null;
}

function transferKind(
  m: ChatMessage,
  agentIds: ReadonlySet<string>,
): "sent" | "received" | "handoff" | null {
  if (
    m.kind === "sent" ||
    m.kind === "received" ||
    m.kind === "handoff"
  ) {
    return m.kind;
  }
  if (m.kind) return null;
  if (m.role !== "system") return null;
  const from = m.from || "";
  if (from.startsWith("to:")) return "sent";
  if (from.startsWith("#")) return "received";
  if (agentIds.has(from)) return "received";
  return null;
}

/** The other bot on a sent/received/handoff row. Channels are not a peek. */
export function peekPeerId(
  m: ChatMessage,
  agentIds: ReadonlySet<string>,
): string | null {
  const kind = transferKind(m, agentIds);
  if (!kind) return null;
  const from = m.from || "";
  if (kind === "sent") {
    const id = sentTarget(from);
    return id && agentIds.has(id) ? id : null;
  }
  if (from.startsWith("#") || !agentIds.has(from)) return null;
  return from;
}

export type NoteRef = {
  kind: "sent" | "received" | "handoff";
  /** The bot or `#room` on the other end. */
  otherId: string;
};

/**
 * Whether a row is a bot-to-bot note, and who it is with.
 *
 * The thread draws from this and the row builder folds runs by it, so the two
 * cannot disagree about what a note is — a row grouped as one and drawn as
 * something else would vanish into a fold.
 */
export function noteRef(
  m: ChatMessage,
  agents: readonly AgentInfo[],
): NoteRef | null {
  if (m.role !== "system") return null;
  const from = String(m.from || "");
  // The daemon writing about the conversation, not a bot speaking.
  if (!from || from === "user" || from === "crew") return null;
  const kind = m.kind;
  if (kind === "tool" || kind === "routine") return null;
  const to = sentTarget(from);
  if (kind === "sent" || to) return { kind: "sent", otherId: to || from };
  if (kind === "handoff") return { kind: "handoff", otherId: from };
  const known = agents.some((a) => a.id === from);
  if (kind === "received" || known || from.startsWith("#")) {
    return { kind: "received", otherId: from };
  }
  return null;
}

function stripCrewMarkers(text: string): string {
  return text
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !/^\[crew (from:[^\]]+|routine:[^\]]+|channel:[^\]]+|system)\]$/.test(
        t,
      );
    })
    .join("\n")
    .trim();
}

function speechText(m: ChatMessage): string {
  return stripCrewMarkers(splitReply(m.text || "").body);
}

function asSpeech(m: ChatMessage, from: string): ChatMessage | null {
  const text = speechText(m);
  if (!text) return null;
  return { ...m, role: "assistant", from, text, kind: null };
}

export function peekMessages(
  messages: ChatMessage[],
  peerId: string,
  selfId: string,
  agentIds: ReadonlySet<string>,
): ChatMessage[] {
  const out: ChatMessage[] = [];
  let followSelf = false;
  for (const m of messages) {
    const peer = peekPeerId(m, agentIds);
    if (peer === peerId) {
      const kind = transferKind(m, agentIds);
      const speaker = kind === "sent" ? selfId : peerId;
      const row = asSpeech(m, speaker);
      if (row) out.push(row);
      followSelf = kind === "received";
      continue;
    }
    if (m.kind === "tool") continue;
    if (followSelf && m.role === "assistant") {
      const text = speechText(m);
      if (!text) continue;
      const prev = out[out.length - 1];
      if (prev && prev.text.trim() === text) continue;
      out.push({ ...m, text, kind: null });
      continue;
    }
    if (m.role === "user" || peer || m.role === "system") {
      followSelf = false;
    }
  }
  return out;
}
