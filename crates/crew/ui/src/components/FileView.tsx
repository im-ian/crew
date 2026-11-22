import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { FileTarget } from "../fileRef";
import type { Token } from "../highlight";
import { ExternalLink, FileText, ImageIcon, X } from "../icons";
import { useT } from "../LocaleContext";
import type { MessageKey } from "../locales";
import { isPictureHref, mediaKind, missingReason } from "../markdown";
import { fileSrc } from "../transport";
import type { TextFile } from "../types";
import { SidePane } from "./SidePane";

/** Past this many lines a file shows plain: coloring it would hold up the panel. */
const HIGHLIGHT_MAX_LINES = 5000;

type Loaded =
  | { state: "loading" }
  | { state: "ok"; file: TextFile }
  | { state: "error"; key: MessageKey };

/** What `read_text_file` refused, as a sentence. */
export function fileErrorKey(err: unknown): MessageKey {
  const msg = String(err);
  if (msg.startsWith("not found")) return "file.notFound";
  if (msg.startsWith("folder")) return "file.folder";
  if (msg.startsWith("binary")) return "file.binary";
  return "file.failed";
}

/** A file's lines. A last newline ends the last line; it does not start one. */
export function fileLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** `/Users/me/x/y.ts` as its name and the folder it sits in, home as `~`. */
export function splitFilePath(path: string): { name: string; dir: string } {
  const at = path.lastIndexOf("/");
  const name = at < 0 ? path : path.slice(at + 1);
  const dir = at < 0 ? "" : path.slice(0, at);
  return { name, dir: dir.replace(/^\/Users\/[^/]+/, "~") };
}

/**
 * What `crew show` of a picture or a video opens: a viewer, not its bytes as
 * text. An svg is a script that draws, so it is not one (#371).
 */
export function fileMedia(path: string): "image" | "video" | null {
  if (isPictureHref(path)) return "image";
  return mediaKind(path) === "video" ? "video" : null;
}

/** A picture or a video, fitted to the panel. Where it did not load, why. */
function FileMedia({ kind, path }: { kind: "image" | "video"; path: string }) {
  const t = useT();
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [path]);
  if (failed) {
    const key = missingReason(path) === "hidden" ? "file.hiddenAt" : "file.missingAt";
    return <p className="file-state">{t(key, { path })}</p>;
  }
  const src = fileSrc(path);
  return kind === "image" ? (
    <img className="file-media" src={src} alt={splitFilePath(path).name} onError={() => setFailed(true)} />
  ) : (
    // No autoplay: the first frame and the player's own play button.
    <video
      className="file-media"
      src={src.includes("#") ? src : `${src}#t=0.1`}
      controls
      playsInline
      preload="metadata"
      onError={() => setFailed(true)}
    />
  );
}

/**
 * Text or code files beside the chat, colored, each opened at its line. Files
 * a bot showed together are tabs; `at` is the one shown.
 */
export function FileView({
  files,
  at,
  onPick,
  onCloseTab,
  onClose,
}: {
  files: FileTarget[];
  at: number;
  onPick: (at: number) => void;
  /** Drops tab `at` from the panel. The file row in the thread stays. */
  onCloseTab: (at: number) => void;
  onClose: () => void;
}) {
  const t = useT();
  const target = files[at] ?? files[0];
  const bodyRef = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [tokens, setTokens] = useState<Token[][] | null>(null);
  const [flashing, setFlashing] = useState(false);
  const media = fileMedia(target.path);

  useEffect(() => {
    if (media) return;
    let gone = false;
    setLoaded({ state: "loading" });
    setTokens(null);
    api
      .readTextFile(target.path, target.base && target.rel ? { base: target.base, rel: target.rel } : undefined)
      .then((file) => !gone && setLoaded({ state: "ok", file }))
      .catch((err) => !gone && setLoaded({ state: "error", key: fileErrorKey(err) }));
    return () => {
      gone = true;
    };
  }, [target.path, target.base, target.rel, media]);

  const file = !media && loaded.state === "ok" ? loaded.file : null;
  const lines = useMemo(() => (file ? fileLines(file.text) : []), [file]);

  useEffect(() => {
    if (!file || lines.length > HIGHLIGHT_MAX_LINES) return;
    let gone = false;
    // Shiki loads with the first file shown, not with the app.
    void import("../highlight").then(async ({ highlightLines, langFor }) => {
      const lang = langFor(file.path);
      const out = lang ? await highlightLines(lines.join("\n"), lang) : null;
      if (!gone && out && out.length === lines.length) setTokens(out);
    });
    return () => {
      gone = true;
    };
  }, [file, lines]);

  // The asked-for line sits in the middle and flashes once, like a search hit.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body || !file) return;
    const row = target.line
      ? body.querySelector<HTMLElement>(`[data-line="${target.line}"]`)
      : null;
    if (row) {
      body.scrollTop = row.offsetTop - body.clientHeight / 2 + row.offsetHeight / 2;
      setFlashing(true);
      const id = window.setTimeout(() => setFlashing(false), 1600);
      return () => window.clearTimeout(id);
    }
    body.scrollTop = 0;
  }, [file, target.line]);

  const { name, dir } = splitFilePath(file?.path ?? target.path);
  const gutter = String(lines.length).length;

  return (
    <SidePane labelledBy="file-title" focusKey={`${target.path}:${target.line ?? ""}`} className="file-view">
      <div className="titlebar-align" data-tauri-drag-region />
      <header className="peek-head file-head" data-tauri-drag-region="deep">
        {media ? <ImageIcon className="file-head-icon" size={16} /> : <FileText className="file-head-icon" size={16} />}
        <div className="file-head-text">
          <h2 id="file-title" className="file-name" title={file?.path ?? target.path}>
            {name}
            {target.line ? <span className="file-line">:{target.line}</span> : null}
          </h2>
          {dir ? (
            <p className="file-dir">
              <bdi>{dir}</bdi>
            </p>
          ) : null}
        </div>
        <button
          type="button"
          className="head-action"
          title={t("file.openInApp")}
          aria-label={t("file.openInApp")}
          onClick={() => void api.openPath(file?.path ?? target.path).catch(() => null)}
        >
          <ExternalLink />
        </button>
        <button
          type="button"
          className="head-action"
          title={t("file.close")}
          aria-label={t("file.close")}
          onClick={onClose}
        >
          <X />
        </button>
      </header>
      {files.length > 1 ? (
        <div className="file-tabs" role="tablist" aria-label={t("file.tabs")}>
          {/* `fileTabs` keeps one tab per path and line, so the key is unique. */}
          {files.map((f, i) => {
            const name = splitFilePath(f.path).name;
            return (
              <div
                key={`${f.path}:${f.line ?? ""}`}
                className={"file-tab" + (i === at ? " active" : "")}
                // A middle click closes a tab, as in a browser.
                onAuxClick={(e) => {
                  if (e.button !== 1) return;
                  e.preventDefault();
                  onCloseTab(i);
                }}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={i === at}
                  className="file-tab-pick"
                  title={f.path}
                  onClick={() => onPick(i)}
                >
                  {name}
                  {f.line ? <span className="file-line">:{f.line}</span> : null}
                </button>
                {/* A sibling of the tab button, so closing never picks it. */}
                <button
                  type="button"
                  className="file-tab-close"
                  title={t("file.closeTab")}
                  aria-label={t("file.closeTabNamed", { name })}
                  onClick={() => onCloseTab(i)}
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <div />
      )}
      <div className={"file-body" + (media ? " is-media" : "")} ref={bodyRef}>
        {media ? <FileMedia kind={media} path={target.path} /> : null}
        {!media && loaded.state === "loading" ? <p className="file-state">{t("file.loading")}</p> : null}
        {!media && loaded.state === "error" ? <p className="file-state">{t(loaded.key)}</p> : null}
        {file ? (
          <div className="file-code" style={{ ["--gutter" as string]: `${gutter}ch` }}>
            {lines.map((line, i) => {
              const n = i + 1;
              const hit = target.line === n;
              return (
                <div
                  key={i}
                  className={"file-row" + (hit ? " is-target" : "") + (hit && flashing ? " flash" : "")}
                  data-line={n}
                >
                  <span className="file-num" aria-hidden>
                    {n}
                  </span>
                  <span className="file-src">
                    {tokens
                      ? tokens[i].map((tok, j) => (
                          <span
                            key={j}
                            style={{ ["--d" as string]: tok.dark, ["--l" as string]: tok.light }}
                          >
                            {tok.text}
                          </span>
                        ))
                      : line || "​"}
                  </span>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
      {file?.truncated ? (
        <div className="peek-foot">
          <p className="peek-note">{t("file.truncated")}</p>
        </div>
      ) : null}
    </SidePane>
  );
}
