import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { PairGate } from "./components/PairGate";
import { LocaleProvider } from "./LocaleContext";
import { installAppZoom } from "./appZoom";
import { api } from "./api";
import { applyCodeFont, applyFont, installNerdFonts, loadCodeFont, loadFont } from "./fontPref";
import { applyFontSize, loadFontSize } from "./fontSize";
import { applyLocale, loadLocale } from "./i18n";
import { blockNativeMenu } from "./nativeMenu";
import { applyTheme, loadThemePref } from "./theme";
import { isWeb } from "./web";
import { loadHomeDir } from "./homeDir";
import { watchViewport } from "./mobile";
import { followLaptopPrefs, mirrorDisplayPrefs } from "./displayPrefs";
import "./styles.css";

applyTheme(loadThemePref());
applyFont(loadFont());
applyCodeFont(loadCodeFont());
void installNerdFonts(() => api.listNerdFonts());
applyFontSize(loadFontSize());
applyLocale(loadLocale());
blockNativeMenu(document);
installAppZoom();
// The laptop's window tells the daemon how it shows chat; a phone follows it.
mirrorDisplayPrefs();
followLaptopPrefs();
// A phone or tablet browser draws edge to edge (viewport-fit=cover) at any
// width: the safe-area rules in styles.css key off this class, and the
// viewport watch tells them when the keyboard is up.
if (isWeb()) {
  document.documentElement.classList.add("is-web");
  watchViewport();
}

// `~/…` in a bot's answer needs the home folder before the first chat draws.
void loadHomeDir().finally(() =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <LocaleProvider>
        {isWeb() ? (
          <PairGate>
            <App />
          </PairGate>
        ) : (
          <App />
        )}
      </LocaleProvider>
    </StrictMode>,
  ),
);
