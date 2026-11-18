import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api } from "./api";
import {
  applyLocale,
  loadLocale,
  makeT,
  saveLocale,
  type Locale,
  type TFn,
} from "./i18n";
import { cleanUserName, loadUserName, saveUserName } from "./userName";

type LocaleCtx = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  /** The name field as typed. Empty means "나" / "You". */
  userName: string;
  setUserName: (name: string) => void;
  t: TFn;
};

const Ctx = createContext<LocaleCtx | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(loadLocale);

  useEffect(() => {
    saveLocale(locale);
    applyLocale(locale);
    // The daemon writes notifications while the window is closed, so it needs the
    // same language.
    void api.setLocale(locale).catch(() => {});
  }, [locale]);

  const [userName, setUserNameState] = useState(loadUserName);
  const name = cleanUserName(userName);

  useEffect(() => {
    saveUserName(userName);
  }, [userName]);

  useEffect(() => {
    // Bots read it from the daemon, so their next turn can call the user by it.
    void api.setUserName(name).catch(() => {});
  }, [name]);

  const t = useMemo<TFn>(() => makeT(locale, name), [locale, name]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
  }, []);

  const setUserName = useCallback((next: string) => {
    setUserNameState(next);
  }, []);

  const value = useMemo(
    () => ({ locale, setLocale, userName, setUserName, t }),
    [locale, setLocale, userName, setUserName, t],
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
