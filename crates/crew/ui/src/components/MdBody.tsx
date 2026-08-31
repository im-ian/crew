import { createElement, useMemo, useRef, type ReactNode } from "react";
import { injectMentionChips } from "../mentions";
import { renderMarkdown } from "../markdown";
import type { AgentInfo } from "../types";
import { MentionChip } from "./MentionChip";

const TAGS = new Set([
  "P",
  "BR",
  "STRONG",
  "EM",
  "A",
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
  className?: string;
  onMention?: (id: string) => void;
};

export function MdBody({ text, agents, className, onMention }: Props) {
  const onMentionRef = useRef(onMention);
  onMentionRef.current = onMention;
  const clickable = !!onMention;
  const nodes = useMemo(() => {
    const html = injectMentionChips(renderMarkdown(text), agents);
    const handle = clickable
      ? (id: string) => onMentionRef.current?.(id)
      : undefined;
    return htmlToReact(html, agents, handle);
  }, [text, agents, clickable]);
  return <div className={className}>{nodes}</div>;
}

function htmlToReact(
  html: string,
  agents: AgentInfo[],
  onMention?: (id: string) => void,
): ReactNode[] {
  const tmpl = document.createElement("template");
  tmpl.innerHTML = html;
  return nodesToReact(tmpl.content.childNodes, agents, "m", onMention);
}

function nodesToReact(
  nodes: NodeListOf<ChildNode>,
  agents: AgentInfo[],
  prefix: string,
  onMention?: (id: string) => void,
): ReactNode[] {
  const out: ReactNode[] = [];
  Array.from(nodes).forEach((node, i) => {
    const child = nodeToReact(node, agents, prefix + "-" + i, onMention);
    if (child !== null && child !== undefined && child !== "") out.push(child);
  });
  return out;
}

function nodeToReact(
  node: Node,
  agents: AgentInfo[],
  key: string,
  onMention?: (id: string) => void,
): ReactNode {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const el = node as HTMLElement;
  const tag = el.tagName;
  if (el.classList.contains("mention-chip")) {
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
  const kids = nodesToReact(el.childNodes, agents, key, onMention);
  if (!TAGS.has(tag)) return kids;
  if (tag === "A") {
    return (
      <a
        key={key}
        href={el.getAttribute("href") || undefined}
        target="_blank"
        rel="noopener noreferrer"
      >
        {kids}
      </a>
    );
  }
  return createElement(tag.toLowerCase(), { key }, ...kids);
}
