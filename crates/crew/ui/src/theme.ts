export type ThemePref = "dark" | "light" | "system";

const KEY = "crew.theme";

export function loadThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
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

export function resolvedTheme(pref: ThemePref): "light" | "dark" {
  if (pref === "system") {
    return window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
  }
  return pref;
}

export function applyTheme(pref: ThemePref) {
  const resolved = resolvedTheme(pref);
  const root = document.documentElement;
  root.dataset.theme = resolved;
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
