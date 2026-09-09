import { splitReply } from "./reply";
import type { ChatMessage } from "./types";

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
