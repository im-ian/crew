import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  applyLocale,
  loadLocale,
  saveLocale,
  translate,
  type Locale,
  type MessageKey,
  type TFn,
  type Vars,
} from "./i18n";

type LocaleCtx = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: TFn;
};

const Ctx = createContext<LocaleCtx | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(loadLocale);

  useEffect(() => {
    saveLocale(locale);
    applyLocale(locale);
  }, [locale]);

  const t = useCallback<TFn>(
    (key: MessageKey, vars?: Vars) => translate(locale, key, vars),
    [locale],
  );

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
  }, []);

  const value = useMemo(
    () => ({ locale, setLocale, t }),
    [locale, setLocale, t],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLocale(): LocaleCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useLocale needs LocaleProvider");
  return ctx;
}

export function useT(): TFn {
  return useLocale().t;
}
