import { EN, KO, type MessageKey } from "./locales";

export type Locale = "ko" | "en";
export type { MessageKey };
export type Vars = Record<string, string | number>;
export type TFn = (key: MessageKey, vars?: Vars) => string;

const KEY = "crew.locale";

const DICTS: Record<Locale, { [K in MessageKey]: string }> = { ko: KO, en: EN };

export function loadLocale(): Locale {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "en" || v === "ko") return v;
  } catch {
    /* private mode */
  }
  return "ko";
}

export function saveLocale(locale: Locale) {
  try {
    localStorage.setItem(KEY, locale);
  } catch {
    /* private mode */
  }
}

export function applyLocale(locale: Locale) {
  document.documentElement.lang = locale === "en" ? "en" : "ko";
}

export function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) =>
    vars[name] === undefined ? `{${name}}` : String(vars[name]),
  );
}

export function translate(locale: Locale, key: MessageKey, vars?: Vars): string {
  const table = DICTS[locale] ?? DICTS.ko;
  return interpolate(table[key] ?? DICTS.ko[key] ?? key, vars);
}
