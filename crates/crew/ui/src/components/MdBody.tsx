import { createElement, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "katex/dist/katex.min.css";
import { injectMentionChips } from "../mentions";
import {
  isLocalHref,
  mediaKind,
  mediaSrc,
  renderMarkdown,
  resolveLocalPath,
  type MediaKind,
} from "../markdown";
import { api } from "../api";
import type { AgentInfo } from "../types";
import { useT } from "../LocaleContext";
import { CornerDownRight, Play, Terminal, X } from "../icons";
import { CopyButton } from "./CopyButton";
import { MentionChip } from "./MentionChip";

const TAGS = new Set([
  "P",
  "BR",
  "STRONG",
  "EM",
  "A",
  "IMG",
  "CODE",
  "PRE",
  "UL",
  "OL",
  "LI",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "BLOCKQUOTE",
  "HR",
  "S",
  "SUP",
  "SPAN",
  "TABLE",
  "THEAD",
  "TBODY",
  "TR",
  "TH",
  "TD",
]);

type Shot = {
  src: string;
  alt: string;
  kind: "image" | MediaKind;
  path?: string;
};

type Props = {
  text: string;
  agents: AgentInfo[];
  className?: string;
  onMention?: (id: string) => void;
  baseDir?: string;
  /** `messageDefinitions` of the message `text` is a balloon of, for links and footnotes defined in another balloon. */
  defs?: string;
};

export function MdBody({
  text,
  agents,
  className,
  onMention,
  baseDir,
  defs,
}: Props) {
  const t = useT();
  const onMentionRef = useRef(onMention);
  onMentionRef.current = onMention;
  const clickable = !!onMention;
  const [shot, setShot] = useState<Shot | null>(null);
  const closeShot = useCallback(() => setShot(null), []);
  const zoomLabel = t("image.preview");
  const nodes = useMemo(() => {
    const html = injectMentionChips(renderMarkdown(text, defs), agents);
    const handleAgent = onMention
      ? (id: string) => onMentionRef.current?.(id)
      : undefined;
    return htmlToReact(html, agents, handleAgent, baseDir, setShot, zoomLabel);
  }, [text, defs, agents, clickable, baseDir, onMention, zoomLabel]);
  return (
    <div className={className}>
      {nodes}
      {shot ? <MediaPreview key={shot.kind + shot.src} shot={shot} onClose={closeShot} /> : null}
    </div>
  );
}

/** A command that printed nothing still ran; say so instead of an empty box. */
function EmptyBlock({ isOut }: { isOut: boolean }) {
  const t = useT();
  return (
    <div className={"code-wrap" + (isOut ? " md-out" : "")}>
      {isOut ? <CornerDownRight className="md-mark" size={14} /> : null}
      <pre>
        <span className="md-empty">{t("thread.emptyOutput")}</span>
      </pre>
    </div>
  );
}

function htmlToReact(
  html: string,
  agents: AgentInfo[],
  onMention: ((id: string) => void) | undefined,
  baseDir: string | undefined,
  onOpen: (shot: Shot) => void,
  zoomLabel: string,
): ReactNode[] {
  const tmpl = document.createElement("template");
  tmpl.innerHTML = html;
  return nodesToReact(tmpl.content.childNodes, agents, "m", onMention, baseDir, onOpen, zoomLabel);
}

function nodesToReact(
  nodes: NodeListOf<ChildNode>,
  agents: AgentInfo[],
  prefix: string,
  onMention: ((id: string) => void) | undefined,
  baseDir: string | undefined,
  onOpen: (shot: Shot) => void,
  zoomLabel: string,
): ReactNode[] {
  const out: ReactNode[] = [];
  Array.from(nodes).forEach((node, i) => {
    const child = nodeToReact(
      node,
      agents,
      prefix + "-" + i,
      onMention,
      baseDir,
      onOpen,
      zoomLabel,
    );
    if (child !== null && child !== undefined && child !== "") out.push(child);
  });
  return out;
}

function nodeToReact(
  node: Node,
  agents: AgentInfo[],
  key: string,
  onMention: ((id: string) => void) | undefined,
  baseDir: string | undefined,
  onOpen: (shot: Shot) => void,
  zoomLabel: string,
): ReactNode {
  if (node.nodeType === Node.TEXT_NODE) {
    // markdown-it puts a newline between block tags; it is layout, not text.
    const text = node.textContent || "";
    return /^\s*\n\s*$/.test(text) ? null : text;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const el = node as HTMLElement;
  const tag = el.tagName;
  if (el.classList.contains("md-math")) {
    // KaTeX's own markup, positioned by its inline styles. markdown-it escaped
    // the bot's text before KaTeX saw it, so nothing here came from the bot as HTML.
    return createElement(tag.toLowerCase(), {
      key,
      className: el.className,
      dangerouslySetInnerHTML: { __html: el.innerHTML },
    });
  }
  if (tag === "INPUT") {
    return (
      <input
        key={key}
        type="checkbox"
        checked={el.hasAttribute("checked")}
        disabled
        readOnly
      />
    );
  }
  if (el.classList.contains("mention-chip")) {
    // Old transcripts can still carry a room chip. Show the name; do not open a room.
    const channelId = el.getAttribute("data-channel") || "";
    if (channelId) return <span key={key}>#{channelId}</span>;
    const id = el.getAttribute("data-mention") || "";
    const agent = agents.find((a) => a.id === id);
    if (agent) {
      return <MentionChip key={key} agent={agent} onClick={onMention} />;
    }
    return id ? <span key={key}>@{id}</span> : null;
  }
  if (tag === "BR") return <br key={key} />;
  const kids = nodesToReact(el.childNodes, agents, key, onMention, baseDir, onOpen, zoomLabel);
  if (el.classList.contains("md-gallery")) {
    return (
      <div
        key={key}
        className={el.getAttribute("class") || "md-gallery"}
        data-count={el.getAttribute("data-count") || String(kids.length)}
      >
        {kids}
      </div>
    );
  }
  if (!TAGS.has(tag)) return kids;
  if (tag === "PRE") {
    const isOut = el.classList.contains("md-out");
    const text = el.textContent || "";
    if (!text.trim()) return <EmptyBlock key={key} isOut={isOut} />;
    return (
      <div key={key} className={"code-wrap" + (isOut ? " md-out" : "")}>
        {isOut ? <CornerDownRight className="md-mark" size={14} /> : null}
        <pre>{kids}</pre>
        <CopyButton text={text} className="code-copy" />
      </div>
    );
  }
  if (tag === "TABLE") {
    // The wrapper scrolls; a table restyled to scroll itself stops reading as a table.
    return (
      <div key={key} className="md-table">
        <table>{kids}</table>
      </div>
    );
  }
  if (tag === "IMG") {
    const raw = el.getAttribute("src") || "";
    const alt = el.getAttribute("alt") || "";
    const src = mediaSrc(raw, baseDir);
    const clip = mediaKind(raw);
    if (clip && src) {
      return (
        <MediaCard
          key={key}
          kind={clip}
          src={src}
          name={mediaLabel(alt, raw)}
          path={resolveLocalPath(raw, baseDir) || undefined}
          onOpen={onOpen}
        />
      );
    }
    const open = () => {
      if (src) onOpen({ src, alt, kind: "image" });
    };
    return (
      <img
        key={key}
        alt={alt}
        aria-label={alt || zoomLabel}
        title={el.getAttribute("title") || undefined}
        src={src}
        role={src ? "button" : undefined}
        tabIndex={src ? 0 : undefined}
        onClick={
          src
            ? (e) => {
                e.preventDefault();
                e.stopPropagation();
                open();
              }
            : undefined
        }
        onKeyDown={
          src
            ? (e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                e.stopPropagation();
                open();
              }
            : undefined
        }
      />
    );
  }
  if (tag === "A") {
    const href = el.getAttribute("href") || "";
    const title = el.getAttribute("title") || undefined;
    const clip = title === "video" || title === "audio" ? title : mediaKind(href);
    if (clip) {
      const src = mediaSrc(href, baseDir);
      if (src) {
        return (
          <MediaCard
            key={key}
            kind={clip}
            src={src}
            name={mediaLabel(el.textContent || "", href)}
            path={resolveLocalPath(href, baseDir) || undefined}
            onOpen={onOpen}
          />
        );
      }
    }
    if (isLocalHref(href, baseDir)) {
      return (
        <a
          key={key}
          href={href}
          title={title}
          onClick={(e) => {
            e.preventDefault();
            const path = resolveLocalPath(href, baseDir);
            if (path) void api.openPath(path);
          }}
        >
          {kids}
        </a>
      );
    }
    // Only the web and mail open outside the app. `#section`, a relative path
    // with no folder to resolve it, or an unknown scheme has nowhere to go.
    if (!/^(https?|mailto):/i.test(href)) {
      return (
        <span key={key} title={title}>
          {kids}
        </span>
      );
    }
    return (
      <a
        key={key}
        href={href}
        title={title}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => {
          // WKWebView drops target=_blank. The app hands the link to `open`.
          if (!("__TAURI_INTERNALS__" in window)) return;
          e.preventDefault();
          void api.openUrl(href);
        }}
      >
        {kids}
      </a>
    );
  }
  const cls = el.getAttribute("class");
  if (cls === "md-cmd") {
    return (
      <p key={key} className={cls}>
        <Terminal className="md-mark" size={14} />
        {kids}
      </p>
    );
  }
  return createElement(
    tag.toLowerCase(),
    {
      key,
      className: cls || undefined,
      // A list that picks up after a code block keeps counting.
      start: tag === "OL" && el.hasAttribute("start") ? Number(el.getAttribute("start")) : undefined,
      style: el.style.textAlign ? { textAlign: el.style.textAlign } : undefined,
    },
    ...kids,
  );
}

function mediaLabel(name: string, href: string): string {
  if (name.trim()) return name.trim();
  const base = href.trim().split(/[?#]/)[0].split(/[\\/]/).pop() || "";
  try {
    return decodeURIComponent(base);
  } catch {
    return base;
  }
}

function MediaCard({
  kind,
  src,
  name,
  path,
  onOpen,
}: {
  kind: MediaKind;
  src: string;
  name: string;
  path?: string;
  onOpen: (shot: Shot) => void;
}) {
  const t = useT();
  const [posterFailed, setPosterFailed] = useState(false);
  const open = () => onOpen({ src, alt: name, kind, path });
  const label = name ? `${t("media.play")}: ${name}` : t("media.play");
  const press = (e: { preventDefault: () => void; stopPropagation: () => void }) => {
    e.preventDefault();
    e.stopPropagation();
    open();
  };
  if (kind === "audio") {
    return (
      <button type="button" className="md-media md-media-audio" aria-label={label} onClick={press}>
        <span className="md-media-mark">
          <Play size={14} className="md-media-play" />
        </span>
        <span className="md-media-name">{name || t("media.audio")}</span>
      </button>
    );
  }
  const poster = src.includes("#") ? src : `${src}#t=0.1`;
  return (
    <button type="button" className="md-media md-media-video" aria-label={label} onClick={press}>
      {posterFailed ? (
        <span className="md-media-fallback" />
      ) : (
        <video
          src={poster}
          muted
          playsInline
          preload="metadata"
          tabIndex={-1}
          onError={() => setPosterFailed(true)}
        />
      )}
      <span className="md-media-badge">
        <Play size={18} className="md-media-play" />
      </span>
    </button>
  );
}

function MediaPreview({ shot, onClose }: { shot: Shot; onClose: () => void }) {
  const t = useT();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.fullscreenElement) return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  const label =
    shot.alt ||
    (shot.kind === "video" ? t("media.video") : shot.kind === "audio" ? t("media.audio") : t("image.preview"));
  const keep = (e: { stopPropagation: () => void }) => e.stopPropagation();
  return createPortal(
    <div
      className="img-preview"
      role="dialog"
      aria-modal="true"
      aria-label={label}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <button
        ref={closeRef}
        type="button"
        className="img-preview-close"
        aria-label={t("common.close")}
        onMouseDown={keep}
        onClick={onClose}
      >
        <X size={18} />
      </button>
      {shot.kind === "image" ? <img src={shot.src} alt={shot.alt} onMouseDown={keep} /> : null}
      {shot.kind === "video" && !failed ? (
        <video src={shot.src} controls autoPlay playsInline onError={() => setFailed(true)} onMouseDown={keep} />
      ) : null}
      {shot.kind === "audio" && !failed ? (
        <audio src={shot.src} controls autoPlay onError={() => setFailed(true)} onMouseDown={keep} />
      ) : null}
      {failed ? (
        <div className="img-preview-fail" onMouseDown={keep}>
          <p>{t("media.cantPlay")}</p>
          {shot.path ? (
            <button type="button" onClick={() => void api.openPath(shot.path!)}>
              {t("media.openApp")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
