export type ReplyTarget = {
  id: string;
  from: string;
  who: string;
  text: string;
};

export type ReplyHead = {
  id: string;
  from: string;
  snippet: string;
};

const SNIPPET = 80;

export function oneLine(text: string, max = SNIPPET): string {
  const t = text.replace(/\s+/g, " ").trim();
  const chars = [...t];
  if (chars.length <= max) return t;
  return chars.slice(0, max).join("") + "…";
}

function token(s: string): string {
  return s.replace(/[\s\]]/g, "");
}

export function wrapReply(body: string, reply: { id: string; from: string; snippet: string }): string {
  const { body: inner } = splitReply(body);
  const id = token(reply.id);
  const from = token(reply.from) || "user";
  const snippet = oneLine(reply.snippet);
  if (!id || !snippet) return inner;
  return `[crew reply:${id} from:${from}]\n${snippet}\n\n${inner}`;
}

export function splitReply(text: string): { reply: ReplyHead | null; body: string } {
  const nl = text.indexOf("\n");
  if (nl < 0) return { reply: null, body: text };
  const line = text.slice(0, nl);
  const m = line.match(/^\[crew reply:([^\s\]]+) from:([^\]]+)\]$/);
  if (!m) return { reply: null, body: text };
  const rest = text.slice(nl + 1);
  const split = rest.indexOf("\n\n");
  if (split < 0) return { reply: null, body: text };
  return {
    reply: { id: m[1], from: m[2], snippet: rest.slice(0, split) },
    body: rest.slice(split + 2),
  };
}

export function replyBody(text: string): string {
  return splitReply(text).body;
}
