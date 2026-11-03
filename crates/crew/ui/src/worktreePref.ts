const KEY = "crew.worktree";

/** Off unless the stored value is exactly "on". A first launch keeps the shared folder. */
export function worktreesEnabled(stored: string | null): boolean {
  return stored === "on";
}

export function loadWorktree(): boolean {
  try {
    return worktreesEnabled(localStorage.getItem(KEY));
  } catch {
    return false;
  }
}

export function saveWorktree(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    /* private mode */
  }
}
