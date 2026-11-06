/**
 * The text a file dropped on the window types into the composer: each path,
 * space separated. A path with whitespace is quoted so it stays one path.
 */
export function dropPathsText(paths: readonly string[], before = ""): string {
  const text = paths
    .filter(Boolean)
    .map((p) => (/\s/.test(p) ? `"${p}"` : p))
    .join(" ");
  if (!text) return "";
  const gap = before && !/\s$/.test(before) ? " " : "";
  return gap + text + " ";
}
