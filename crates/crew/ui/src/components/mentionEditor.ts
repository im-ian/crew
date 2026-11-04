// The editing a box with @mention chips needs. The composer and the typed
// answers on a question card share it, so a chip reads the same in both.
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { botSearchText } from "../botLabel";
import { mentionMatches } from "../mentions";
import type { AgentInfo, Group } from "../types";

/** What was typed after `@`, and where the `@` is in the caret's text. */
export type MentionQuery = { start: number; query: string };

/** The `@query` the caret sits at the end of, if any. */
export function mentionAtCaret(editor: HTMLElement | null): MentionQuery | null {
  const ctx = caretTextContext(editor);
  if (!ctx) return null;
  const before = ctx.node.textContent?.slice(0, ctx.offset) ?? "";
  const m = before.match(/(^|[\s])@(\S*)$/);
  if (!m) return null;
  return { start: before.length - m[2].length - 1, query: m[2] };
}

/** The bots the @ menu offers for `query`. The row shows the group too, so the group's name finds it. */
export function mentionCandidates(
  agents: readonly AgentInfo[],
  groups: readonly Group[],
  query: string,
  skip?: string | null,
): AgentInfo[] {
  const q = query.toLowerCase();
  return agents
    .filter(
      (a) =>
        a.id !== skip &&
        (mentionMatches(a, query) || botSearchText(a, groups).toLowerCase().includes(q)),
    )
    .slice(0, 8);
}
export function insertChip(
  editor: HTMLElement | null,
  make: () => HTMLElement,
): boolean {
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
  const chip = make();
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

export function renderChip(node: ReactNode): HTMLElement {
  const box = document.createElement("div");
  const root = createRoot(box);
  flushSync(() => {
    root.render(node);
  });
  const html = box.innerHTML;
  root.unmount();
  box.innerHTML = html;
  return box.firstElementChild as HTMLElement;
}

export function isEditorEmpty(el: HTMLElement): boolean {
  if (el.querySelector("[data-mention]")) return false;
  return !el.innerText.replace(/\u00a0/g, " ").trim();
}

export function serializeEditor(root: HTMLElement): string {
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

export function caretTextContext(
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
