import type { TFn } from "./i18n";
import { splitReply } from "./reply";
import type { AgentInfo, ChatMessage } from "./types";

export function sentTarget(from: string): string | null {
  return from.startsWith("to:") ? from.slice(3) : null;
}

/** A deleted bot leaves only its id behind, which tells the reader nothing. */
export function displayWho(
  id: string,
  agent: AgentInfo | null,
  t: TFn,
): string {
  if (agent) return agent.name || agent.id;
  const sub = subagentType(id);
  if (sub) return t("thread.subagent", { name: sub });
  return id.startsWith("#") ? id : t("thread.deletedBot");
}

/** A bot's Claude subagent talks in notes as `sub:<call id>:<type>`. */
export function subagentType(id: string): string | null {
  if (!id.startsWith("sub:")) return null;
  const rest = id.slice(4);
  return rest.slice(rest.indexOf(":") + 1);
}

/**
 * A subagent is on no roster, but its id still gives it a face of its own.
 * Only for drawing: there is no chat to open for it.
 */
export function subagentFace(id: string, t: TFn): AgentInfo | null {
  return subagentType(id)
    ? ({ id, name: displayWho(id, null, t) } as AgentInfo)
    : null;
}

/** The other bot on a sent/received/handoff row. Channels are not a peek. */
export function peekPeerId(
  m: ChatMessage,
  agentIds: ReadonlySet<string>,
): string | null {
  // One classifier: a row the thread folds as a note and the peek view reads
  // as something else is how the two drift apart.
  const ref = noteRef(m, roster(agentIds));
  if (!ref) return null;
  // A room is not a peek — there is no 1:1 to open.
  return agentIds.has(ref.otherId) ? ref.otherId : null;
}

/** `noteRef` only ever reads ids off the roster. */
function roster(agentIds: ReadonlySet<string>): AgentInfo[] {
  return [...agentIds].map((id) => ({ id }) as AgentInfo);
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

const MARKER = /^\[crew (from:[^\]]+|routine:[^\]]+|channel:[^\]]+|system)\]$/;

function isMarker(line: string): boolean {
  return MARKER.test(line.trim());
}

function stripCrewMarkers(text: string): string {
  return text
    .split("\n")
    .filter((line) => !isMarker(line))
    .join("\n")
    .trim();
}

function speechText(m: ChatMessage): string {
  return stripCrewMarkers(splitReply(m.text || "").body);
}

function speakerIsUser(m: ChatMessage): boolean {
  return m.role === "user" || m.from === "user";
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
  const replies = new Set<string>();
  for (const m of messages) {
    const ref = noteRef(m, roster(agentIds));
    if (ref) {
      if (ref.otherId !== peerId) continue;
      // Marked only on the receipt of a user's @mention.
      if (ref.kind === "sent" && m.mention) continue;
      const row = asSpeech(m, ref.kind === "sent" ? selfId : peerId);
      if (!row) continue;
      // A tell back from the turn the peer asked for is the answer: the daemon
      // drops that turn's reply for it, so the peer never heard the reply.
      if (ref.kind === "sent" && m.peer === peerId) {
        while (out.length && replies.has(out[out.length - 1].id)) out.pop();
      }
      out.push(row);
      continue;
    }
    // The rest of a turn the peer asked for. What this bot says to the user
    // in its own turns stays in the thread, and so does the user's sentence.
    if (m.peer !== peerId || m.kind === "tool" || speakerIsUser(m)) continue;
    const row = asSpeech(m, m.role === "assistant" ? selfId : m.from);
    if (!row) continue;
    // A terminal can type the tell back, envelope and all, before the reply.
    // The same words without the envelope are an answer: "보" to "보" is a tie.
    const echo =
      (m.text || "").split("\n").some(isMarker) &&
      row.text === out[out.length - 1]?.text;
    if (echo) continue;
    out.push(row);
    if (m.role === "assistant") replies.add(row.id);
  }
  return out;
}
