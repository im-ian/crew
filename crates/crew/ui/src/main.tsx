import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { LocaleProvider } from "./LocaleContext";
import { applyLocale, loadLocale } from "./i18n";
import { applyTheme, loadThemePref } from "./theme";
import "./styles.css";

applyTheme(loadThemePref());
applyLocale(loadLocale());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LocaleProvider>
      <App />
    </LocaleProvider>
  </StrictMode>,
);
