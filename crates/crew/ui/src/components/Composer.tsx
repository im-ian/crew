import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { AgentInfo, Kind } from "../types";
import { resolveMention, trimMentionPunct } from "../mentions";
import { Avatar } from "./Avatar";
import { MentionChip } from "./MentionChip";

type Props = {
  agents: AgentInfo[];
  selected: string | null;
  selectedKind: Kind;
  placeholder: string;
  onSend: (raw: string) => Promise<void>;
};

type Mention = { start: number; query: string };

export function Composer({
  agents,
  selected,
  selectedKind,
  placeholder,
  onSend,
}: Props) {
  const inputRef = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const [mention, setMention] = useState<Mention | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  const [empty, setEmpty] = useState(true);

  const matches = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    return agents
      .filter((a) => {
        if (selectedKind === "agent" && a.id === selected) return false;
        if (!q) return true;
        return (
          a.id.toLowerCase().includes(q) ||
          (a.name || "").toLowerCase().includes(q)
        );
      })
      .slice(0, 8);
  }, [agents, mention, selected, selectedKind]);

  function fit() {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  }

  function refreshEmpty() {
    const el = inputRef.current;
    setEmpty(!el || isEditorEmpty(el));
  }

  function scanMention() {
    if (composing.current) return;
    const ctx = caretTextContext(inputRef.current);
    if (!ctx) {
      setMention(null);
      return;
    }
    const before = ctx.node.textContent?.slice(0, ctx.offset) ?? "";
    const m = before.match(/(^|[\s])@(\S*)$/);
    if (!m) {
      setMention(null);
      return;
    }
    const query = m[2];
    const start = before.length - query.length - 1;
    setMention((prev) => {
      if (prev && prev.start === start && prev.query === query) return prev;
      return { start, query };
    });
  }

  function pickMention(agent: AgentInfo) {
    if (!insertChip(inputRef.current, agent)) return;
    setMention(null);
    refreshEmpty();
    fit();
  }

  useEffect(() => {
    fit();
  }, [placeholder]);

  useEffect(() => {
    setMentionIdx(0);
  }, [mention?.start, mention?.query]);

  useEffect(() => {
    if (mentionIdx >= matches.length) setMentionIdx(0);
  }, [mentionIdx, matches.length]);

  const mentionOpen = !!mention && matches.length > 0;

  return (
    <form
      className="composer"
      onSubmit={async (e) => {
        e.preventDefault();
        const el = inputRef.current;
        if (!el) return;
        const raw = serializeEditor(el);
        if (!raw.trim()) return;
        el.innerHTML = "";
        setMention(null);
        setEmpty(true);
        fit();
        await onSend(raw);
      }}
    >
      <div className="composer-box">
        {mentionOpen ? (
          <div className="mention-menu" role="listbox">
            {matches.map((a, i) => (
              <button
                key={a.id}
                type="button"
                role="option"
                aria-selected={i === mentionIdx}
                className={
                  "mention-item" + (i === mentionIdx ? " active" : "")
                }
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickMention(a);
                }}
              >
                <Avatar
                  className="mention-avatar"
                  id={a.id}
                  name={a.name || a.id}
                  src={a.avatar}
                  shape={a.avatar_shape}
                  color={a.avatar_color}
                />
                <span className="mention-name">{a.name || a.id}</span>
                {a.name && a.name !== a.id ? (
                  <span className="mention-id">{a.id}</span>
                ) : null}
              </button>
            ))}
          </div>
        ) : null}
        <div
          ref={inputRef}
          className={"composer-input" + (empty ? " is-empty" : "")}
          contentEditable
          role="textbox"
          aria-multiline="true"
          data-placeholder={placeholder}
          onInput={() => {
            refreshEmpty();
            fit();
            scanMention();
          }}
          onClick={scanMention}
          onKeyUp={scanMention}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
            scanMention();
          }}
          onPaste={(e) => {
            e.preventDefault();
            const text = e.clipboardData?.getData("text/plain") ?? "";
            document.execCommand("insertText", false, text);
          }}
          onKeyDown={(e) => {
            if (mentionOpen) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setMentionIdx((i) => (i + 1) % matches.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setMentionIdx((i) => (i - 1 + matches.length) % matches.length);
                return;
              }
              if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                e.preventDefault();
                const agent = matches[mentionIdx] ?? matches[0];
                if (agent) pickMention(agent);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setMention(null);
                return;
              }
            }
            if (e.key === "Enter" && e.shiftKey) {
              e.preventDefault();
              document.execCommand("insertLineBreak");
              refreshEmpty();
              fit();
              return;
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              (e.currentTarget.closest("form") as HTMLFormElement | null)?.requestSubmit();
            }
            if (e.key === " " && !composing.current) {
              const ctx = caretTextContext(inputRef.current);
              const before = ctx?.node.textContent?.slice(0, ctx.offset) ?? "";
              const m = before.match(/(^|[\s])@(\S+)$/);
              const token = m ? trimMentionPunct(m[2]) : "";
              const agent = token ? resolveMention(token, agents) : undefined;
              if (agent && insertChip(inputRef.current, agent)) {
                e.preventDefault();
                setMention(null);
                refreshEmpty();
                fit();
              }
            }
          }}
        />
        <button type="submit" aria-label="보내기" disabled={!selected}>
          ↑
        </button>
      </div>
    </form>
  );
}

function insertChip(editor: HTMLElement | null, agent: AgentInfo): boolean {
  const ctx = caretTextContext(editor);
  if (!ctx) return false;
  const prefix = ctx.node.textContent?.slice(0, ctx.offset) ?? "";
  const m = prefix.match(/(^|[\s])@(\S*)$/);
  if (!m) return false;
  const start = prefix.length - m[2].length - 1;
  const range = document.createRange();
  range.setStart(ctx.node, start);
  range.setEnd(ctx.node, ctx.offset);
  range.deleteContents();
  const chip = renderChip(agent);
  range.insertNode(chip);
  const space = document.createTextNode("\u00a0");
  chip.after(space);
  const sel = window.getSelection();
  if (sel) {
    sel.removeAllRanges();
    const after = document.createRange();
    after.setStart(space, 1);
    after.collapse(true);
    sel.addRange(after);
  }
  return true;
}

function renderChip(agent: AgentInfo): HTMLElement {
  const box = document.createElement("div");
  const root = createRoot(box);
  flushSync(() => {
    root.render(<MentionChip agent={agent} />);
  });
  const html = box.innerHTML;
  root.unmount();
  box.innerHTML = html;
  return box.firstElementChild as HTMLElement;
}

function isEditorEmpty(el: HTMLElement): boolean {
  if (el.querySelector("[data-mention]")) return false;
  return !el.innerText.replace(/\u00a0/g, " ").trim();
}

function serializeEditor(root: HTMLElement): string {
  let s = "";
  function walk(node: Node): void {
    if (node.nodeType === Node.TEXT_NODE) {
      s += (node.textContent || "").replace(/\u00a0/g, " ");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    if (el.dataset.mention) {
      s += "@" + el.dataset.mention;
      return;
    }
    if (el.tagName === "BR") {
      s += "\n";
      return;
    }
    const block = el !== root && (el.tagName === "DIV" || el.tagName === "P");
    if (block && s.length > 0 && !s.endsWith("\n")) s += "\n";
    Array.from(el.childNodes).forEach(walk);
  }
  walk(root);
  return s.replace(/\n+$/, "");
}

function caretTextContext(
  editor: HTMLElement | null,
): { node: Text; offset: number } | null {
  if (!editor) return null;
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  if (!editor.contains(r.startContainer) && editor !== r.startContainer) {
    return null;
  }
  let node: Node | null = r.startContainer;
  let offset = r.startOffset;
  if (node.nodeType === Node.ELEMENT_NODE) {
    const children = node.childNodes;
    if (offset > 0 && children[offset - 1]?.nodeType === Node.TEXT_NODE) {
      node = children[offset - 1];
      offset = node.textContent?.length ?? 0;
    } else if (children[offset]?.nodeType === Node.TEXT_NODE) {
      node = children[offset];
      offset = 0;
    } else {
      return null;
    }
  }
  if (!node || node.nodeType !== Node.TEXT_NODE) return null;
  return { node: node as Text, offset };
}
