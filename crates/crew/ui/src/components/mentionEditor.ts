// The editing a box with @mention and #group chips needs. The composer and the typed
// answers on a question card share it, so a chip reads the same in both.
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { botSearchText, groupOfBot } from "../botLabel";
import { itemKey } from "../groups";
import {
  HANDLE_START,
  mentionMatches,
  resolveGroup,
  resolveMention,
  trimMentionPunct,
} from "../mentions";
import type { AgentInfo, Group } from "../types";

/** A handle being typed, maybe empty, and one typed out, at the end of the text. */
const TYPING_HANDLE = new RegExp(`${HANDLE_START}([@#])(\\S*)$`);
const TYPED_HANDLE = new RegExp(`${HANDLE_START}([@#])(\\S+)$`);

/**
 * What was typed after `@` (a bot) or `#` (a group), and where that sign is
 * in the caret's text.
 */
export type MentionQuery = { start: number; query: string; sigil: "@" | "#" };

/** The `@query` or `#query` that `before`, the text up to the caret, ends with. */
export function mentionBefore(before: string): MentionQuery | null {
  const m = before.match(TYPING_HANDLE);
  if (!m) return null;
  return {
    start: before.length - m[3].length - 1,
    query: m[3],
    sigil: m[2] as "@" | "#",
  };
}

/** The `@query` or `#query` the caret sits at the end of, if any. */
export function mentionAtCaret(editor: HTMLElement | null): MentionQuery | null {
  const ctx = caretTextContext(editor);
  if (!ctx) return null;
  return mentionBefore(ctx.node.textContent?.slice(0, ctx.offset) ?? "");
}

/**
 * The bots the @ menu offers for `query`, and how many at the top sit in the
 * same group as `skip`, the bot whose chat it is. Those come first; the rest
 * follow under a line. The row shows the group too, so the group's name finds it.
 */
export function mentionCandidates(
  agents: readonly AgentInfo[],
  groups: readonly Group[],
  query: string,
  skip?: string | null,
): { bots: AgentInfo[]; near: number } {
  const q = query.toLowerCase();
  const found = agents.filter(
    (a) =>
      a.id !== skip &&
      (mentionMatches(a, query) || botSearchText(a, groups).toLowerCase().includes(q)),
  );
  const home = skip ? groupOfBot(groups, skip) : null;
  // `home.items` holds the group's own keys, so one lookup tells a groupmate.
  const near: AgentInfo[] = [];
  const far: AgentInfo[] = [];
  for (const a of found) {
    (home && !a.remote && home.items.includes(itemKey("agent", a.id)) ? near : far).push(a);
  }
  const bots = [...near, ...far].slice(0, 8);
  return { bots, near: Math.min(near.length, bots.length) };
}
/**
 * The bot or group a `@name` or `#name` typed out right before the caret
 * names, so a space after it can turn it into the chip.
 */
export function typedHandle(
  before: string,
  agents: readonly AgentInfo[],
  groups: readonly Group[],
): { agent: AgentInfo } | { group: Group } | null {
  const m = before.match(TYPED_HANDLE);
  const token = m ? trimMentionPunct(m[3]) : "";
  if (!token) return null;
  if (m![2] === "#") {
    const group = resolveGroup(token, groups);
    return group ? { group } : null;
  }
  const agent = resolveMention(token, agents);
  return agent ? { agent } : null;
}

export function insertChip(
  editor: HTMLElement | null,
  make: () => HTMLElement,
): boolean {
  const ctx = caretTextContext(editor);
  if (!ctx) return false;
  const prefix = ctx.node.textContent?.slice(0, ctx.offset) ?? "";
  const m = mentionBefore(prefix);
  if (!m) return false;
  const start = m.start;
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
  if (el.querySelector("[data-mention], [data-group]")) return false;
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
    if (el.dataset.group) {
      s += "#" + el.dataset.group;
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
