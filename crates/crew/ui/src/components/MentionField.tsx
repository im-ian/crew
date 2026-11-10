import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useBotLabel, useLabelGroups } from "../BotLabelContext";
import { mentionRuns, resolveMention, trimMentionPunct } from "../mentions";
import type { AgentInfo } from "../types";
import { MentionChip } from "./MentionChip";
import { MentionMenu } from "./MentionMenu";
import {
  caretTextContext,
  insertChip,
  mentionAtCaret,
  mentionCandidates,
  renderChip,
  serializeEditor,
  type MentionQuery,
} from "./mentionEditor";

/** Room the menu wants under a box before it opens above it instead. */
const MENU_ROOM = 260;
const MENU_MIN_W = 280;

/**
 * A typed answer that can @name a bot, the way the composer does. The text
 * it hands back has each chip as `@id`, which is what the bot reads.
 */
export function MentionField({
  id,
  className,
  value,
  placeholder,
  disabled,
  agents,
  skip,
  onChange,
  onEnter,
}: {
  id?: string;
  className: string;
  value: string;
  placeholder?: string;
  disabled: boolean;
  agents: AgentInfo[];
  /** The bot the answer goes to. It is not offered. */
  skip?: string | null;
  onChange: (next: string) => void;
  onEnter: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // What the box says now, so a value it sent up is not drawn over the caret.
  const shown = useRef<string | null>(null);
  const composing = useRef(false);
  const labelOf = useBotLabel();
  const groups = useLabelGroups();
  const [query, setQuery] = useState<MentionQuery | null>(null);
  const [active, setActive] = useState(0);
  const [spot, setSpot] = useState<CSSProperties | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || shown.current === value) return;
    shown.current = value;
    // A chip comes from a React root of its own, which cannot render while
    // this commit is under way. A microtask still runs before the paint.
    queueMicrotask(() => {
      if (shown.current !== value) return;
      el.replaceChildren();
      for (const run of mentionRuns(value, agents)) {
        if (run.agent) {
          el.append(renderChip(<MentionChip agent={run.agent} label={labelOf(run.agent)} />));
          continue;
        }
        run.text.split("\n").forEach((line, i) => {
          if (i) el.append(document.createElement("br"));
          if (line) el.append(line);
        });
      }
    });
  }, [value, agents, labelOf]);

  const { bots, near } =
    query && !disabled ? mentionCandidates(agents, groups, query.query, skip) : { bots: [], near: 0 };
  const open = bots.length > 0;

  useEffect(() => {
    setActive(0);
  }, [query?.start, query?.query]);

  // The menu is fixed to the screen, so it follows the box when the thread
  // under it scrolls or the window changes size.
  useLayoutEffect(() => {
    if (!open) return;
    place();
    const follow = (e: Event) => {
      if (!menuRef.current?.contains(e.target as Node)) place();
    };
    window.addEventListener("scroll", follow, true);
    window.addEventListener("resize", follow);
    return () => {
      window.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", follow);
    };
  }, [open]);

  // The card clips what sticks out of it, so the menu sits on the page.
  function place() {
    const el = ref.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    const width = Math.max(box.width, MENU_MIN_W);
    const left = Math.max(8, Math.min(box.left, window.innerWidth - width - 8));
    const below = window.innerHeight - box.bottom >= MENU_ROOM;
    // Above, the menu hangs from the box's top by its own height.
    setSpot(
      below
        ? { left, width, top: box.bottom + 6 }
        : { left, width, top: box.top - 6, transform: "translateY(-100%)" },
    );
  }

  function send() {
    const el = ref.current;
    if (!el) return;
    const text = serializeEditor(el);
    shown.current = text;
    onChange(text);
  }

  function scan() {
    const el = ref.current;
    if (composing.current || !el) return;
    const next = mentionAtCaret(el);
    setQuery(next);
    if (next) place();
  }

  function pick(agent: AgentInfo) {
    const chip = () => renderChip(<MentionChip agent={agent} label={labelOf(agent)} />);
    if (!insertChip(ref.current, chip)) return;
    setQuery(null);
    send();
  }

  return (
    <>
      <div
        ref={ref}
        id={id}
        className={className + " mention-field" + (value ? "" : " is-empty")}
        contentEditable={!disabled}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-disabled={disabled || undefined}
        data-placeholder={placeholder}
        onInput={() => {
          send();
          scan();
        }}
        onClick={scan}
        onKeyUp={(e) => {
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") scan();
        }}
        onBlur={() => setQuery(null)}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
          scan();
        }}
        onPaste={(e) => {
          e.preventDefault();
          document.execCommand("insertText", false, e.clipboardData?.getData("text/plain") ?? "");
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (open) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const step = e.key === "ArrowDown" ? 1 : -1;
              setActive((i) => (i + step + bots.length) % bots.length);
              return;
            }
            if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
              e.preventDefault();
              pick(bots[active] ?? bots[0]);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setQuery(null);
              return;
            }
          }
          if (e.key === "Enter" && e.shiftKey) {
            e.preventDefault();
            document.execCommand("insertLineBreak");
            send();
            return;
          }
          if (e.key === "Enter") {
            e.preventDefault();
            onEnter();
            return;
          }
          // `@name` typed out and a space after it turns into the chip.
          if (e.key === " " && !composing.current) {
            const ctx = caretTextContext(ref.current);
            const before = ctx?.node.textContent?.slice(0, ctx.offset) ?? "";
            const at = before.match(/(^|[\s])@(\S+)$/);
            const token = at ? trimMentionPunct(at[2]) : "";
            const agent = token ? resolveMention(token, agents) : undefined;
            if (agent && agent.id !== skip) {
              e.preventDefault();
              pick(agent);
            }
          }
        }}
      />
      {open && spot
        ? createPortal(
            <div ref={menuRef} className="mention-float" style={spot}>
              <MentionMenu bots={bots} near={near} active={active} onPick={pick} className="is-floating" />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

/** A label around a field gives it the focus, as it would a textarea. */
export function focusField(label: HTMLElement, target: EventTarget | null) {
  const field = label.querySelector<HTMLElement>(".mention-field");
  if (!field || field.getAttribute("contenteditable") !== "true") return;
  if (field.contains(target as Node)) return;
  field.focus();
  const sel = window.getSelection();
  if (!sel) return;
  const end = document.createRange();
  end.selectNodeContents(field);
  end.collapse(false);
  sel.removeAllRanges();
  sel.addRange(end);
}
