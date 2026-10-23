import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { AgentInfo, Kind, Skill } from "../types";
import { api } from "../api";
import { useT } from "../LocaleContext";
import { mediaKind } from "../markdown";
import { mentionIds, resolveMention, trimMentionPunct } from "../mentions";
import { oneLine, wrapReply, type ReplyTarget } from "../reply";
import { Avatar } from "./Avatar";
import { MentionChip } from "./MentionChip";
import { ArrowUp, CircleDot, Paperclip, Play, Plus, StopSquare, X, Zap } from "../icons";

export type ComposerHandle = {
  focus: () => void;
  attach: () => void;
  replyTo: (target: ReplyTarget) => void;
};

type Props = {
  agents: AgentInfo[];
  selected: string | null;
  selectedKind: Kind;
  placeholder: string;
  onSend: (raw: string, steer: boolean) => Promise<void>;
  busy?: boolean;
  /** The bot is mid-turn, so a message can stop it and go now instead of waiting. */
  canSteer?: boolean;
  onStop?: () => void;
  onOpenSkills?: () => void;
  onJump?: (id: string) => void;
};

type Mention = { start: number; query: string };

type Draft = { html: string; attaches: Attach[]; reply: ReplyTarget | null };

type Attach = {
  id: string;
  name: string;
  path: string;
  image: boolean;
  media?: "video" | "audio";
  preview?: string;
};

export const Composer = forwardRef<ComposerHandle, Props>(function Composer({
  agents,
  selected,
  selectedKind,
  placeholder,
  onSend,
  busy = false,
  canSteer = false,
  onStop,
  onOpenSkills,
  onJump,
}, ref) {
  const t = useT();
  const inputRef = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const [mention, setMention] = useState<Mention | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  const [empty, setEmpty] = useState(true);
  const [slash, setSlash] = useState<Mention | null>(null);
  const [slashIdx, setSlashIdx] = useState(0);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [attaches, setAttaches] = useState<Attach[]>([]);
  const [plusOpen, setPlusOpen] = useState(false);
  const [plusSkills, setPlusSkills] = useState(false);
  const [reply, setReply] = useState<ReplyTarget | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const plusRef = useRef<HTMLDivElement>(null);
  const steerRef = useRef<HTMLButtonElement>(null);

  function focusEditor() {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  useImperativeHandle(ref, () => ({
    focus: focusEditor,
    attach() {
      fileRef.current?.click();
    },
    replyTo(target: ReplyTarget) {
      setReply(target);
      queueMicrotask(focusEditor);
    },
  }));

  const matches = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    const bots = agents.filter((a) => {
      if (selectedKind === "agent" && a.id === selected) return false;
      if (!q) return true;
      return (
        a.id.toLowerCase().includes(q) ||
        (a.name || "").toLowerCase().includes(q)
      );
    });
    return bots.slice(0, 8);
  }, [agents, mention, selected, selectedKind]);

  const skillMatches = useMemo(() => {
    if (!slash) return [];
    const q = slash.query.toLowerCase();
    return skills
      .filter((s) => !q || s.name.toLowerCase().includes(q))
      .slice(0, 8);
  }, [skills, slash]);

  // Refetched whenever a `/` menu opens, so a skill written in Settings shows up
  // without a restart.
  const slashOpening = !!slash;
  useEffect(() => {
    if (!slashOpening && !plusSkills) return;
    void api.listSkills().then(setSkills).catch(() => setSkills([]));
  }, [slashOpening, plusSkills]);

  function closePlus() {
    setPlusOpen(false);
    setPlusSkills(false);
  }

  useEffect(() => {
    if (!plusOpen) return;
    function onDoc(e: MouseEvent) {
      if (!plusRef.current?.contains(e.target as Node)) closePlus();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        closePlus();
      }
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [plusOpen]);

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
    const slashM = before.match(/(^|[\s])\/(\S*)$/);
    if (slashM) {
      setSlash({
        start: before.length - slashM[2].length - 1,
        query: slashM[2],
      });
    } else {
      setSlash(null);
    }
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
    if (!insertChip(inputRef.current, () => renderChip(<MentionChip agent={agent} />))) return;
    setMention(null);
    refreshEmpty();
    fit();
  }

  function pickSkill(skill: Skill) {
    if (!insertSkillBody(inputRef.current, skill.body.trim())) return;
    setSlash(null);
    refreshEmpty();
    fit();
  }

  async function attachFiles(files: FileList | File[]) {
    const next: Attach[] = [];
    try {
      for (const file of Array.from(files)) {
        const data = await readFileData(file);
        const path = await api.saveUpload(file.name, data);
        const media = mediaKind(file.name, file.type) ?? undefined;
        const image = file.type.startsWith("image/") && !media;
        next.push({
          id: `${Date.now()}-${next.length}-${file.name}`,
          name: file.name,
          path,
          image,
          media,
          preview: image ? data : media === "video" ? URL.createObjectURL(file) : undefined,
        });
      }
    } catch (err) {
      for (const a of next) revokePreview(a);
      throw err;
    }
    if (next.length) setAttaches((prev) => [...prev, ...next]);
    refreshEmpty();
    fit();
  }

  function removeAttach(id: string) {
    setAttaches((prev) => {
      revokePreview(prev.find((a) => a.id === id));
      return prev.filter((a) => a.id !== id);
    });
  }

  // One editor serves every chat, so its text has to move aside when the chat does.
  // ponytail: in memory only — a draft dies with the window.
  const drafts = useRef(new Map<string, Draft>());
  const attachRef = useRef(attaches);
  attachRef.current = attaches;
  const replyRef = useRef(reply);
  replyRef.current = reply;
  const chatKey = selected ? `${selectedKind}:${selected}` : "";
  const prevKey = useRef(chatKey);

  useEffect(() => {
    if (prevKey.current === chatKey) return;
    const from = prevKey.current;
    prevKey.current = chatKey;
    const el = inputRef.current;
    if (from && el) {
      const held = attachRef.current;
      const heldReply = replyRef.current;
      if (isEditorEmpty(el) && !held.length && !heldReply) drafts.current.delete(from);
      else drafts.current.set(from, { html: el.innerHTML, attaches: held, reply: heldReply });
    }
    const next = chatKey ? drafts.current.get(chatKey) : undefined;
    if (el) el.innerHTML = next?.html ?? "";
    setAttaches(next?.attaches ?? []);
    setReply(next?.reply ?? null);
    setMention(null);
    setSlash(null);
    closePlus();
    refreshEmpty();
    fit();
  }, [chatKey]);

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
  const slashOpen = !!slash && skillMatches.length > 0;
  const photos = attaches.filter((a) => a.preview && (a.image || a.media === "video"));
  const files = attaches.filter((a) => !a.preview || (!a.image && a.media !== "video"));

  return (
    <form
      className="composer"
      onDragOver={(e) => {
        if (e.dataTransfer?.types?.includes("Files")) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }
      }}
      onDrop={(e) => {
        const files = e.dataTransfer?.files;
        if (files && files.length) {
          e.preventDefault();
          void attachFiles(files);
        }
      }}
      onSubmit={async (e) => {
        e.preventDefault();
        const el = inputRef.current;
        if (!el) return;
        const by = (e.nativeEvent as SubmitEvent).submitter;
        const steer = !!by && by === steerRef.current;
        const text = mentionIds(serializeEditor(el).trim(), agents);
        const files = attaches.map(attachMarkdown).filter(Boolean);
        let raw = [text, files.join("\n")].filter(Boolean).join("\n\n");
        if (!raw.trim()) return;
        if (reply) {
          raw = wrapReply(raw, {
            id: reply.id,
            from: reply.from,
            snippet: reply.text,
          });
        }
        el.innerHTML = "";
        drafts.current.delete(chatKey);
        setMention(null);
        for (const a of attaches) revokePreview(a);
        setAttaches([]);
        setReply(null);
        setEmpty(true);
        fit();
        await onSend(raw, steer);
      }}
    >
      <div
        className={
          "composer-box" +
          (attaches.length ? " has-attach" : "") +
          (reply ? " has-reply" : "")
        }
      >
        {slashOpen ? (
          <div className="mention-menu" role="listbox">
            {skillMatches.map((s, i) => (
              <button
                key={s.name}
                type="button"
                role="option"
                aria-selected={i === slashIdx}
                className={"mention-item" + (i === slashIdx ? " active" : "")}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickSkill(s);
                }}
              >
                <span className="mention-name">/{s.name}</span>
              </button>
            ))}
          </div>
        ) : null}
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
        {reply ? (
          <div className="reply-bar">
            <button
              type="button"
              className="reply-bar-main"
              onClick={() => onJump?.(reply.id)}
            >
              <span className="reply-bar-who">
                {t("composer.replyTo", { who: reply.who })}
              </span>
              <span className="reply-bar-snippet">{oneLine(reply.text)}</span>
            </button>
            <button
              type="button"
              className="reply-bar-close"
              title={t("composer.replyCancel")}
              aria-label={t("composer.replyCancel")}
              onClick={() => setReply(null)}
            >
              <X size={14} />
            </button>
          </div>
        ) : null}
        {photos.length ? (
          <div className={"attach-photos" + (photos.length === 1 ? " is-one" : "")}>
            {photos.map((a) => (
              <div key={a.id} className="attach-photo">
                <span className="attach-photo-frame">
                  {a.media === "video" ? (
                    <>
                      <video src={`${a.preview}#t=0.1`} muted playsInline preload="metadata" />
                      <span className="attach-play">
                        <Play size={12} className="md-media-play" />
                      </span>
                    </>
                  ) : (
                    <img src={a.preview} alt="" />
                  )}
                </span>
                <button
                  type="button"
                  className="attach-remove"
                  title={t("composer.detach")}
                  aria-label={t("composer.detachNamed", { name: a.name })}
                  onClick={() => removeAttach(a.id)}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        {files.length ? (
          <div className="attach-row">
            {files.map((a) => (
              <div key={a.id} className="attach-chip">
                <span className="attach-file">{fileExt(a.name)}</span>
                <span className="attach-name">{a.name}</span>
                <button
                  type="button"
                  className="attach-remove"
                  title={t("composer.detach")}
                  aria-label={t("composer.detachNamed", { name: a.name })}
                  onClick={() => removeAttach(a.id)}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <div className="composer-row">
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) void attachFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <div className="plus-wrap" ref={plusRef}>
          {plusOpen ? (
            <div className="plus-menu" role="menu">
              {plusSkills ? (
                <>
                  {!skills.length ? (
                    <div className="plus-menu-empty">{t("skills.empty")}</div>
                  ) : (
                    skills.map((s) => (
                      <button
                        key={s.name}
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          pickSkill(s);
                          closePlus();
                        }}
                      >
                        <span className="mention-name">/{s.name}</span>
                      </button>
                    ))
                  )}
                  {onOpenSkills ? (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        closePlus();
                        onOpenSkills();
                      }}
                    >
                      <span className="plus-menu-icon" aria-hidden="true">
                        <Plus />
                      </span>
                      {t("skills.new")}
                    </button>
                  ) : null}
                </>
              ) : (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      closePlus();
                      fileRef.current?.click();
                    }}
                  >
                    <span className="plus-menu-icon" aria-hidden="true">
                      <Paperclip />
                    </span>
                    {t("composer.attach")}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => setPlusSkills(true)}
                  >
                    <span className="plus-menu-icon is-teach" aria-hidden="true">
                      <CircleDot />
                    </span>
                    {t("composer.teach")}
                  </button>
                </>
              )}
            </div>
          ) : null}
          <button
            type="button"
            className={"attach-btn" + (plusOpen ? " is-open" : "")}
            title={t("composer.plus")}
            aria-label={t("composer.plus")}
            aria-expanded={plusOpen}
            aria-haspopup="menu"
            onClick={() => {
              setPlusOpen((open) => {
                if (open) setPlusSkills(false);
                return !open;
              });
            }}
          >
            <Plus />
          </button>
        </div>
        <div
          ref={inputRef}
          className={"composer-input" + (empty ? " is-empty" : "")}
          contentEditable
          role="textbox"
          aria-multiline="true"
          data-placeholder={
            busy ? t("composer.busy") : placeholder
          }
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
            const files = e.clipboardData?.files;
            if (files && files.length) {
              e.preventDefault();
              void attachFiles(files);
              return;
            }
            e.preventDefault();
            const text = e.clipboardData?.getData("text/plain") ?? "";
            document.execCommand("insertText", false, text);
          }}
          onKeyDown={(e) => {
            if (slashOpen) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSlashIdx((i) => (i + 1) % skillMatches.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setSlashIdx((i) => (i - 1 + skillMatches.length) % skillMatches.length);
                return;
              }
              if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                e.preventDefault();
                const skill = skillMatches[slashIdx] ?? skillMatches[0];
                if (skill) pickSkill(skill);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setSlash(null);
                return;
              }
            }
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
            if (e.key === "Escape" && reply) {
              e.preventDefault();
              setReply(null);
              return;
            }
            if (e.key === "Enter" && e.shiftKey && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              (e.currentTarget.closest("form") as HTMLFormElement | null)?.requestSubmit(
                steerRef.current ?? undefined,
              );
              return;
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
              const at = before.match(/(^|[\s])@(\S+)$/);
              const token = at ? trimMentionPunct(at[2]) : "";
              const agent = token ? resolveMention(token, agents) : undefined;
              if (agent && insertChip(inputRef.current, () => renderChip(<MentionChip agent={agent} />))) {
                e.preventDefault();
                setMention(null);
                refreshEmpty();
                fit();
              }
            }
          }}
        />
        {busy && onStop ? (
          <button
            type="button"
            className="stop-btn"
            title={t("composer.stopTitle")}
            aria-label={t("composer.stop")}
            onClick={onStop}
          >
            <StopSquare size={12} />
          </button>
        ) : null}
        {canSteer ? (
          <button
            ref={steerRef}
            type="submit"
            className="steer-btn"
            title={t("composer.steerTitle")}
            aria-label={t("composer.steer")}
            disabled={!selected || (empty && !attaches.length)}
          >
            <Zap size={15} />
          </button>
        ) : null}
        <button
          type="submit"
          aria-label={t("composer.send")}
          disabled={!selected || (empty && !attaches.length)}
        >
          <ArrowUp size={16} />
        </button>
        </div>
      </div>
    </form>
  );
});

function attachMarkdown(a: Attach): string {
  const alt = a.name.replace(/[\[\]\\]/g, " ");
  // Spaces and parentheses end a bare destination.
  const dest = /[\s()]/.test(a.path) ? `<${a.path.replaceAll("<", "%3C").replaceAll(">", "%3E")}>` : a.path;
  if (a.image) return `![${alt}](${dest})`;
  // The saved file has no extension, so the title is what the bubble plays.
  if (a.media) return `[${alt}](${dest} "${a.media}")`;
  return `[${alt}](${dest})`;
}

function revokePreview(a: Attach | undefined) {
  if (a?.preview?.startsWith("blob:")) URL.revokeObjectURL(a.preview);
}

function fileExt(name: string): string {
  const i = name.lastIndexOf(".");
  if (i <= 0 || i === name.length - 1) return "FILE";
  return name.slice(i + 1).slice(0, 4).toUpperCase();
}

function insertSkillBody(editor: HTMLElement | null, body: string): boolean {
  if (insertSlashText(editor, body)) return true;
  if (!editor) return false;
  editor.focus();
  const text = body.endsWith(" ") ? body : body + " ";
  if (document.execCommand("insertText", false, text)) return true;
  editor.append(document.createTextNode(text));
  const sel = window.getSelection();
  if (sel) {
    sel.removeAllRanges();
    const after = document.createRange();
    after.selectNodeContents(editor);
    after.collapse(false);
    sel.addRange(after);
  }
  return true;
}

function insertSlashText(editor: HTMLElement | null, body: string): boolean {
  const ctx = caretTextContext(editor);
  if (!ctx) return false;
  const prefix = ctx.node.textContent?.slice(0, ctx.offset) ?? "";
  const m = prefix.match(/(^|[\s])\/(\S*)$/);
  if (!m) return false;
  const start = prefix.length - m[2].length - 1;
  const range = document.createRange();
  range.setStart(ctx.node, start);
  range.setEnd(ctx.node, ctx.offset);
  range.deleteContents();
  const text = document.createTextNode(body + " ");
  range.insertNode(text);
  const sel = window.getSelection();
  if (sel) {
    sel.removeAllRanges();
    const after = document.createRange();
    after.setStart(text, text.data.length);
    after.collapse(true);
    sel.addRange(after);
  }
  return true;
}

function readFileData(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function insertChip(
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

function renderChip(node: ReactNode): HTMLElement {
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
