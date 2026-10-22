import { createElement, useMemo, useRef, type ReactNode } from "react";
import "katex/dist/katex.min.css";
import { injectMentionChips } from "../mentions";
import {
  isLocalHref,
  mediaSrc,
  renderMarkdown,
  resolveLocalPath,
} from "../markdown";
import { api } from "../api";
import type { AgentInfo } from "../types";
import { useT } from "../LocaleContext";
import { CornerDownRight, Terminal } from "../icons";
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
  const onMentionRef = useRef(onMention);
  onMentionRef.current = onMention;
  const clickable = !!onMention;
  const nodes = useMemo(() => {
    const html = injectMentionChips(renderMarkdown(text, defs), agents);
    const handleAgent = onMention
      ? (id: string) => onMentionRef.current?.(id)
      : undefined;
    return htmlToReact(html, agents, handleAgent, baseDir);
  }, [text, defs, agents, clickable, baseDir, onMention]);
  return <div className={className}>{nodes}</div>;
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
  baseDir?: string,
): ReactNode[] {
  const tmpl = document.createElement("template");
  tmpl.innerHTML = html;
  return nodesToReact(tmpl.content.childNodes, agents, "m", onMention, baseDir);
}

function nodesToReact(
  nodes: NodeListOf<ChildNode>,
  agents: AgentInfo[],
  prefix: string,
  onMention: ((id: string) => void) | undefined,
  baseDir?: string,
): ReactNode[] {
  const out: ReactNode[] = [];
  Array.from(nodes).forEach((node, i) => {
    const child = nodeToReact(
      node,
      agents,
      prefix + "-" + i,
      onMention,
      baseDir,
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
  baseDir?: string,
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
  const kids = nodesToReact(el.childNodes, agents, key, onMention, baseDir);
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
    return (
      <img
        key={key}
        alt={el.getAttribute("alt") || ""}
        title={el.getAttribute("title") || undefined}
        src={mediaSrc(raw, baseDir)}
      />
    );
  }
  if (tag === "A") {
    const href = el.getAttribute("href") || "";
    const title = el.getAttribute("title") || undefined;
    // A `#section` link has nowhere to go in a chat.
    if (href.startsWith("#")) return <span key={key}>{kids}</span>;
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
    return (
      <a
        key={key}
        href={href || undefined}
        title={title}
        target="_blank"
        rel="noopener noreferrer"
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
      start: tag === "OL" ? Number(el.getAttribute("start")) || undefined : undefined,
      style: el.style.textAlign ? { textAlign: el.style.textAlign } : undefined,
    },
    ...kids,
  );
}
