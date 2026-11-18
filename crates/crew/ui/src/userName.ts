const KEY = "crew.user-name";
/** Same cap as the daemon's, so the app and the bots see one name. */
const MAX = 40;

/** The typed name as one trimmed line, or empty when nothing is typed. */
export function cleanUserName(input: string): string {
  const line = input
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
  return Array.from(line).slice(0, MAX).join("").trim();
}

/** What the field holds, as typed. */
export function loadUserName(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveUserName(input: string) {
  try {
    if (input.trim()) localStorage.setItem(KEY, input);
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode */
  }
}
