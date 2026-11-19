import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import "katex/dist/katex.min.css";
import { injectMentionChips, sameMentionAgents } from "../mentions";
import {
  fileName,
  isLocalHref,
  mediaKind,
  mediaSrc,
  missingReason,
  renderMarkdown,
  resolveLocalPath,
  type MediaKind,
} from "../markdown";
import { api } from "../api";
import type { AgentInfo } from "../types";
import { useT } from "../LocaleContext";
import { useLabelGroups } from "../BotLabelContext";
import {
  codePathRef,
  opensInPanel,
  parseFileRef,
  fileTarget,
  useFileOpen,
  type FileTarget,
} from "../fileRef";
import { CornerDownRight, Play, Terminal } from "../icons";
import { GALLERY_CAP, galleryExtra } from "../imageAlbum";
import { CopyButton } from "./CopyButton";
import { MediaPreview, type Shot } from "./MediaPreview";
import { GroupChip, MentionChip } from "./MentionChip";

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
  /** Drawn inside the balloon before the text, like the quote a reply answers. */
  lead?: ReactNode;
};

export function MdBody({
  text,
  agents,
  className,
  onMention,
  baseDir,
  defs,
  lead,
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
  const groups = useLabelGroups();
  const nodes = useMemo(() => {
    const html = injectMentionChips(renderMarkdown(text, defs), chipAgents, groups);
    // Read through the ref: a parent hands a new handler each render, and the
    // parse must not run again for that.
    const handleAgent = clickable
      ? (id: string) => onMentionRef.current?.(id)
      : undefined;
    return htmlToReact(html, chipAgents, handleAgent, baseDir, openPreview, zoomLabel);
  }, [text, defs, chipAgents, groups, clickable, baseDir, zoomLabel, openPreview]);
  return (
    <div className={className}>
      {lead}
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
    const groupId = el.getAttribute("data-group") || "";
    if (groupId) {
      return <GroupChip key={key} id={groupId} name={el.getAttribute("data-label") || groupId} />;
    }
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
    const local = resolveLocalPath(raw, baseDir);
    return (
      <LocalImg
        key={key}
        path={local}
        name={alt || (local ? fileName(local) : raw)}
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
        <LocalLink key={key} href={href} title={title} path={resolveLocalPath(href, baseDir)} baseDir={baseDir}>
          {kids}
        </LocalLink>
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
  if (tag === "CODE" && el.parentElement?.tagName !== "PRE") {
    const text = el.textContent || "";
    const ref = codePathRef(text);
    const target = ref ? fileTarget(ref, baseDir) : null;
    if (target) return <PathCode key={key} text={text} target={target} />;
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
    const path = resolveLocalPath(raw, baseDir) ?? undefined;
    shots.push({ src, alt: child.getAttribute("alt") || "", kind: "image", path });
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
      <LocalImg
        path={shot.path ?? null}
        name={shot.alt || (shot.path ? fileName(shot.path) : label)}
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


/**
 * A picture. One on this Mac that does not load becomes a note saying which
 * file and where it was looked for, not a broken-image icon: a bot that wrote
 * a path relative to another folder, or under a hidden one, then shows why.
 */
function LocalImg({
  path,
  name,
  ...img
}: { path: string | null; name: string } & React.ImgHTMLAttributes<HTMLImageElement>) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [img.src]);
  if (failed && path) return <MissingNote path={path} name={name} />;
  return <img {...img} onError={path ? () => setFailed(true) : undefined} />;
}

/** Where a file on this Mac was looked for, when it was not there. */
function MissingNote({ path, name, inline = false }: { path: string; name?: string; inline?: boolean }) {
  const t = useT();
  const why = missingReason(path) === "hidden" ? t("file.hiddenAt", { path }) : t("file.missingAt", { path });
  return (
    <span className={"md-missing" + (inline ? " is-inline" : "")} role="note" title={path}>
      {name ? <span className="md-missing-name">{name}</span> : null}
      <span className="md-missing-why">{why}</span>
    </span>
  );
}

/**
 * A link to a file on this Mac. A text or code file opens beside the chat; a
 * folder, a picture or a document opens in its own app, as it always did.
 */
function LocalLink({
  href,
  title,
  path,
  baseDir,
  children,
}: {
  href: string;
  title?: string;
  path: string | null;
  baseDir?: string;
  children: ReactNode;
}) {
  const openFile = useFileOpen();
  const [missing, setMissing] = useState(false);
  return (
    <>
      <a
        href={href}
        title={title}
        onClick={(e) => {
          e.preventDefault();
          if (!path) return;
          // A relative link keeps how it was written, for the search under the bot's folder.
          const written = parseFileRef(href.replace(/^file:\/\//, ""));
          const target = fileTarget(written, baseDir) ?? parseFileRef(path);
          if (openFile && opensInPanel(target.path)) openFile.open(target);
          else void api.openPath(path).then(() => setMissing(false), () => setMissing(true));
        }}
      >
        {children}
      </a>
      {missing && path ? <MissingNote path={path} inline /> : null}
    </>
  );
}

/** Inline code that names a file, `src/foo.ts:53`: a click shows it beside the chat. */
function PathCode({ text, target }: { text: string; target: FileTarget }) {
  const openFile = useFileOpen();
  const t = useT();
  if (!openFile) return <code>{text}</code>;
  return (
    <code
      className="md-path"
      role="button"
      tabIndex={0}
      title={t("file.show")}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openFile.open(target);
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        openFile.open(target);
      }}
    >
      {text}
    </code>
  );
}
