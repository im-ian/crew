import { parseFileRef } from "./fileRef";
import { resolveLocalPath } from "./markdown";
import type { ChatMessage } from "./types";

/**
 * The bot info sheet's 보관함: the links and files a bot's chat brought up,
 * gathered from its transcript, one entry per address, at the first time it
 * appeared.
 */
export type ArchiveKind = "pr" | "issue" | "release" | "doc" | "link" | "text" | "code" | "image" | "file";
export type ArchiveSection = "links" | "files";

export type ArchiveItem = {
  /** One per link (the address) or file (the path); also the pin key. */
  key: string;
  section: ArchiveSection;
  kind: ArchiveKind;
  title: string;
  /** Where it is: `owner/repo · PR #1`, a host, or a folder. */
  where: string;
  /** A GitHub PR's or issue's number, which the sheet labels in its language. */
  num?: string;
  /** Where a file came from: shown, attached, or named in a reply. */
  from?: "shown" | "attached" | "named";
  url?: string;
  path?: string;
  /** The first time it came up, and the line that said it. */
  ts: number;
  msgId: string;
  /** The bot whose chat it came from. */
  agent: string;
};

const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "heic", "avif"]);
const CODE = new Set(["ts", "tsx", "js", "jsx", "rs", "py", "go", "sh", "json", "toml", "yml", "yaml", "css", "html", "sql", "swift", "kt", "java", "c", "cpp", "h"]);
const TEXT = new Set(["md", "txt", "csv", "log", "pdf", "docx", "xlsx", "pptx"]);

/** A query parameter that may hold a credential. Such a link is not kept. */
const SECRET_PARAM = /^(.*[_-])?(token|key|secret|password|passwd|pwd|sig|signature|auth|session|code|credential|jwt)$/i;
/** A path segment long and random enough to be a credential, not a word. */
const SECRET_SEGMENT = /^[A-Za-z0-9_-]{40,}$/;

/**
 * Whether a link could carry a secret: a user name or password in it, a
 * query value named like a token, or a path segment that reads like one.
 * Such links are left out of the archive rather than shown on a sheet.
 */
export function looksSecret(url: URL): boolean {
  if (url.username || url.password) return true;
  for (const key of url.searchParams.keys()) if (SECRET_PARAM.test(key)) return true;
  return url.pathname.split("/").some((part) => SECRET_SEGMENT.test(part) && /\d/.test(part) && /[A-Za-z]/.test(part));
}

/** Fenced code is commands and logs: its addresses are not what the bot pointed at. */
function withoutFences(text: string): string {
  return text.replace(/```[\s\S]*?(```|$)/g, " ").replace(/~~~[\s\S]*?(~~~|$)/g, " ");
}

// A backslash ends it too: a reply that wrote `\n` as two characters.
const URL_RE = /https?:\/\/[^\s<>()[\]"'`\\]+/g;

function trimUrl(raw: string): string {
  return raw.replace(/[.,;:!?)\]}>'"*_]+$/, "");
}

export function linkItem(raw: string): Omit<ArchiveItem, "ts" | "msgId" | "agent"> | null {
  let url: URL;
  try {
    url = new URL(trimUrl(raw));
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (looksSecret(url)) return null;
  url.hash = "";
  const key = url.toString().replace(/\/$/, "");
  const host = url.host.replace(/^www\./, "");
  const parts = url.pathname.split("/").filter(Boolean).map(safeDecode);
  if (host === "github.com" && parts.length >= 4) {
    const repo = `${parts[0]}/${parts[1]}`;
    if (parts[2] === "pull" && /^\d+$/.test(parts[3])) {
      const base = `https://github.com/${repo}/pull/${parts[3]}`;
      return { key: base, section: "links", kind: "pr", title: `${repo} #${parts[3]}`, where: repo, num: parts[3], url: base };
    }
    if (parts[2] === "issues" && /^\d+$/.test(parts[3])) {
      const base = `https://github.com/${repo}/issues/${parts[3]}`;
      return { key: base, section: "links", kind: "issue", title: `${repo} #${parts[3]}`, where: repo, num: parts[3], url: base };
    }
    if (parts[2] === "releases" && parts[3] === "tag" && parts[4]) {
      return { key, section: "links", kind: "release", title: parts[4], where: repo, url: key };
    }
  }
  const last = parts[parts.length - 1];
  const kind: ArchiveKind = /(^|\.)docs?\.|\/docs?\//.test(host + url.pathname) ? "doc" : "link";
  return {
    key,
    section: "links",
    kind,
    title: last ? last : host,
    where: last ? [host, ...parts.slice(0, -1)].join("/") : host,
    url: key,
  };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function extOf(path: string): string {
  const name = path.split("/").pop() || "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function fileItem(path: string, from: ArchiveItem["from"]): Omit<ArchiveItem, "ts" | "msgId" | "agent"> | null {
  const clean = path.replace(/:\d+(:\d+)?$/, "").replace(/\/+$/, "");
  if (!clean.startsWith("/") && !clean.startsWith("~/")) return null;
  const ext = extOf(clean);
  // A folder or a bare command, not a file someone would open again.
  if (!ext) return null;
  const kind: ArchiveKind = IMAGE.has(ext) ? "image" : CODE.has(ext) ? "code" : TEXT.has(ext) ? "text" : "file";
  const cut = clean.lastIndexOf("/");
  return { key: clean, section: "files", kind, title: clean.slice(cut + 1), where: clean.slice(0, cut) || "/", from, path: clean };
}

type Found = Omit<ArchiveItem, "ts" | "msgId" | "agent">;

/** Absolute paths a reply names: in links, pictures, and inline code. */
const MD_TARGET = /!?\[[^\]]*\]\((?:<([^>\n]+)>|([^)\s]+))(?:\s+"[^"]*")?\)/g;
const INLINE_CODE = /`([^`\n]+)`/g;

/** What one message brings up. The same text always gives the same list. */
export function foundIn(m: ChatMessage): Found[] {
  const out: Found[] = [];
  if (m.kind === "file") {
    const item = fileItem(parseFileRef(m.text || "").path, "shown");
    if (item) out.push(item);
    return out;
  }
  const mine = m.role === "user" || m.from === "user";
  const bot = m.role === "assistant";
  if (!mine && !bot) return out;
  const text = withoutFences(m.text || "");
  if (bot) {
    for (const hit of text.matchAll(URL_RE)) {
      const item = linkItem(hit[0]);
      if (item) out.push(item);
    }
  }
  for (const hit of text.matchAll(MD_TARGET)) {
    const local = resolveLocalPath(hit[1] ?? hit[2]);
    const item = local ? fileItem(local, mine ? "attached" : "named") : null;
    if (item) out.push(item);
  }
  if (bot) {
    for (const hit of text.matchAll(INLINE_CODE)) {
      const word = hit[1].trim();
      if (/\s/.test(word)) continue;
      const item = fileItem(parseFileRef(word).path, "named");
      if (item) out.push(item);
    }
  }
  return out;
}

/**
 * What each message brought up, kept by its id and text, so a long chat is
 * read once and a poll that brings the same lines back reads nothing again.
 */
const seen = new Map<string, Found[]>();
const SEEN_MAX = 20_000;

function cachedFound(m: ChatMessage): Found[] {
  const key = `${m.id}\u0000${m.kind ?? ""}\u0000${(m.text || "").length}\u0000${m.text?.slice(-32) ?? ""}`;
  let hit = seen.get(key);
  if (!hit) {
    hit = foundIn(m);
    if (seen.size >= SEEN_MAX) seen.clear();
    seen.set(key, hit);
  }
  return hit;
}

/** Every link and file in `messages` of `agent`, once each, oldest first. */
export function collectArchive(messages: readonly ChatMessage[], agent: string): ArchiveItem[] {
  const byKey = new Map<string, ArchiveItem>();
  for (const m of messages) {
    if (m.queued || m.optimistic) continue;
    for (const f of cachedFound(m)) {
      if (byKey.has(f.key)) continue;
      byKey.set(f.key, { ...f, ts: m.ts, msgId: m.id, agent });
    }
  }
  return [...byKey.values()];
}

/** Several bots' archives as one: the first time any of them said it wins. */
export function mergeArchives(lists: readonly ArchiveItem[][]): ArchiveItem[] {
  const byKey = new Map<string, ArchiveItem>();
  for (const list of lists) {
    for (const item of list) {
      const had = byKey.get(item.key);
      if (!had || item.ts < had.ts) byKey.set(item.key, item);
    }
  }
  return [...byKey.values()];
}

export type ArchiveDay = "today" | "week" | "older";

export function dayOf(ts: number, now: number): ArchiveDay {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (ts >= start.getTime()) return "today";
  if (ts >= start.getTime() - 6 * 86_400_000) return "week";
  return "older";
}

export function matches(item: ArchiveItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const ref = item.num ? `${item.kind} #${item.num}` : "";
  return `${item.title} ${item.where} ${ref} ${item.url ?? ""}`.toLowerCase().includes(q);
}

/** Newest first: what the bot brought up last is what the reader looks for. */
export function newestFirst(items: readonly ArchiveItem[]): ArchiveItem[] {
  return [...items].sort((a, b) => b.ts - a.ts);
}
