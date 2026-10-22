import { convertFileSrc } from "@tauri-apps/api/core";

export function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** A row's cells; `\|` is a literal pipe, not a column break. */
function tableCells(line: string): string[] {
  return line
    .replace(/\\\|/g, "\u0000")
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.replace(/\u0000/g, "|").trim());
}

/** A header row is only a table when a delimiter row with as many cells sits under it. */
function isTableStart(lines: string[], i: number): boolean {
  const head = lines[i];
  const sep = lines[i + 1];
  return (
    sep !== undefined &&
    head.includes("|") &&
    sep.includes("|") &&
    TABLE_SEP.test(sep) &&
    tableCells(head).length === tableCells(sep).length
  );
}

/** A line that opens a block of its own, so it ends a paragraph or a table above it. */
function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i];
  return (
    /^(#{1,3})\s+/.test(line) ||
    /^\s*[-*]\s+/.test(line) ||
    /^\s*\d+\.\s+/.test(line) ||
    /^%%FENCE\d+%%$/.test(line) ||
    isTableStart(lines, i)
  );
}

/** Code spans, emphasis, images and links, applied to one block's text at a time. */
function renderInline(s: string): string {
  // Set inline code aside like fences, or `a_b` and `c_d` italicise across spans.
  const spans: string[] = [];
  s = s.replace(/`([^`]+)`/g, (_, code) => {
    spans.push("<code>" + code + "</code>");
    return "\u0000" + (spans.length - 1) + "\u0000";
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, "$1<em>$2</em>");
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img alt="$1" src="$2" />');
  s = s.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+|file:\/\/[^)\s]+|\/[^)\s]+|\.\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
  );
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => spans[Number(i)]);
}

export function renderMarkdown(raw: string): string {
  const fences: string[] = [];
  let s = String(raw || "").replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code) => {
    const i = fences.length;
    fences.push(
      "<pre><code>" + escapeHtml(String(code).replace(/\n$/, "")) + "</code></pre>",
    );
    return "\n%%FENCE" + i + "%%\n";
  });
  s = escapeHtml(s);
  // Blocks first, then each block's own text: markup can't run across a cell,
  // a list item or a paragraph.
  const lines = s.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^%%FENCE(\d+)%%$/);
    if (fence) {
      const block = fences[Number(fence[1])] || "";
      const prev = out[out.length - 1];
      // A line that is nothing but inline code, directly above a block, is the
      // command that produced it; mark the pair so the bubble can label them.
      if (prev && /^<p><code>[^<]*<\/code><\/p>$/.test(prev)) {
        out[out.length - 1] = prev.replace("<p>", '<p class="md-cmd">');
        out.push(block.replace("<pre>", '<pre class="md-out">'));
      } else {
        out.push(block);
      }
      i += 1;
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const n = heading[1].length;
      out.push("<h" + n + ">" + renderInline(heading[2]) + "</h" + n + ">");
      i += 1;
      continue;
    }
    if (isTableStart(lines, i)) {
      const aligns = tableCells(lines[i + 1]).map((c) =>
        /^:-+:$/.test(c) ? ' class="md-center"' : /-:$/.test(c) ? ' class="md-right"' : "",
      );
      const row = (cells: string[], tag: string) =>
        "<tr>" +
        aligns.map((a, j) => "<" + tag + a + ">" + renderInline(cells[j] ?? "") + "</" + tag + ">").join("") +
        "</tr>";
      const head = row(tableCells(line), "th");
      i += 2;
      const body: string[] = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        lines[i].includes("|") &&
        !startsBlock(lines, i)
      ) {
        body.push(row(tableCells(lines[i]), "td"));
        i += 1;
      }
      out.push(
        "<table><thead>" + head + "</thead>" +
          (body.length ? "<tbody>" + body.join("") + "</tbody>" : "") +
          "</table>",
      );
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push("<li>" + renderInline(lines[i].replace(/^\s*[-*]\s+/, "")) + "</li>");
        i += 1;
      }
      out.push("<ul>" + items.join("") + "</ul>");
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push("<li>" + renderInline(lines[i].replace(/^\s*\d+\.\s+/, "")) + "</li>");
        i += 1;
      }
      out.push("<ol>" + items.join("") + "</ol>");
      continue;
    }
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const para = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) {
      para.push(lines[i]);
      i += 1;
    }
    out.push("<p>" + renderInline(para.join("\n")).replace(/\n/g, "<br>") + "</p>");
  }
  return out.join("");
}

export function resolveLocalPath(src: string, baseDir?: string): string | null {
  const s = src.trim();
  if (!s) return null;
  if (
    s.startsWith("data:") ||
    s.startsWith("blob:") ||
    s.startsWith("http://") ||
    s.startsWith("https://") ||
    s.startsWith("asset:") ||
    s.startsWith("tauri://")
  ) {
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
