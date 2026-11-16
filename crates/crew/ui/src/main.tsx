import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { LocaleProvider } from "./LocaleContext";
import { installAppZoom } from "./appZoom";
import { applyFont, loadFont } from "./fontPref";
import { applyFontSize, loadFontSize } from "./fontSize";
import { applyLocale, loadLocale } from "./i18n";
import { blockNativeMenu } from "./nativeMenu";
import { applyTheme, loadThemePref } from "./theme";
import "./styles.css";

applyTheme(loadThemePref());
applyFont(loadFont());
applyFontSize(loadFontSize());
applyLocale(loadLocale());
blockNativeMenu(document);
installAppZoom();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LocaleProvider>
      <App />
    </LocaleProvider>
  </StrictMode>,
);
