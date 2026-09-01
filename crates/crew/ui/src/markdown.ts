import { convertFileSrc } from "@tauri-apps/api/core";

export function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, "$1<em>$2</em>");
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img alt="$1" src="$2" />');
  s = s.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+|file:\/\/[^)\s]+|\/[^)\s]+|\.\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
  );
  const lines = s.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^%%FENCE(\d+)%%$/);
    if (fence) {
      out.push(fences[Number(fence[1])] || "");
      i += 1;
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const n = heading[1].length;
      out.push("<h" + n + ">" + heading[2] + "</h" + n + ">");
      i += 1;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push("<li>" + lines[i].replace(/^\s*[-*]\s+/, "") + "</li>");
        i += 1;
      }
      out.push("<ul>" + items.join("") + "</ul>");
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push("<li>" + lines[i].replace(/^\s*\d+\.\s+/, "") + "</li>");
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
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,3})\s+/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^%%FENCE\d+%%$/.test(lines[i])
    ) {
      para.push(lines[i]);
      i += 1;
    }
    out.push("<p>" + para.join("<br>") + "</p>");
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
