import { convertFileSrc } from "@tauri-apps/api/core";
import katex from "katex";
import MarkdownIt, { type Env, type StateBlock, type StateInline, type Token } from "markdown-it";

// `html: false` keeps a bot's tags as text; `breaks` keeps each typed line its own line.
const md = new MarkdownIt({ breaks: true, linkify: true });
// `README.md` and `main.rs` end in real TLDs, so only link what carries a scheme.
md.linkify.set({ fuzzyLink: false, fuzzyEmail: false });

// Bots link files on this machine, and the bubble opens them itself.
const validateLink = md.validateLink.bind(md);
md.validateLink = (url) => /^file:/i.test(url.trim()) || validateLink(url);
// A path stays as written, so `resolveLocalPath` gets the file's real name.
const normalizeLink = md.normalizeLink.bind(md);
md.normalizeLink = (url) =>
  /^[a-z][a-z0-9+.-]*:/i.test(url) && !/^file:/i.test(url) ? normalizeLink(url) : url;

// The bubble's copy button and empty-output check read the block's text, so it
// carries no trailing newline. `md-out` comes from the command rule below.
md.renderer.rules.fence = md.renderer.rules.code_block = (tokens, i) => {
  const cls = tokens[i].attrGet("class");
  return (
    "<pre" + (cls ? ' class="' + cls + '"' : "") + "><code>" +
    md.utils.escapeHtml(tokens[i].content.replace(/\n$/, "")) +
    "</code></pre>\n"
  );
};

// A paragraph that is nothing but inline code, directly above a block, is the
// command that produced it; mark the pair so the bubble can label them.
md.core.ruler.push("command_output", (state) => {
  const t = state.tokens;
  for (let i = 3; i < t.length; i++) {
    const kids = t[i - 2].children;
    // A tight list item hides its paragraph tag, so the command can't be marked.
    if (
      t[i].type === "fence" &&
      t[i - 3].type === "paragraph_open" &&
      !t[i - 3].hidden &&
      t[i - 3].level === t[i].level &&
      kids?.length === 1 &&
      kids[0].type === "code_inline"
    ) {
      t[i - 3].attrJoin("class", "md-cmd");
      t[i].attrJoin("class", "md-out");
    }
  }
});

// `- [ ]` and `- [x]` items are a checklist.
md.core.ruler.push("task_list", (state) => {
  const t = state.tokens;
  for (let i = 2; i < t.length; i++) {
    const first = t[i].children?.[0];
    const box = first?.type === "text" && /^\[([ xX])\]\s+/.exec(first.content);
    if (t[i].type !== "inline" || t[i - 2].type !== "list_item_open" || !box) continue;
    first.content = first.content.slice(box[0].length);
    const input = new state.Token("html_inline", "", 0);
    input.content = '<input type="checkbox" disabled' + (box[1] === " " ? "" : " checked") + ">";
    t[i].children!.unshift(input);
    t[i - 2].attrJoin("class", "md-task");
  }
});

// `<br>` is the one tag a bot uses to break a line, often in a table cell.
// Every other tag stays text.
const BR = /<br\s*\/?>/iy;
md.inline.ruler.before("html_inline", "br", (state, silent) => {
  BR.lastIndex = state.pos;
  if (!BR.test(state.src)) return false;
  if (!silent) state.push("hardbreak", "br", 0);
  state.pos = BR.lastIndex;
  return true;
});

// Math. `$5 and $10` is money and `$HOME/$USER` is shell, not a formula: the
// opening `$` touches its formula, and the closing one touches it too and is
// not followed by a letter or digit. A formula never runs into a code span.
const MATH_INLINE = /\$\$([^$]+?)\$\$|\$(?=\S)((?:\\.|[^\\$`])*?[^\s`])\$(?!\w)/y;
md.inline.ruler.after("escape", "math_inline", (state, silent) => {
  if (state.src.charCodeAt(state.pos) !== 0x24 /* $ */) return false;
  MATH_INLINE.lastIndex = state.pos;
  const m = MATH_INLINE.exec(state.src);
  if (!m) return false;
  if (!silent) {
    const t = state.push("math_inline", "", 0);
    t.content = m[1] ?? m[2];
    t.markup = m[1] === undefined ? "$" : "$$";
  }
  state.pos = MATH_INLINE.lastIndex;
  return true;
});

function mathBlock(state: StateBlock, startLine: number, endLine: number, silent: boolean) {
  const lineText = (n: number) =>
    state.src.slice(state.bMarks[n] + state.tShift[n], state.eMarks[n]).trimEnd();
  const first = lineText(startLine);
  if (state.sCount[startLine] - state.blkIndent >= 4 || !first.startsWith("$$")) return false;
  let last = startLine;
  let body: string;
  if (first.length > 4 && first.endsWith("$$")) {
    body = first.slice(2, -2);
  } else {
    // A `$$` with no closing line before a blank one is text, so a stray one
    // can't swallow the paragraphs after it.
    do last += 1;
    while (last < endLine && !state.isEmpty(last) && !lineText(last).endsWith("$$"));
    if (last >= endLine || state.isEmpty(last)) return false;
    body = [
      first.slice(2),
      state.getLines(startLine + 1, last, state.tShift[startLine], false),
      lineText(last).slice(0, -2),
    ].join("\n");
  }
  if (silent) return true;
  const t = state.push("math_block", "div", 0);
  t.content = body.trim();
  t.map = [startLine, last + 1];
  t.block = true;
  state.line = last + 1;
  return true;
}
md.block.ruler.before("fence", "math_block", mathBlock, {
  alt: ["paragraph", "reference", "blockquote", "list"],
});

function tex(src: string, displayMode: boolean): string {
  try {
    return katex.renderToString(src, { displayMode, throwOnError: false });
  } catch {
    return md.utils.escapeHtml(src);
  }
}
md.renderer.rules.math_inline = (tokens, i) =>
  '<span class="md-math">' + tex(tokens[i].content, tokens[i].markup === "$$") + "</span>";
md.renderer.rules.math_block = (tokens, i) =>
  '<div class="md-math md-math-block">' + tex(tokens[i].content, true) + "</div>\n";

// Footnotes. A balloon is too short to gather notes at its foot, so a note
// stays where it was written and takes the number of its first reference.
type Notes = { defined: Record<string, true>; num: Record<string, number>; count: number };
const notes = (env: Env): Notes => (env.notes ??= { defined: {}, num: {}, count: 0 }) as Notes;
const noteNum = (env: Env | undefined, token: Token) => {
  const label = (token.meta as { label: string }).label;
  return String(notes(env ?? {}).num[label] ?? md.utils.escapeHtml(label));
};

const NOTE_DEF = /\[\^([^\]\s]+)\]:[ \t]*/y;
function footnoteDef(state: StateBlock, startLine: number, endLine: number, silent: boolean) {
  NOTE_DEF.lastIndex = state.bMarks[startLine] + state.tShift[startLine];
  const m = NOTE_DEF.exec(state.src);
  if (!m || state.sCount[startLine] - state.blkIndent >= 4) return false;
  if (silent) return true;
  // Read before the checks below run this rule again and move `lastIndex`.
  const first = state.src.slice(NOTE_DEF.lastIndex, state.eMarks[startLine]);
  // The note runs on as a paragraph does, until a blank line or another block.
  const terminators = state.md.block.ruler.getRules("paragraph");
  const parentType = state.parentType;
  state.parentType = "paragraph";
  let last = startLine + 1;
  for (; last < endLine && !state.isEmpty(last); last++) {
    if (state.sCount[last] - state.blkIndent > 3) continue;
    if (terminators.some((rule) => rule(state, last, endLine, true))) break;
  }
  state.parentType = parentType;
  notes(state.env).defined[m[1]] = true;
  const open = state.push("footnote_open", "p", 1);
  open.meta = { label: m[1] };
  open.map = [startLine, last];
  const inline = state.push("inline", "", 0);
  inline.content = (
    first +
    "\n" +
    state.getLines(startLine + 1, last, state.blkIndent, false)
  ).trim();
  inline.map = open.map;
  inline.children = [];
  state.push("footnote_close", "p", -1);
  state.line = last;
  return true;
}
md.block.ruler.before("reference", "footnote_def", footnoteDef, {
  alt: ["paragraph", "reference"],
});

const NOTE_REF = /\[\^([^\]\s]+)\]/y;
function footnoteRef(state: StateInline, silent: boolean) {
  NOTE_REF.lastIndex = state.pos;
  const m = state.src.charCodeAt(state.pos + 1) === 0x5e /* ^ */ && NOTE_REF.exec(state.src);
  if (!m || !notes(state.env).defined[m[1]]) return false;
  if (!silent) {
    const n = notes(state.env);
    n.num[m[1]] ??= ++n.count;
    state.push("footnote_ref", "sup", 0).meta = { label: m[1] };
  }
  state.pos = NOTE_REF.lastIndex;
  return true;
}
md.inline.ruler.before("link", "footnote_ref", footnoteRef);

md.renderer.rules.footnote_ref = (tokens, i, _o, env) =>
  '<sup class="md-fnref">' + noteNum(env, tokens[i]) + "</sup>";
md.renderer.rules.footnote_open = (tokens, i, _o, env) =>
  '<p class="md-footnote"><sup>' + noteNum(env, tokens[i]) + "</sup> ";
md.renderer.rules.footnote_close = () => "</p>\n";

// Several pictures in a row are one album. A single picture stays in its
// paragraph so it keeps its own shape.
function imagesOnly(token: Token): Token[] | null {
  if (token.type !== "inline" || !token.children?.length) return null;
  const images: Token[] = [];
  for (const child of token.children) {
    if (child.type === "image") images.push(child);
    else if (child.type === "softbreak" || child.type === "hardbreak") continue;
    else if (child.type === "text" && child.content.trim() === "") continue;
    else return null;
  }
  return images.length ? images : null;
}

function paragraphImages(tokens: Token[], index: number): { images: Token[]; next: number } | null {
  if (tokens[index]?.type !== "paragraph_open") return null;
  if (tokens[index + 1]?.type !== "inline") return null;
  if (tokens[index + 2]?.type !== "paragraph_close") return null;
  const images = imagesOnly(tokens[index + 1]);
  if (!images) return null;
  return { images, next: index + 3 };
}

md.core.ruler.after("inline", "image_gallery", (state) => {
  const src = state.tokens;
  const out: Token[] = [];
  for (let i = 0; i < src.length; ) {
    const first = paragraphImages(src, i);
    if (!first) {
      out.push(src[i]);
      i += 1;
      continue;
    }
    let run = first.images;
    let next = first.next;
    for (;;) {
      const more = paragraphImages(src, next);
      if (!more) break;
      run = run.concat(more.images);
      next = more.next;
    }
    if (run.length < 2) {
      out.push(src[i]);
      i += 1;
      continue;
    }
    const layout = run.length === 2 ? "pair" : run.length === 3 ? "trio" : "grid";
    const open = new state.Token("image_gallery_open", "div", 1);
    open.block = true;
    open.attrSet("class", `md-gallery is-${layout}`);
    open.attrSet("data-count", String(run.length));
    out.push(open);
    for (const image of run) out.push(image);
    const close = new state.Token("image_gallery_close", "div", -1);
    close.block = true;
    out.push(close);
    i = next;
  }
  state.tokens = out;
});

md.renderer.rules.image_gallery_open = (tokens, idx, options, _env, self) =>
  self.renderToken(tokens, idx, options);
md.renderer.rules.image_gallery_close = (tokens, idx, options, _env, self) =>
  self.renderToken(tokens, idx, options);

const DEFINITION = /^ {0,3}\[[^\]]+\]:/m;

/**
 * A message's link and footnote definitions and footnote numbers, for its
 * balloons to share, or "" when it defines none. It is a string so a balloon
 * renders again only when they change, not on every streamed token.
 */
export function messageDefinitions(source: string): string {
  if (!DEFINITION.test(source)) return "";
  const env: Env = {};
  md.parse(source, env);
  return JSON.stringify(env);
}

/** `defs` is `messageDefinitions` of the whole message `text` is a balloon of. */
export function renderMarkdown(text: string, defs = ""): string {
  return md.render(String(text || ""), defs ? JSON.parse(defs) : {});
}

export function resolveLocalPath(src: string, baseDir?: string): string | null {
  const s = src.trim();
  if (!s || s.startsWith("#")) return null;
  // Any scheme but `file:` (http, data, blob, mailto, asset, tauri...) is not
  // a path. `C:\` is a drive, not a scheme.
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^file:/i.test(s) && !/^[A-Za-z]:[\\/]/.test(s)) {
    return null;
  }
  let path = s;
  if (path.startsWith("file://")) {
    path = decodeURIComponent(path.slice("file://".length).replace(/^localhost/i, ""));
  }
  if (path.startsWith("~")) {
    return path;
  }
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) {
    return path;
  }
  if (baseDir) {
    const rel = path.replace(/^\.\//, "");
    return baseDir.replace(/\/$/, "") + "/" + rel;
  }
  return null;
}

export function mediaSrc(src: string, baseDir?: string): string {
  const local = resolveLocalPath(src, baseDir);
  if (!local) return src;
  const path = local.startsWith("~") ? local : local;
  try {
    return convertFileSrc(path);
  } catch {
    return src;
  }
}

export function isLocalHref(href: string, baseDir?: string): boolean {
  return resolveLocalPath(href, baseDir) !== null;
}
