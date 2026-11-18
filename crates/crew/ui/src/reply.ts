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

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const HEADING = /^\s{0,3}#{1,6}\s+/;
const FENCE = /^\s*(?:```|~~~)/;

function plainInline(line: string): string {
  // An escaped mark is a letter, not markup: set it aside until the end.
  return line
    .replace(/\\([\\`*_[\]#+\-.!>~])/g, (_, c: string) =>
      String.fromCharCode(0xe000 + c.charCodeAt(0)),
    )
    .replace(/^\s*>\s?/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_]([^*_\s][^*_]*?)[*_](?![\w*])/g, "$1$2")
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(/[\ue000-\ue0ff]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xe000))
    .trim();
}

/**
 * Markdown as the words a reader sees, for a quote. Headings and list items
 * become their own pieces joined with " · "; lines of one paragraph join with
 * a space. A snippet already folded to one line only loses its marks.
 */
export function plainText(md: string): string {
  const pieces: string[] = [];
  let cur = "";
  const flush = () => {
    if (cur) pieces.push(cur);
    cur = "";
  };
  for (const raw of md.split("\n")) {
    if (FENCE.test(raw)) continue;
    if (!raw.trim()) {
      flush();
      continue;
    }
    const item = LIST_ITEM.test(raw);
    const heading = HEADING.test(raw);
    const words = plainInline(raw.replace(HEADING, "").replace(LIST_ITEM, ""));
    if (!words) continue;
    if (item || heading) {
      flush();
      cur = words;
      if (heading) flush();
    } else {
      cur = cur ? cur + " " + words : words;
    }
  }
  flush();
  return pieces.join(" · ");
}

function token(s: string): string {
  return s.replace(/[\s\]]/g, "");
}

export function wrapReply(body: string, reply: { id: string; from: string; snippet: string }): string {
  const { body: inner } = splitReply(body);
  const id = token(reply.id);
  const from = token(reply.from) || "user";
  const snippet = oneLine(plainText(reply.snippet));
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
