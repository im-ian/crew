// Syntax colors for the file panel. Shiki with its plain-JS regex engine, one
// grammar loaded the first time a file of that language opens.
import { createHighlighterCore, type HighlighterCore } from "@shikijs/core";
import {
  createJavaScriptRegexEngine,
  defaultJavaScriptRegexConstructor,
} from "@shikijs/engine-javascript";

const LANGS = {
  bash: () => import("@shikijs/langs/bash"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  csharp: () => import("@shikijs/langs/csharp"),
  css: () => import("@shikijs/langs/css"),
  dart: () => import("@shikijs/langs/dart"),
  docker: () => import("@shikijs/langs/docker"),
  go: () => import("@shikijs/langs/go"),
  graphql: () => import("@shikijs/langs/graphql"),
  html: () => import("@shikijs/langs/html"),
  java: () => import("@shikijs/langs/java"),
  javascript: () => import("@shikijs/langs/javascript"),
  json: () => import("@shikijs/langs/json"),
  jsonc: () => import("@shikijs/langs/jsonc"),
  jsx: () => import("@shikijs/langs/jsx"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  lua: () => import("@shikijs/langs/lua"),
  make: () => import("@shikijs/langs/make"),
  markdown: () => import("@shikijs/langs/markdown"),
  php: () => import("@shikijs/langs/php"),
  python: () => import("@shikijs/langs/python"),
  ruby: () => import("@shikijs/langs/ruby"),
  rust: () => import("@shikijs/langs/rust"),
  scss: () => import("@shikijs/langs/scss"),
  sql: () => import("@shikijs/langs/sql"),
  swift: () => import("@shikijs/langs/swift"),
  toml: () => import("@shikijs/langs/toml"),
  tsx: () => import("@shikijs/langs/tsx"),
  typescript: () => import("@shikijs/langs/typescript"),
  xml: () => import("@shikijs/langs/xml"),
  yaml: () => import("@shikijs/langs/yaml"),
};

export type Lang = keyof typeof LANGS;

const EXT_LANG: Record<string, Lang> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  rs: "rust",
  py: "python",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  rb: "ruby",
  php: "php",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  dart: "dart",
  lua: "lua",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  json: "json",
  jsonc: "jsonc",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  md: "markdown",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  xml: "xml",
  svg: "xml",
};

const NAME_LANG: Record<string, Lang> = {
  Dockerfile: "docker",
  Makefile: "make",
};

/** The grammar a file's name asks for, or null for plain text. */
export function langFor(path: string): Lang | null {
  const name = path.split(/[\\/]/).pop() ?? "";
  if (NAME_LANG[name]) return NAME_LANG[name];
  const m = name.match(/\.([A-Za-z0-9]+)$/);
  return m ? EXT_LANG[m[1].toLowerCase()] ?? null : null;
}

/**
 * A grammar's pattern as a JS regex WebKit reads right. Shiki's default turns
 * TextMate `^` into a bare `^`, and JavaScriptCore then anchors the whole
 * pattern at the start even when the `^` sits in an optional group: the
 * JS/TS line-comment rule `(^[\t ]+)?(//)` stops matching a `//` after code,
 * and a backtick in that comment opens a template string that colors the rest
 * of the file. `singleline: false` writes `^` as `(?<=^|\n)` instead, which
 * JSC scans correctly. Shiki tokenizes one line at a time, so the two mean
 * the same here. https://bugs.webkit.org/show_bug.cgi?id=216671
 * Acorn carries the same fix (its #665).
 */
export function compileGrammarRegex(pattern: string): RegExp {
  return defaultJavaScriptRegexConstructor(pattern, {
    target: "auto",
    rules: {
      allowOrphanBackrefs: true,
      asciiWordBoundaries: true,
      captureGroup: true,
      recursionLimit: 5,
      singleline: false,
    },
  });
}

/** One run of a line in one color per theme. */
export type Token = { text: string; dark?: string; light?: string };

let core: Promise<HighlighterCore> | null = null;
const loaded = new Map<Lang, Promise<boolean>>();

function highlighter(): Promise<HighlighterCore> {
  core ??= createHighlighterCore({
    themes: [import("@shikijs/themes/github-dark"), import("@shikijs/themes/github-light-high-contrast")],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true, regexConstructor: compileGrammarRegex }),
  });
  return core;
}

function ensureLang(h: HighlighterCore, lang: Lang): Promise<boolean> {
  let pending = loaded.get(lang);
  if (!pending) {
    pending = LANGS[lang]()
      .then((mod) => h.loadLanguage(mod.default))
      .then(() => true)
      .catch(() => false);
    loaded.set(lang, pending);
  }
  return pending;
}

/**
 * `text` split into lines of colored runs, for both themes at once. Null when
 * there is no grammar for it or loading one failed; the panel shows it plain.
 */
export async function highlightLines(text: string, lang: Lang): Promise<Token[][] | null> {
  try {
    const h = await highlighter();
    if (!(await ensureLang(h, lang))) return null;
    const lines = h.codeToTokensWithThemes(text, {
      lang,
      themes: { dark: "github-dark", light: "github-light-high-contrast" },
      // The first line of a file waits on the grammar's regexes compiling,
      // which on WebKit can pass Shiki's 500ms a line; past it the rest of
      // the line goes uncolored. A long line is cut short instead.
      tokenizeTimeLimit: 0,
      tokenizeMaxLineLength: 2000,
    });
    return lines.map((line) =>
      line.map((t) => ({
        text: t.content,
        dark: t.variants.dark?.color,
        light: t.variants.light?.color,
      })),
    );
  } catch {
    return null;
  }
}
