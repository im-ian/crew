import { createContext, useContext } from "react";
import type { AgentInfo, ChatMessage } from "./types";

/**
 * A file to show beside the chat, at a line when one was given. A path the
 * bot wrote relative keeps how it wrote it (`rel`) and the folder it works in
 * (`base`), so the file can be looked for there when `path` is a wrong guess.
 */
export type FileTarget = { path: string; line?: number; base?: string; rel?: string };

/** The panel beside the chat, as the thread sees it. */
export type FileOpen = {
  /** Shows `target`. `group` is the files shown with it, each a tab. */
  open: (target: FileTarget, group?: FileTarget[]) => void;
  /** The file the panel shows now. */
  current: FileTarget | null;
};

/** Null where nothing can show a file. */
export const FileOpenContext = createContext<FileOpen | null>(null);

export function useFileOpen(): FileOpen | null {
  return useContext(FileOpenContext);
}

export function sameFile(a: FileTarget | null | undefined, b: FileTarget | null | undefined): boolean {
  return !!a && !!b && a.path === b.path && (a.line ?? 0) === (b.line ?? 0);
}

/**
 * The files shown one after another with the row `id`: file rows with only
 * tool calls between them, since each `crew show` is a tool call of its own.
 */
export function fileRun(messages: readonly ChatMessage[], id: string): ChatMessage[] {
  const at = messages.findIndex((m) => m.id === id);
  if (at < 0) return [];
  const joins = (m: ChatMessage) => m.kind === "file" || m.kind === "tool";
  let start = at;
  while (start > 0 && joins(messages[start - 1])) start--;
  let end = at;
  while (end < messages.length - 1 && joins(messages[end + 1])) end++;
  return messages.slice(start, end + 1).filter((m) => m.kind === "file");
}

/** `path` or `path:12`, the way a file row and `crew show` write it. */
export function parseFileRef(text: string): FileTarget {
  const raw = text.trim();
  const m = raw.match(/^(.*?):(\d+)(?::\d+)?$/);
  if (m && m[1]) return { path: m[1], line: Number(m[2]) };
  return { path: raw };
}

/** The extensions a bare `name.ext` in inline code has to have to read as a file. */
const CODE_EXT = new Set(
  (
    "ts tsx mts cts js jsx mjs cjs rs py go java kt kts swift rb php c h cc cpp hpp cs dart lua " +
    "sh bash zsh html htm css scss json jsonc yaml yml toml md sql graphql gql xml svg txt " +
    "lock env ini conf cfg gradle vue svelte"
  ).split(" "),
);

/**
 * Inline code that names a file: `src/foo.ts`, `src/foo.ts:53`, `~/x/y.rs:10:4`.
 * A bare `name.ext` counts only with a code or text extension, so `config.rs`
 * does and `e.g.` does not. A name that only looks like a file, such as
 * `node.js`, still opens the panel, which then says it is not there. A URL or
 * an `@scope/package` is not a file.
 */
export function codePathRef(code: string): FileTarget | null {
  const raw = code.trim();
  if (!raw || /\s/.test(raw) || raw.includes("://") || raw.startsWith("@")) return null;
  const { path, line } = parseFileRef(raw);
  const name = path.split("/").pop() ?? "";
  const ext = name.match(/\.([A-Za-z0-9]{1,10})$/)?.[1]?.toLowerCase();
  if (!ext && name !== "Dockerfile" && name !== "Makefile") return null;
  if (!/^[\w.~\/-]+$/.test(path)) return null;
  const pathy = path.includes("/") || line !== undefined;
  if (!pathy && !(ext && CODE_EXT.has(ext))) return null;
  return line === undefined ? { path } : { path, line };
}

/** The folder a bot works in, which its relative paths are read from. */
export function workDir(agent: AgentInfo | null | undefined): string | undefined {
  return agent?.work_dir || agent?.cwd || undefined;
}

/** `ref` as a file to open, a relative path read from the bot's folder. */
export function fileTarget(ref: FileTarget, baseDir?: string): FileTarget | null {
  const path = resolveFilePath(ref.path, baseDir);
  if (!path) return null;
  const relative = !ref.path.startsWith("/") && !ref.path.startsWith("~");
  return relative && baseDir ? { ...ref, path, base: baseDir, rel: ref.path.replace(/^\.\//, "") } : { ...ref, path };
}

/** `path` against the bot's folder, or null when it is relative and there is none. */
export function resolveFilePath(path: string, baseDir?: string): string | null {
  if (path.startsWith("/") || path.startsWith("~")) return path;
  if (!baseDir) return null;
  return baseDir.replace(/\/$/, "") + "/" + path.replace(/^\.\//, "");
}

/**
 * The file row that arrived since `seen` was taken, newest last: a bot ran
 * `crew show` while this chat was open. Rows that were there when the chat
 * opened are history, not a request to open them.
 */
export function freshFileRow(
  seen: ReadonlySet<string> | undefined,
  messages: readonly ChatMessage[],
): ChatMessage | null {
  if (!seen) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.kind === "file" && !seen.has(m.id)) return m;
  }
  return null;
}

/** Files a link opens in their own app, as before: pictures, documents, archives. */
const OWN_APP_EXT = new Set(
  (
    "png jpg jpeg gif webp heic heif bmp tiff ico pdf zip gz tgz dmg pkg app " +
    "doc docx xls xlsx ppt pptx key pages numbers sketch fig psd"
  ).split(" "),
);

/**
 * Whether a link to a local `path` opens in the panel. A text or code file
 * does; a folder, or a file with its own app, goes to that app as before.
 */
export function opensInPanel(path: string): boolean {
  const name = path.replace(/\/+$/, "").split("/").pop() ?? "";
  if (path.endsWith("/")) return false;
  if (name === "Dockerfile" || name === "Makefile") return true;
  const ext = name.match(/\.([A-Za-z0-9]{1,10})$/)?.[1]?.toLowerCase();
  return !!ext && !OWN_APP_EXT.has(ext);
}
