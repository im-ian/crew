import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { LocaleProvider } from "./LocaleContext";
import { applyFont, loadFont } from "./fontPref";
import { applyLocale, loadLocale } from "./i18n";
import { blockNativeMenu } from "./nativeMenu";
import { applyTheme, loadThemePref } from "./theme";
import "./styles.css";

applyTheme(loadThemePref());
applyFont(loadFont());
applyLocale(loadLocale());
blockNativeMenu(document);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LocaleProvider>
      <App />
    </LocaleProvider>
  </StrictMode>,
);
