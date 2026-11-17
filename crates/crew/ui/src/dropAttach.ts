import { mediaKind, type MediaKind } from "./markdown";

/** What a path dropped from Finder is, as `path_kinds` tells it. */
export type PathKind = "dir" | "file" | "missing";

/** A dropped path as an attachment: the file or folder where it sits. */
export type DroppedAttach = {
  name: string;
  path: string;
  image: boolean;
  media?: MediaKind;
  dir?: true;
};

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "heic", "heif", "tif", "tiff"]);

/** The last part of a path, a trailing slash aside. */
export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const at = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return (at >= 0 ? trimmed.slice(at + 1) : trimmed) || path;
}

/**
 * The attachments for paths dropped on the window. Nothing is copied: each
 * keeps its path, so the bot reads it where it sits. A folder stays a
 * folder; a picture or a clip is told by its extension. A path that is gone,
 * empty, or already attached (`have`) is left out, and so is a repeat.
 */
export function droppedAttaches(
  paths: readonly string[],
  kinds: readonly PathKind[],
  have: readonly string[] = [],
): DroppedAttach[] {
  const seen = new Set(have);
  const out: DroppedAttach[] = [];
  paths.forEach((path, i) => {
    const kind = kinds[i] ?? "file";
    if (!path || kind === "missing" || seen.has(path)) return;
    seen.add(path);
    const name = baseName(path);
    if (kind === "dir") {
      out.push({ name, path, image: false, dir: true });
      return;
    }
    const media = mediaKind(name) ?? undefined;
    const ext = name.match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase() ?? "";
    out.push({ name, path, image: !media && IMAGE_EXT.has(ext), ...(media ? { media } : null) });
  });
  return out;
}
