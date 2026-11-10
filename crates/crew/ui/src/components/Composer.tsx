import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { AgentInfo, EditResult, Kind, Skill } from "../types";
import { api } from "../api";
import { useT } from "../LocaleContext";
import { useBotLabel, useLabelGroups } from "../BotLabelContext";
import { mediaKind } from "../markdown";
import {
  mentionIds,
  resolveMention,
  trimMentionPunct,
} from "../mentions";
import { sendSteers, type Delivery } from "../deliveryPref";
import { composerAfterSend } from "../sendGate";
import { stepQueuePick } from "../queuePick";
import { oneLine, wrapReply, type ReplyTarget } from "../reply";
import { caretClientPoint, type CaretPoint } from "../caretPoint";
import { dropPathsText } from "../dropPaths";
import type { AskPick } from "./AskHoldDialog";
import { MentionChip } from "./MentionChip";
import { MentionMenu } from "./MentionMenu";
import {
  caretTextContext,
  insertChip,
  isEditorEmpty,
  mentionCandidates,
  renderChip,
  serializeEditor,
} from "./mentionEditor";
import { ArrowUp, CircleDot, Paperclip, Play, Plus, StopSquare, X } from "../icons";

export type ComposerHandle = {
  focus: () => void;
  attach: () => void;
  replyTo: (target: ReplyTarget) => void;
  /** Change a message still waiting for the bot. */
  edit: (messageId: string, text: string, reply: ReplyTarget | null) => void;
};

type Props = {
  agents: AgentInfo[];
  selected: string | null;
  selectedKind: Kind;
  placeholder: string;
  /** False when the daemon did not take the message. The draft comes back. */
  onSend: (raw: string, steer: boolean) => Promise<boolean>;
  onEdit?: (messageId: string, raw: string) => Promise<EditResult>;
  /** User lines still waiting, oldest first. */
  waitingIds?: string[];
  /** The waiting line ArrowUp is on, if any. */
  queuePick?: string | null;
  onQueuePick?: (id: string | null) => void;
  /** Enter on the picked line opens it for editing. */
  onEditWaiting?: (id: string) => void;
  busy?: boolean;
  /** The bot is mid-turn, so a message can stop it and go now instead of waiting. */
  canSteer?: boolean;
  /** The bot answered and only watches background work: a send waits for it. */
  watching?: boolean;
  /** Queue waits behind a working bot. Interrupt cuts in on a normal send. */
  delivery?: Delivery;
  onStop?: () => void;
  onOpenSkills?: () => void;
  onJump?: (id: string) => void;
  /** Bots whose composer still holds unsent text, files, or a reply. */
  onDrafts?: (ids: string[]) => void;
  /** Caret while a prompt is being typed. Null when the field is idle. */
  onCaret?: (point: CaretPoint | null) => void;
  /** Set while the bot waits on a question: a send asks first what to do. */
  askHold?: () => Promise<AskPick>;
};

type Mention = { start: number; query: string };

type Draft = { html: string; attaches: Attach[]; reply: ReplyTarget | null };

/** A waiting message open in the editor, and what was typed before it. */
type Editing = { id: string; text: string; was: Draft };

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
  onEdit,
  waitingIds = [],
  queuePick = null,
  onQueuePick,
  onEditWaiting,
  busy = false,
  canSteer = false,
  watching = false,
  delivery = "interrupt",
  onStop,
  onOpenSkills,
  onJump,
  onDrafts,
  onCaret,
  askHold,
}, ref) {
  const t = useT();
  const labelOf = useBotLabel();
  const groups = useLabelGroups();
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
  const [editing, setEditing] = useState<Editing | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const plusRef = useRef<HTMLDivElement>(null);
  const pendingSteer = useRef(false);
  const onDraftsRef = useRef(onDrafts);
  onDraftsRef.current = onDrafts;

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
    edit(id: string, text: string, target: ReplyTarget | null) {
      const el = inputRef.current;
      if (!el) return;
      if (editingRef.current) for (const a of attachRef.current) revokePreview(a);
      const was = editingRef.current?.was ?? {
        html: isEditorEmpty(el) ? "" : el.innerHTML,
        attaches: attachRef.current,
        reply: replyRef.current,
      };
      el.textContent = text;
      setAttaches([]);
      setReply(target);
      setEditing({ id, text, was });
      setMention(null);
      setSlash(null);
      refreshEmpty();
      fit();
      queueMicrotask(focusEditor);
    },
  }));

  const { bots: matches, near: mentionNear } = useMemo(
    () =>
      mention
        ? mentionCandidates(agents, groups, mention.query, selectedKind === "agent" ? selected : null)
        : { bots: [], near: 0 },
    [agents, groups, mention, selected, selectedKind],
  );

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
    if (!insertChip(inputRef.current, () => renderChip(<MentionChip agent={agent} label={labelOf(agent)} />))) return;
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
  const editingRef = useRef(editing);
  editingRef.current = editing;

  /** The daemon refused the send. Put the draft back in the chat it left. */
  function restoreDraft(key: string, snapshot: Draft) {
    if (prevKey.current !== key) {
      // A switch already stored what was typed after this send.
      if (!drafts.current.has(key)) drafts.current.set(key, snapshot);
      return;
    }
    const el = inputRef.current;
    if ((el && !isEditorEmpty(el)) || attachRef.current.length || replyRef.current) return;
    if (el) el.innerHTML = snapshot.html;
    attachRef.current = snapshot.attaches;
    replyRef.current = snapshot.reply;
    drafts.current.set(key, snapshot);
    setAttaches(snapshot.attaches);
    setReply(snapshot.reply);
    setMention(null);
    setSlash(null);
    refreshEmpty();
    fit();
  }

  /** Back to what was typed before the edit. */
  function putBack(was: Draft) {
    const el = inputRef.current;
    if (el) el.innerHTML = was.html;
    // Read before the next render by a chat switch.
    attachRef.current = was.attaches;
    replyRef.current = was.reply;
    editingRef.current = null;
    setAttaches(was.attaches);
    setReply(was.reply);
    setEditing(null);
    setMention(null);
    setSlash(null);
    refreshEmpty();
    fit();
  }

  /** Leave the edit; the message stays as it was. */
  function dropEdit() {
    const ed = editingRef.current;
    if (!ed) return;
    for (const a of attachRef.current) revokePreview(a);
    putBack(ed.was);
  }
  const onCaretRef = useRef(onCaret);
  onCaretRef.current = onCaret;
  const chatKey = selected ? `${selectedKind}:${selected}` : "";

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const publish = () => {
      const node = inputRef.current;
      if (!node || document.activeElement !== node || isEditorEmpty(node)) {
        onCaretRef.current?.(null);
        return;
      }
      const point = caretClientPoint(node);
      if (point) onCaretRef.current?.(point);
    };
    const blur = () => onCaretRef.current?.(null);
    const box = new ResizeObserver(publish);
    el.addEventListener("focus", publish);
    el.addEventListener("input", publish);
    el.addEventListener("keyup", publish);
    el.addEventListener("pointerup", publish);
    el.addEventListener("scroll", publish);
    el.addEventListener("blur", blur);
    document.addEventListener("selectionchange", publish);
    window.addEventListener("resize", publish);
    box.observe(el);
    return () => {
      el.removeEventListener("focus", publish);
      el.removeEventListener("input", publish);
      el.removeEventListener("keyup", publish);
      el.removeEventListener("pointerup", publish);
      el.removeEventListener("scroll", publish);
      el.removeEventListener("blur", blur);
      document.removeEventListener("selectionchange", publish);
      window.removeEventListener("resize", publish);
      box.disconnect();
      onCaretRef.current?.(null);
    };
  }, [chatKey]);
  const prevKey = useRef(chatKey);

  useEffect(() => {
    if (prevKey.current === chatKey) return;
    const from = prevKey.current;
    prevKey.current = chatKey;
    const el = inputRef.current;
    // Leaving the chat drops the edit, and the message stays as it was.
    dropEdit();
    if (from && el) {
      const held = attachRef.current;
      const heldReply = replyRef.current;
      if (isEditorEmpty(el) && !held.length && !heldReply) drafts.current.delete(from);
      else drafts.current.set(from, { html: el.innerHTML, attaches: held, reply: heldReply });
    }
    const next = chatKey ? drafts.current.get(chatKey) : undefined;
    const nextAttaches = next?.attaches ?? [];
    const nextReply = next?.reply ?? null;
    // The draft report below reads these before the next render.
    attachRef.current = nextAttaches;
    replyRef.current = nextReply;
    if (el) {
      el.innerHTML = next?.html ?? "";
      if (document.activeElement === el && !isEditorEmpty(el)) {
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        onCaretRef.current?.(caretClientPoint(el));
      } else {
        onCaretRef.current?.(null);
      }
    }
    setAttaches(nextAttaches);
    setReply(nextReply);
    setMention(null);
    setSlash(null);
    closePlus();
    refreshEmpty();
    fit();
  }, [chatKey]);

  useEffect(() => {
    const ids = new Set<string>();
    for (const key of drafts.current.keys()) {
      if (!key.startsWith("agent:")) continue;
      const id = key.slice("agent:".length);
      if (id) ids.add(id);
    }
    if (selectedKind === "agent" && selected) {
      const el = inputRef.current;
      const live =
        (!!el && !isEditorEmpty(el)) ||
        attachRef.current.length > 0 ||
        !!replyRef.current;
      if (live) ids.add(selected);
      else ids.delete(selected);
    }
    onDraftsRef.current?.([...ids].sort());
  }, [attaches, reply, empty, editing, chatKey, selected, selectedKind]);

  useEffect(() => {
    fit();
  }, [placeholder]);

  const dropRef = useRef<(paths: string[]) => void>(() => {});
  dropRef.current = (paths) => {
    // A dialog over the chat keeps its focus. The drop is not for the field under it.
    if (document.querySelector(".modal.open, [aria-modal='true']")) return;
    if (!insertDroppedPaths(inputRef.current, paths)) return;
    refreshEmpty();
    fit();
  };

  // The window takes a file dropped from Finder before the page sees it, and
  // hands over where it is. That path is typed in, so the bot reads the file
  // where it sits.
  useEffect(() => {
    let off: (() => void) | undefined;
    let gone = false;
    void (async () => {
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        const unlisten = await getCurrentWebview().onDragDropEvent((e) => {
          if (e.payload.type === "drop") dropRef.current(e.payload.paths);
        });
        if (gone) unlisten();
        else off = unlisten;
      } catch {
        /* browser preview */
      }
    })();
    return () => {
      gone = true;
      off?.();
    };
  }, []);

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
      onSubmit={async (e) => {
        e.preventDefault();
        const el = inputRef.current;
        if (!el) return;
        const steer = sendSteers(pendingSteer.current, delivery, canSteer, watching);
        pendingSteer.current = false;
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
        if (editing) {
          const { id, was } = editing;
          const result = await onEdit?.(id, raw);
          // Dropped, or another edit opened, while this one saved.
          if (editingRef.current !== editing) return;
          if (result === "saved") {
            for (const a of attachRef.current) revokePreview(a);
            putBack(was);
          } else if (result === "gone") {
            // It went out first. The edit stays to send as a new message, with
            // what was typed before it after it.
            if (was.html) el.insertAdjacentHTML("beforeend", `<div>${was.html}</div>`);
            setAttaches([...attachRef.current, ...was.attaches]);
            setReply(replyRef.current ?? was.reply);
            setEditing(null);
            refreshEmpty();
            fit();
          }
          return;
        }
        let steerNow = steer;
        if (askHold) {
          // The dialog takes the keys. Typing must not go on behind it.
          el.blur();
          const pick = await askHold();
          if (pick === "cancel") focusEditor();
          if (pick !== "send") return;
          // Another chat opened while it was up; this draft is not its send.
          if (prevKey.current !== chatKey) return;
          // Over the question, the message cuts in whatever the setting says.
          steerNow = true;
          queueMicrotask(focusEditor);
        }
        const key = chatKey;
        const snapshot: Draft = {
          html: el.innerHTML,
          attaches: attachRef.current,
          reply: replyRef.current,
        };
        el.innerHTML = "";
        drafts.current.delete(key);
        setMention(null);
        setAttaches([]);
        setReply(null);
        setEmpty(true);
        fit();
        let accepted = false;
        try {
          accepted = await onSend(raw, steerNow);
        } catch {
          accepted = false;
        }
        // Cleared before the daemon answered. Failure puts that draft back.
        if (composerAfterSend(accepted, snapshot.html) === null) {
          for (const a of snapshot.attaches) revokePreview(a);
          return;
        }
        restoreDraft(key, snapshot);
      }}
    >
      <div
        className={
          "composer-box" +
          (attaches.length ? " has-attach" : "") +
          (reply || editing ? " has-reply" : "")
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
          <MentionMenu bots={matches} near={mentionNear} active={mentionIdx} onPick={pickMention} />
        ) : null}
        {editing ? (
          <div className="reply-bar">
            <button
              type="button"
              className="reply-bar-main"
              onClick={() => onJump?.(editing.id)}
            >
              <span className="reply-bar-who">{t("composer.editing")}</span>
              <span className="reply-bar-snippet">{oneLine(editing.text)}</span>
            </button>
            <button
              type="button"
              className="reply-bar-close"
              title={t("composer.editCancel")}
              aria-label={t("composer.editCancel")}
              onClick={dropEdit}
            >
              <X size={14} />
            </button>
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
            watching
              ? t("composer.watching")
              : busy
                ? t("composer.busy")
                : placeholder
          }
          onInput={() => {
            refreshEmpty();
            fit();
            scanMention();
            if (queuePick) onQueuePick?.(null);
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
            if (
              !editing &&
              !reply &&
              attaches.length === 0 &&
              !e.metaKey &&
              !e.ctrlKey &&
              !e.altKey &&
              !e.shiftKey &&
              isEditorEmpty(e.currentTarget) &&
              waitingIds.length > 0
            ) {
              if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                e.preventDefault();
                onQueuePick?.(
                  stepQueuePick(
                    waitingIds,
                    queuePick,
                    e.key === "ArrowUp" ? "prev" : "next",
                  ),
                );
                return;
              }
              if (e.key === "Enter" && queuePick) {
                e.preventDefault();
                onEditWaiting?.(queuePick);
                return;
              }
            }
            if (e.key === "Escape" && editing) {
              e.preventDefault();
              dropEdit();
              return;
            }
            if (e.key === "Escape" && reply) {
              e.preventDefault();
              setReply(null);
              return;
            }
            if (e.key === "Enter" && e.shiftKey && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              if (canSteer) pendingSteer.current = true;
              (e.currentTarget.closest("form") as HTMLFormElement | null)?.requestSubmit();
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
              if (agent && insertChip(inputRef.current, () => renderChip(<MentionChip agent={agent} label={labelOf(agent)} />))) {
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
        <button
          type="submit"
          aria-label={t(editing ? "composer.editSave" : "composer.send")}
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

/** Types dropped paths at the caret, or at the end when the caret is elsewhere. */
function insertDroppedPaths(editor: HTMLElement | null, paths: string[]): boolean {
  if (!editor) return false;
  const sel = window.getSelection();
  const inside = !!sel && sel.rangeCount > 0 && editor.contains(sel.anchorNode);
  editor.focus();
  if (sel && !inside) {
    const end = document.createRange();
    end.selectNodeContents(editor);
    end.collapse(false);
    sel.removeAllRanges();
    sel.addRange(end);
  }
  const ctx = caretTextContext(editor);
  const before = ctx
    ? ctx.node.textContent?.slice(0, ctx.offset) ?? ""
    : inside
      ? ""
      : editor.textContent ?? "";
  const text = dropPathsText(paths, before);
  if (!text) return false;
  if (document.execCommand("insertText", false, text)) return true;
  if (!sel || sel.rangeCount === 0) {
    editor.append(document.createTextNode(text));
    return true;
  }
  const range = sel.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
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

