import { createElement, useMemo, useRef, type ReactNode } from "react";
import { injectMentionChips } from "../mentions";
import { isLocalHref, mediaSrc, renderMarkdown, resolveLocalPath } from "../markdown";
import { api } from "../api";
import type { AgentInfo, ChannelInfo } from "../types";
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
  "SPAN",
]);

type Props = {
  text: string;
  agents: AgentInfo[];
  channels?: ChannelInfo[];
  className?: string;
  onMention?: (id: string) => void;
  onChannel?: (id: string) => void;
  baseDir?: string;
};

export function MdBody({
  text,
  agents,
  channels = [],
  className,
  onMention,
  onChannel,
  baseDir,
}: Props) {
  const onMentionRef = useRef(onMention);
  onMentionRef.current = onMention;
  const onChannelRef = useRef(onChannel);
  onChannelRef.current = onChannel;
  const clickable = !!onMention || !!onChannel;
  const nodes = useMemo(() => {
    const html = injectMentionChips(renderMarkdown(text), agents, channels);
    const handleAgent = onMention
      ? (id: string) => onMentionRef.current?.(id)
      : undefined;
    const handleChannel = onChannel
      ? (id: string) => onChannelRef.current?.(id)
      : undefined;
    return htmlToReact(html, agents, channels, handleAgent, handleChannel, baseDir);
  }, [text, agents, channels, clickable, baseDir, onMention, onChannel]);
  return <div className={className}>{nodes}</div>;
}

function htmlToReact(
  html: string,
  agents: AgentInfo[],
  channels: ChannelInfo[],
  onMention: ((id: string) => void) | undefined,
  onChannel: ((id: string) => void) | undefined,
  baseDir?: string,
): ReactNode[] {
  const tmpl = document.createElement("template");
  tmpl.innerHTML = html;
  return nodesToReact(
    tmpl.content.childNodes,
    agents,
    channels,
    "m",
    onMention,
    onChannel,
    baseDir,
  );
}

function nodesToReact(
  nodes: NodeListOf<ChildNode>,
  agents: AgentInfo[],
  channels: ChannelInfo[],
  prefix: string,
  onMention: ((id: string) => void) | undefined,
  onChannel: ((id: string) => void) | undefined,
  baseDir?: string,
): ReactNode[] {
  const out: ReactNode[] = [];
  Array.from(nodes).forEach((node, i) => {
    const child = nodeToReact(
      node,
      agents,
      channels,
      prefix + "-" + i,
      onMention,
      onChannel,
      baseDir,
    );
    if (child !== null && child !== undefined && child !== "") out.push(child);
  });
  return out;
}

function nodeToReact(
  node: Node,
  agents: AgentInfo[],
  channels: ChannelInfo[],
  key: string,
  onMention: ((id: string) => void) | undefined,
  onChannel: ((id: string) => void) | undefined,
  baseDir?: string,
): ReactNode {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const el = node as HTMLElement;
  const tag = el.tagName;
  if (el.classList.contains("mention-chip")) {
    const channelId = el.getAttribute("data-channel") || "";
    if (channelId) {
      const channel = channels.find((c) => c.id === channelId);
      if (channel) {
        return (
          <MentionChip key={key} channel={channel} onClick={onChannel} />
        );
      }
      return <span key={key}>#{channelId}</span>;
    }
    const id = el.getAttribute("data-mention") || "";
    const agent = agents.find((a) => a.id === id);
    if (agent) {
      return (
        <MentionChip key={key} agent={agent} onClick={onMention} />
      );
    }
    return id ? <span key={key}>@{id}</span> : null;
  }
  if (tag === "BR") return <br key={key} />;
  const kids = nodesToReact(
    el.childNodes,
    agents,
    channels,
    key,
    onMention,
    onChannel,
    baseDir,
  );
  if (!TAGS.has(tag)) return kids;
  if (tag === "PRE") {
    return (
      <div key={key} className="code-wrap">
        <pre>{kids}</pre>
        <CopyButton text={el.textContent || ""} className="code-copy" />
      </div>
    );
  }
  if (tag === "IMG") {
    const raw = el.getAttribute("src") || "";
    return (
      <img
        key={key}
        alt={el.getAttribute("alt") || ""}
        src={mediaSrc(raw, baseDir)}
      />
    );
  }
  if (tag === "A") {
    const href = el.getAttribute("href") || "";
    if (isLocalHref(href, baseDir)) {
      return (
        <a
          key={key}
          href={href}
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
        target="_blank"
        rel="noopener noreferrer"
      >
        {kids}
      </a>
    );
  }
  return createElement(tag.toLowerCase(), { key }, ...kids);
}
