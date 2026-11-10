import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import "katex/dist/katex.min.css";
import { injectMentionChips, sameMentionAgents } from "../mentions";
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
import { CornerDownRight, Play, Terminal, X, ZoomIn, ZoomOut } from "../icons";
import { GALLERY_CAP, galleryExtra, imageStep } from "../imageAlbum";
import {
  clampView,
  DOUBLE_CLICK_SCALE,
  FIT,
  MIN_SCALE,
  MAX_SCALE,
  wheelFactor,
  zoomAt,
  zoomKey,
  ZOOM_STEP,
  type ZoomView,
} from "../imageZoom";
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

type Preview = {
  shots: Shot[];
  index: number;
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
  const [preview, setPreview] = useState<Preview | null>(null);
  const closeShot = useCallback(() => setPreview(null), []);
  const openPreview = useCallback((shots: Shot[], index: number) => {
    if (!shots.length) return;
    setPreview({ shots, index });
  }, []);
  const zoomLabel = t("image.preview");
  // A new list on every poll while a bot works. Kept while the chips it draws
  // stay the same, so the parse below does not run again for it.
  const chipRef = useRef(agents);
  if (!sameMentionAgents(chipRef.current, agents)) chipRef.current = agents;
  const chipAgents = chipRef.current;
  const nodes = useMemo(() => {
    const html = injectMentionChips(renderMarkdown(text, defs), chipAgents);
    // Read through the ref: a parent hands a new handler each render, and the
    // parse must not run again for that.
    const handleAgent = clickable
      ? (id: string) => onMentionRef.current?.(id)
      : undefined;
    return htmlToReact(html, chipAgents, handleAgent, baseDir, openPreview, zoomLabel);
  }, [text, defs, chipAgents, clickable, baseDir, zoomLabel, openPreview]);
  return (
    <div className={className}>
      {nodes}
      {preview ? (
        <MediaPreview shots={preview.shots} start={preview.index} onClose={closeShot} />
      ) : null}
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
  onOpen: (shots: Shot[], index: number) => void,
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
  onOpen: (shots: Shot[], index: number) => void,
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
  onOpen: (shots: Shot[], index: number) => void,
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
  if (el.classList.contains("md-gallery")) {
    const shots = galleryShots(el, baseDir);
    const shown = shots.slice(0, GALLERY_CAP);
    const extra = galleryExtra(shots.length);
    return (
      <div key={key} className="md-gallery" data-count={String(shots.length)}>
        {shown.map((shot, i) => (
          <AlbumImage
            key={`${shot.src}-${i}`}
            shot={shot}
            label={shot.alt || zoomLabel}
            more={extra > 0 && i === shown.length - 1 ? extra : 0}
            onOpen={() => onOpen(shots, i)}
          />
        ))}
      </div>
    );
  }
  const kids = nodesToReact(el.childNodes, agents, key, onMention, baseDir, onOpen, zoomLabel);
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
      if (src) onOpen([{ src, alt, kind: "image" }], 0);
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
  onOpen: (shots: Shot[], index: number) => void;
}) {
  const t = useT();
  const [posterFailed, setPosterFailed] = useState(false);
  const open = () => onOpen([{ src, alt: name, kind, path }], 0);
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

function galleryShots(el: HTMLElement, baseDir: string | undefined): Shot[] {
  const shots: Shot[] = [];
  for (const child of Array.from(el.children)) {
    if (!(child instanceof HTMLElement) || child.tagName !== "IMG") continue;
    const raw = child.getAttribute("src") || "";
    const src = mediaSrc(raw, baseDir);
    if (!src) continue;
    shots.push({ src, alt: child.getAttribute("alt") || "", kind: "image" });
  }
  return shots;
}

function AlbumImage({
  shot,
  label,
  more,
  onOpen,
}: {
  shot: Shot;
  label: string;
  more: number;
  onOpen: () => void;
}) {
  const open = (e: { preventDefault: () => void; stopPropagation: () => void }) => {
    e.preventDefault();
    e.stopPropagation();
    onOpen();
  };
  return (
    <span className="md-shot">
      <img
        alt={shot.alt}
        aria-label={more > 0 ? `${label}, +${more}` : label}
        src={shot.src}
        role="button"
        tabIndex={0}
        onClick={open}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          open(e);
        }}
      />
      {more > 0 ? (
        <span className="md-gallery-more" aria-hidden="true">
          +{more}
        </span>
      ) : null}
    </span>
  );
}

function MediaPreview({
  shots,
  start,
  onClose,
}: {
  shots: Shot[];
  start: number;
  onClose: () => void;
}) {
  const t = useT();
  const closeRef = useRef<HTMLButtonElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [index, setIndex] = useState(start);
  const [failed, setFailed] = useState(false);
  const shot = shots[index] ?? shots[0];
  const zoom = useImageZoom(shot?.kind === "image" ? shot.src : null, stageRef, imgRef);
  useEffect(() => {
    closeRef.current?.focus();
  }, []);
  useEffect(() => {
    setFailed(false);
  }, [shot?.src, shot?.kind]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.fullscreenElement) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (!shot || shot.kind !== "image") return;
      const z = zoomKey(e);
      if (z) {
        e.preventDefault();
        e.stopPropagation();
        if (z === "fit") zoom.fit();
        else zoom.step(z === "in" ? ZOOM_STEP : 1 / ZOOM_STEP);
        return;
      }
      if (e.metaKey || e.altKey || e.ctrlKey || e.shiftKey) return;
      const next = imageStep(e.key, index, shots.length);
      if (next == null) return;
      e.preventDefault();
      e.stopPropagation();
      if (next !== index) setIndex(next);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, shot, index, shots.length, zoom]);
  if (!shot) return null;
  const label =
    shot.alt ||
    (shot.kind === "video" ? t("media.video") : shot.kind === "audio" ? t("media.audio") : t("image.preview"));
  const keep = (e: { stopPropagation: () => void }) => e.stopPropagation();
  return createPortal(
    <div
      ref={stageRef}
      className={
        "img-preview" +
        (zoom.live ? " is-live" : "") +
        (zoom.space ? " is-space" : "") +
        (zoom.view.scale > MIN_SCALE ? " is-zoomed" : "")
      }
      role="dialog"
      aria-modal="true"
      aria-label={label}
      onPointerDown={zoom.onPointerDown}
      onClick={(e) => {
        // A drag that ends off the picture still clicks the backdrop, and
        // a click with Space held is a hand on the picture, not a dismissal.
        if (zoom.takeDrag() || zoom.space) return;
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
      {shot.kind === "image" ? (
        <img
          ref={imgRef}
          src={shot.src}
          alt={shot.alt}
          draggable={false}
          className={zoom.view.scale > MIN_SCALE ? "is-zoomed" : undefined}
          style={{
            transform: `translate(${zoom.view.x}px, ${zoom.view.y}px) scale(${zoom.view.scale})`,
          }}
          onMouseDown={keep}
          onDoubleClick={zoom.onDoubleClick}
        />
      ) : null}
      {shot.kind === "video" && !failed ? (
        <video src={shot.src} controls autoPlay playsInline onError={() => setFailed(true)} onMouseDown={keep} />
      ) : null}
      {shot.kind === "audio" && !failed ? (
        <audio src={shot.src} controls autoPlay onError={() => setFailed(true)} onMouseDown={keep} />
      ) : null}
      {shot.kind === "image" ? (
        <div className="img-preview-bar" onMouseDown={keep} onClick={keep}>
          <button
            type="button"
            aria-label={t("image.zoomOut")}
            title={t("image.zoomOut") + " (−)"}
            disabled={zoom.view.scale <= MIN_SCALE}
            onClick={() => zoom.step(1 / ZOOM_STEP)}
          >
            <ZoomOut size={16} />
          </button>
          <button
            type="button"
            className="img-preview-scale"
            aria-label={t("image.zoomFit")}
            title={t("image.zoomFit") + " (0)"}
            disabled={zoom.view.scale <= MIN_SCALE}
            onClick={zoom.fit}
          >
            {Math.round(zoom.view.scale * 100)}%
          </button>
          <button
            type="button"
            aria-label={t("image.zoomIn")}
            title={t("image.zoomIn") + " (+)"}
            disabled={zoom.view.scale >= MAX_SCALE}
            onClick={() => zoom.step(ZOOM_STEP)}
          >
            <ZoomIn size={16} />
          </button>
          {shots.length > 1 ? (
            <span className="img-preview-count">
              {index + 1} / {shots.length}
            </span>
          ) : null}
        </div>
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

/**
 * Zoom for the picture in the preview: a trackpad pinch, ⌘-scroll, the bar's
 * buttons, a double click, or + − 0. A zoomed picture moves with a drag, a
 * Space drag from anywhere, or a plain scroll. A new picture starts fitted.
 */
function useImageZoom(
  src: string | null,
  stageRef: RefObject<HTMLDivElement | null>,
  imgRef: RefObject<HTMLImageElement | null>,
) {
  const [view, setView] = useState<ZoomView>(FIT);
  // A pinch or a drag follows the hand; a press of a button eases.
  const [live, setLive] = useState(false);
  const viewRef = useRef(view);
  viewRef.current = view;
  const drag = useRef<{ id: number; x: number; y: number; from: ZoomView; moved: boolean } | null>(null);
  const dragged = useRef(false);
  // Space held: a hand that moves the picture from anywhere in the window.
  const [space, setSpace] = useState(false);
  const spaceRef = useRef(false);
  spaceRef.current = space;

  useEffect(() => {
    if (!src) return;
    const isSpace = (e: KeyboardEvent) => e.key === " " || e.code === "Space";
    // Both halves are taken: the focused close button would otherwise take
    // the press as a click and close the preview.
    const onDown = (e: KeyboardEvent) => {
      if (!isSpace(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      setSpace(true);
    };
    const onUp = (e: KeyboardEvent) => {
      if (!isSpace(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setSpace(false);
    };
    const onBlur = () => setSpace(false);
    window.addEventListener("keydown", onDown, true);
    window.addEventListener("keyup", onUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onDown, true);
      window.removeEventListener("keyup", onUp, true);
      window.removeEventListener("blur", onBlur);
      setSpace(false);
    };
  }, [src]);

  useEffect(() => {
    setView(FIT);
  }, [src]);

  const sizes = useCallback(() => {
    const img = imgRef.current;
    const stage = stageRef.current;
    if (!img || !stage) return null;
    return {
      picture: { width: img.offsetWidth, height: img.offsetHeight },
      room: { width: stage.clientWidth, height: stage.clientHeight },
    };
  }, [imgRef, stageRef]);

  /**
   * A point on screen, from the picture's fitted centre. Read from layout,
   * which a transform (or one still easing) does not move.
   */
  const pointAt = useCallback(
    (clientX: number, clientY: number) => {
      const img = imgRef.current;
      const stage = stageRef.current;
      if (!img || !stage) return { x: 0, y: 0 };
      const r = stage.getBoundingClientRect();
      return {
        x: clientX - (r.left + img.offsetLeft + img.offsetWidth / 2),
        y: clientY - (r.top + img.offsetTop + img.offsetHeight / 2),
      };
    },
    [imgRef, stageRef],
  );

  const zoomBy = useCallback(
    (factor: number, at: { x: number; y: number }) => {
      const s = sizes();
      if (!s) return;
      setView((v) => zoomAt(v, factor, at, s.picture, s.room));
    },
    [sizes],
  );

  /** To a scale, from whatever the last update left: pinch steps can outrun renders. */
  const zoomTo = useCallback(
    (scale: number, at: { x: number; y: number }) => {
      const s = sizes();
      if (!s) return;
      setView((v) => zoomAt(v, scale / v.scale, at, s.picture, s.room));
    },
    [sizes],
  );

  /** A button or key: about the middle of the window. */
  const step = useCallback(
    (factor: number) => {
      const stage = stageRef.current;
      if (!stage) return;
      const r = stage.getBoundingClientRect();
      setLive(false);
      zoomBy(factor, pointAt(r.left + r.width / 2, r.top + r.height / 2));
    },
    [stageRef, zoomBy, pointAt],
  );

  const fit = useCallback(() => {
    setLive(false);
    setView(FIT);
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !src) return;
    let settle = 0;
    const calm = () => {
      window.clearTimeout(settle);
      settle = window.setTimeout(() => setLive(false), 120);
    };
    // Not React's onWheel: that listener is passive and cannot keep the
    // window from scrolling or zooming itself.
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        setLive(true);
        calm();
        zoomBy(wheelFactor(e.deltaY), pointAt(e.clientX, e.clientY));
        return;
      }
      if (viewRef.current.scale <= MIN_SCALE) return;
      e.preventDefault();
      const s = sizes();
      if (!s) return;
      setLive(true);
      calm();
      setView((v) => clampView({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }, s.picture, s.room));
    };
    // WebKit reports a trackpad pinch as gesture events, not wheel steps.
    let pinchFrom = 1;
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      pinchFrom = viewRef.current.scale;
      setLive(true);
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as Event & { scale: number; clientX: number; clientY: number };
      zoomTo(pinchFrom * g.scale, pointAt(g.clientX, g.clientY));
    };
    const onGestureEnd = (e: Event) => {
      e.preventDefault();
      setLive(false);
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    stage.addEventListener("gesturestart", onGestureStart);
    stage.addEventListener("gesturechange", onGestureChange);
    stage.addEventListener("gestureend", onGestureEnd);
    return () => {
      window.clearTimeout(settle);
      stage.removeEventListener("wheel", onWheel);
      stage.removeEventListener("gesturestart", onGestureStart);
      stage.removeEventListener("gesturechange", onGestureChange);
      stage.removeEventListener("gestureend", onGestureEnd);
    };
  }, [stageRef, src, sizes, zoomBy, zoomTo, pointAt]);

  /**
   * A drag on the zoomed picture, or anywhere with Space held, moves it.
   * The stage listens, so a Space drag can start on the backdrop.
   */
  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      dragged.current = false;
      if (e.button !== 0 || viewRef.current.scale <= MIN_SCALE) return;
      const target = e.target as HTMLElement;
      if (target.closest("button")) return;
      if (!spaceRef.current && target !== imgRef.current) return;
      const el = e.currentTarget;
      el.setPointerCapture(e.pointerId);
      drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, from: viewRef.current, moved: false };
      setLive(true);
      const onMove = (ev: PointerEvent) => {
        const d = drag.current;
        if (!d || ev.pointerId !== d.id) return;
        const dx = ev.clientX - d.x;
        const dy = ev.clientY - d.y;
        if (!d.moved && Math.hypot(dx, dy) < 3) return;
        d.moved = true;
        const s = sizes();
        if (!s) return;
        setView(clampView({ ...d.from, x: d.from.x + dx, y: d.from.y + dy }, s.picture, s.room));
      };
      const onUp = (ev: PointerEvent) => {
        const d = drag.current;
        if (!d || ev.pointerId !== d.id) return;
        dragged.current = d.moved;
        drag.current = null;
        setLive(false);
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", onUp);
        el.removeEventListener("pointercancel", onUp);
      };
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp);
      el.addEventListener("pointercancel", onUp);
    },
    [sizes, imgRef],
  );

  const onDoubleClick = useCallback(
    (e: ReactMouseEvent<HTMLImageElement>) => {
      setLive(false);
      if (viewRef.current.scale > MIN_SCALE) {
        setView(FIT);
        return;
      }
      zoomBy(DOUBLE_CLICK_SCALE, pointAt(e.clientX, e.clientY));
    },
    [zoomBy, pointAt],
  );

  /** True once after a drag, so the click that ends it does not close. */
  const takeDrag = useCallback(() => {
    const was = dragged.current;
    dragged.current = false;
    return was;
  }, []);

  return useMemo(
    () => ({ view, live, space, step, fit, onPointerDown, onDoubleClick, takeDrag }),
    [view, live, space, step, fit, onPointerDown, onDoubleClick, takeDrag],
  );
}
