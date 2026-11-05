export type ThemePref = "dark" | "light" | "system" | "glass";

const KEY = "crew.theme";

export function parseThemePref(v: string | null): ThemePref {
  if (v === "light" || v === "dark" || v === "system" || v === "glass") return v;
  return "dark";
}

export function loadThemePref(): ThemePref {
  try {
    return parseThemePref(localStorage.getItem(KEY));
  } catch {
    /* private mode */
  }
  return "dark";
}

export function saveThemePref(pref: ThemePref) {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* private mode */
  }
}

/** Glass is the dark palette with its panes cleared, so it resolves to dark. */
export function resolvedTheme(pref: ThemePref): "light" | "dark" {
  if (pref === "system") {
    return window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
  }
  return pref === "light" ? "light" : "dark";
}

export function applyTheme(pref: ThemePref) {
  const resolved = resolvedTheme(pref);
  const root = document.documentElement;
  root.dataset.theme = resolved;
  // Glass clears the panes so the window's material (tauri.conf.json
  // windowEffects) shows through.
  if (pref === "glass") root.dataset.glass = "";
  else delete root.dataset.glass;
  root.style.colorScheme = resolved;
  void syncWindowTheme(pref, resolved);
}

async function syncWindowTheme(pref: ThemePref, resolved: "light" | "dark") {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setTheme(pref === "system" ? null : resolved);
  } catch {
    /* browser preview */
  }
}
