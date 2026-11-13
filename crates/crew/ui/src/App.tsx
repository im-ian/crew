import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { UpdateBanner } from "./components/UpdateBanner";
import { ChatHeader } from "./components/ChatHeader";
import { ChatThread, sideOnlyPeer } from "./components/ChatThread";
import { PeekRoom } from "./components/PeekRoom";
import { Composer, type ComposerHandle } from "./components/Composer";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { ContextMenu, type MenuEntry } from "./components/ContextMenu";
import { AgentPane } from "./components/AgentPane";
import { ConnectionBanner } from "./components/ConnectionBanner";
import { NewBotModal } from "./components/NewBotModal";
import { NewGroupModal } from "./components/NewGroupModal";
import { RemoteAddModal } from "./components/RemoteAddModal";
import { GroupSettingsModal } from "./components/GroupSettingsModal";
import { SettingsPane } from "./components/SettingsPane";
import { SkillsPane } from "./components/SkillsPane";
import { ShortcutHelp } from "./components/ShortcutHelp";
import { Sidebar } from "./components/Sidebar";
import { Island } from "./components/Island";
import { chatOrder, loadRemoteFolds, loadRemoteLayout, representing } from "./remote";
import { copyText } from "./components/CopyButton";
import { useT } from "./LocaleContext";
import { BotLabelProvider } from "./BotLabelContext";
import {
  FileOpenContext,
  fileRun,
  freshFileRow,
  parseFileRef,
  sameFile,
  type FileTarget,
} from "./fileRef";
import { FileView } from "./components/FileView";
import { X } from "./icons";
import type { TFn } from "./i18n";
import { isTypingTarget, shortcutId } from "./shortcuts";
import { popoverIsOpen } from "./usePopover";
import {
  applyTheme,
  loadThemePref,
  saveThemePref,
  type ThemePref,
} from "./theme";
import { loadChatWidth, saveChatWidth } from "./chatWidth";
import { loadDelivery, saveDelivery } from "./deliveryPref";
import { loadShowTools, saveShowTools } from "./tools";
import { waitingEdit, waitingIds } from "./queuePick";
import { publishCaret } from "./caretPoint";
import { stopTurn } from "./sendGate";
import { useCrew } from "./useCrew";
import { useUpdater } from "./updater";
import { api } from "./api";
import { escapeLayerOpen } from "./escapeLayer";
import { watchHoldsSend } from "./watchView";
import { AskHoldDialog, type AskPick } from "./components/AskHoldDialog";
import { openQuestionIds, questionFocusTarget } from "./questionJump";
import { loadAiList } from "./aiListSync";
import {
  closeSlot,
  dropInto,
  dropSide,
  openSlot,
  openSplit,
  placeOpen,
  prunePanes,
  type DropSide,
  type Slot,
  type Split,
  type SplitDir,
} from "./split";
import { usePaneMessages } from "./usePaneMessages";
import type { AgentInfo } from "./types";

export function App() {
  const t = useT();
  const crew = useCrew();
  const crewRef = useRef(crew);
  crewRef.current = crew;
  const [renameId, setRenameId] = useState<string | null>(null);
  const [drafting, setDrafting] = useState<string[]>([]);
  const [helpOpen, setHelpOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  // Asked from settings, so it is drawn over them and Escape shuts it first.
  // The alias outlives the dialog, so its title holds while it fades out.
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [leaveAlias, setLeaveAlias] = useState("");
  const [theme, setTheme] = useState<ThemePref>(loadThemePref);
  const [showTools, setShowTools] = useState(loadShowTools);
  const [chatWidth, setChatWidth] = useState(loadChatWidth);
  const [delivery, setDelivery] = useState(loadDelivery);
  const [jumpSeq, setJumpSeq] = useState(0);
  const [queuePick, setQueuePick] = useState<string | null>(null);
  const waiting = useMemo(() => waitingIds(crew.messages), [crew.messages]);
  // A send while the bot waits on a question asks first; `agent` is the chat it was in.
  // `busy` while "send anyway" closes the questions: the dialog stays up and
  // holds the keys until the send goes.
  const [askHold, setAskHold] = useState<{
    agent: string;
    resolve: (pick: AskPick) => void;
    busy?: boolean;
  } | null>(null);
  const askHoldRef = useRef(askHold);
  askHoldRef.current = askHold;
  const openAsks = useMemo(
    () =>
      crew.selectedKind === "agent" && crew.selected && crew.messagesFor === crew.selected
        ? openQuestionIds(crew.messages)
        : [],
    [crew.selectedKind, crew.selected, crew.messagesFor, crew.messages],
  );
  // `focus` is the run that was clicked, flashed where it sits; the panel
  // opens at the bottom. A search hit is opened on instead (`openAtFocus`).
  const [peek, setPeek] = useState<{
    peer: string;
    focus: string[];
    openAtFocus?: boolean;
  } | null>(null);
  const updater = useUpdater();
  const renamingId = crew.pendingRenameId || renameId;
  const searchRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<ComposerHandle>(null);
  const peekOpen = !!(peek && crew.currentAgent);
  // Files beside the chat take the panel's place; one or the other is open.
  // `list` is the files shown together, one tab each; `at` is the one shown.
  const [file, setFile] = useState<{ list: FileTarget[]; at: number } | null>(null);
  const fileOpen = !!(file && crew.currentAgent);
  const current = file ? file.list[file.at] ?? null : null;
  // The file rows each chat had when it was first loaded. One that arrives
  // after is a bot running `crew show` now, and opens.
  const seenFiles = useRef(new Map<string, Set<string>>());
  const openFile = useCallback((target: FileTarget, group?: FileTarget[]) => {
    setPeek(null);
    const list = group?.length ? group : [target];
    const at = list.findIndex((f) => sameFile(f, target));
    setFile(at < 0 ? { list: [...list, target], at: list.length } : { list, at });
  }, []);
  const fileCtx = useMemo(() => ({ open: openFile, current }), [openFile, current]);
  const autoFor = useRef<string | null>(null);
  const hitFor = useRef<string | null>(null);

  // The chat split in two. The open chat is one half and has the composer;
  // the other half shows its own bot until it is clicked.
  const [split, setSplit] = useState<Split | null>(null);
  const openId = crew.selectedKind === "agent" ? crew.selected : null;
  // What the effect below is about to store, so no frame shows the old half.
  const view = useMemo(() => placeOpen(split, openId), [split, openId]);
  const viewRef = useRef(view);
  viewRef.current = view;
  useEffect(() => {
    setSplit((cur) => placeOpen(cur, openId));
  }, [openId]);
  useEffect(() => {
    if (!crew.agents.length) return;
    const live = new Set(crew.agents.map((a) => a.id));
    setSplit((cur) => prunePanes(cur, live));
  }, [crew.agents]);
  const active = view ? openSlot(view, openId) : null;
  const slotIds: [string | null, string | null] = view ? view.panes : [openId, null];
  const slotAgents = slotIds.map((id) =>
    id ? crew.agents.find((a) => a.id === id) ?? null : null,
  ) as [AgentInfo | null, AgentInfo | null];
  const liveRows = openId && crew.messagesFor === openId ? crew.messages : null;
  const rows0 = usePaneMessages(
    view ? slotIds[0] : null,
    active === 0 ? liveRows : null,
    paneHot(slotAgents[0]),
  );
  const rows1 = usePaneMessages(
    view ? slotIds[1] : null,
    active === 1 ? liveRows : null,
    paneHot(slotAgents[1]),
  );
  // Where each half was scrolled. The open half's is the crew's own.
  const [paneStick, setPaneStick] = useState<[boolean, boolean]>([true, true]);
  useEffect(() => {
    if (active === null) return;
    setPaneStick((cur) => {
      if (cur[active] === crew.stick) return cur;
      const next: [boolean, boolean] = [...cur];
      next[active] = crew.stick;
      return next;
    });
  }, [active, crew.stick]);
  const [dropHint, setDropHint] = useState<DropSide | null>(null);
  const mainRef = useRef<HTMLElement>(null);

  function splitChat(dir: SplitDir) {
    setSplit((cur) => openSplit(placeOpen(cur, openId), dir, openId));
  }

  function unsplit() {
    setSplit(null);
  }

  /**
   * A click on a half: the next pick lands there, and its bot becomes the open
   * chat. `type` puts the caret in the composer, as a click on its stand-in does.
   */
  function focusSlot(slot: Slot, type = false) {
    const cur = viewRef.current;
    if (!cur) return;
    const id = cur.panes[slot];
    if (cur.target !== slot) setSplit({ ...cur, target: slot });
    const c = crewRef.current;
    if (id && id !== c.selected) {
      c.selectAgent(id, null, type);
      c.setStick(paneStick[slot]);
    }
  }

  function closeHalf(slot: Slot) {
    const cur = viewRef.current;
    if (!cur) return;
    const { keep } = closeSlot(cur, slot);
    setSplit(null);
    const c = crewRef.current;
    if (keep && keep !== c.selected) c.selectAgent(keep);
  }

  function chatSide(x: number, y: number): DropSide | null {
    const el = mainRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
    return dropSide(x, y, r);
  }

  function onChatDrag(id: string | null, x: number, y: number, drop: boolean) {
    const side = id ? chatSide(x, y) : null;
    if (!drop) {
      setDropHint((cur) =>
        cur && side && cur.dir === side.dir && cur.slot === side.slot ? cur : side,
      );
      return;
    }
    setDropHint(null);
    if (!id || !side) return;
    const c = crewRef.current;
    const open = c.selectedKind === "agent" ? c.selected : null;
    setSplit(dropInto(viewRef.current, id, side, open));
    if (id !== open) c.selectAgent(id);
  }

  const splitCommand = useRef<(cmd: string) => void>(() => undefined);
  splitCommand.current = (cmd: string) => {
    if (cmd === "row" || cmd === "col") splitChat(cmd);
    else if (cmd === "close") unsplit();
  };
  useEffect(() => {
    let off: (() => void) | null = null;
    let gone = false;
    import("@tauri-apps/api/event")
      .then(({ listen }) => listen<string>("split", (e) => splitCommand.current(e.payload)))
      .then((stop) => {
        if (gone) stop();
        else off = stop;
      })
      .catch(() => undefined);
    return () => {
      gone = true;
      off?.();
    };
  }, []);

  useEffect(() => {
    setQueuePick(null);
  }, [crew.selected]);

  useEffect(() => {
    if (queuePick && !waiting.includes(queuePick)) setQueuePick(null);
  }, [queuePick, waiting]);

  function finishRename() {
    crew.clearPendingRename();
    setRenameId(null);
  }

  // The default AI moved into a list the daemon reads when a bot's own AI
  // is out of its limit. The old single default moves in once.
  useEffect(() => {
    void loadAiList().catch(() => {});
  }, []);

  useEffect(() => {
    void updater.init();
    void updater.check();
    const interval = window.setInterval(
      () => void updater.check(),
      24 * 60 * 60 * 1000,
    );
    return () => window.clearInterval(interval);
  }, []);

  // Layout effects, in this order: a switch shuts the panel before the next
  // one opens, with no frame painted between.
  useLayoutEffect(() => {
    setPeek(null);
    setFile(null);
    autoFor.current = null;
  }, [crew.selected, crew.selectedKind]);

  useEffect(() => {
    const chat = crew.messagesFor;
    if (!chat) return;
    const files = crew.messages.filter((m) => m.kind === "file").map((m) => m.id);
    const seen = seenFiles.current.get(chat);
    const fresh = freshFileRow(seen, crew.messages);
    seenFiles.current.set(chat, new Set([...(seen ?? []), ...files]));
    if (fresh) {
      const run = fileRun(crew.messages, fresh.id).map((m) => parseFileRef(m.text));
      openFile(parseFileRef(fresh.text), run);
    }
  }, [crew.messagesFor, crew.messages, openFile]);

  // A bot with only side chats opens its latest beside the empty thread, and
  // a search hit opens the one it is in. Once per pick, when that bot's own
  // messages land: a note arriving later must not pop it open mid-sentence.
  useLayoutEffect(() => {
    const sel = crew.selected;
    const hit = crew.highlightId;
    if (!sel || crew.messagesFor !== sel) return;
    if (!hit) hitFor.current = null;
    if (autoFor.current === sel && (!hit || hitFor.current === hit)) return;
    autoFor.current = sel;
    hitFor.current = hit;
    const peer = sideOnlyPeer(crew.messages, crew.agents, hit, crew.selected);
    if (peer) {
      setFile(null);
      setPeek({ peer, focus: hit ? [hit] : [], openAtFocus: !!hit });
    }
  }, [
    crew.selected,
    crew.messagesFor,
    crew.messages,
    crew.agents,
    crew.highlightId,
  ]);

  function holdForQuestion(agent: string): Promise<AskPick> {
    return new Promise((resolve) => setAskHold({ agent, resolve }));
  }

  /** Brings the question into view, with the keys on its first answer. */
  function goToQuestion(id: string) {
    crew.highlightMessage(id);
    let tries = 0;
    // The row may mount only after the thread scrolls to it.
    const step = () => {
      const card = document.querySelector(
        `[data-msg-id="${CSS.escape(id)}"] .choice-card.is-pending`,
      );
      const target = card ? questionFocusTarget(card) : null;
      if (target) {
        target.focus({ preventScroll: true });
        return;
      }
      if (++tries < 30) requestAnimationFrame(step);
      // Answered elsewhere, or never drawn: the keys go back to the draft.
      else composerRef.current?.focus();
    };
    requestAnimationFrame(step);
  }

  async function pickAsk(pick: AskPick) {
    const hold = askHoldRef.current;
    // The first pick decides; one already under way takes no other.
    if (!hold || hold.busy) return;
    const c = crewRef.current;
    const here = c.selectedKind === "agent" && c.selected === hold.agent;
    const asks = here && c.messagesFor === hold.agent ? openQuestionIds(c.messages) : [];
    if (pick === "send") {
      const busy = { ...hold, busy: true };
      askHoldRef.current = busy;
      setAskHold(busy);
      // Closed first, so a bot that cannot be cut into is not left asking.
      // A bot that can is stopped by the send, which closes them too.
      await Promise.all(
        asks.map((id) =>
          c.answerChoice(hold.agent, id, [], [], [], true).catch(() => undefined),
        ),
      );
    }
    askHoldRef.current = null;
    setAskHold(null);
    if (pick === "go") {
      const last = asks[asks.length - 1];
      // Answered or closed while the dialog was up: back to the draft.
      if (!last) {
        hold.resolve("cancel");
        return;
      }
      goToQuestion(last);
    }
    hold.resolve(pick);
  }

  function togglePeek(peer: string, focus: string[] = []) {
    setFile(null);
    setPeek((cur) =>
      cur && cur.peer === peer && cur.focus[0] === focus[0]
        ? null
        : { peer, focus },
    );
  }

  useEffect(() => {
    applyTheme(theme);
    saveThemePref(theme);
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  useEffect(() => {
    let current: boolean | null = null;
    let queued = false;
    const sync = () => {
      const open = escapeLayerOpen(document);
      if (open === current) return;
      current = open;
      void api.setEscapeLayer(open);
    };
    // After this turn's DOM writes, and before the next key.
    const schedule = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        sync();
      });
    };
    schedule();
    const obs = new MutationObserver(schedule);
    obs.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class", "data-popover-open"],
    });
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.isComposing) return;
      // The skills window handles its own Escape, and no shortcut should act
      // on the app hidden behind it. The question dialog takes its own keys too.
      if (skillsOpen || askHoldRef.current) return;
      if (leaveOpen) {
        if (e.key === "Escape") {
          e.preventDefault();
          setLeaveOpen(false);
        }
        return;
      }
      if ((settingsOpen || helpOpen) && e.key === "Escape" && popoverIsOpen()) return;
      if (settingsOpen && e.key === "Escape") {
        e.preventDefault();
        setSettingsOpen(false);
        return;
      }
      if (helpOpen && e.key === "Escape") {
        e.preventDefault();
        setHelpOpen(false);
        return;
      }
      const c = crewRef.current;
      if (c.confirmOpen) return;
      const typing = isTypingTarget(e.target);
      if ((peek || file) && e.key === "Escape") {
        if (typing) return;
        e.preventDefault();
        setPeek(null);
        setFile(null);
        return;
      }
      const id = shortcutId(e, typing);
      // The composer sends with ⌘⇧↩. Anywhere else the key keeps its own use.
      if (!id || id === "steer") return;
      if (helpOpen && id !== "help") return;
      e.preventDefault();
      if (id === "help") {
        setHelpOpen((open) => !open);
        return;
      }
      if (id === "settings") {
        setSettingsOpen((open) => !open);
        return;
      }
      if (settingsOpen) setSettingsOpen(false);
      if (id === "search") {
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (id === "composer") {
        composerRef.current?.focus();
        return;
      }
      if (id === "attach") {
        composerRef.current?.attach();
        return;
      }
      if (id === "new-bot") {
        c.openNewBot();
        return;
      }
      if (id === "quick-bot") {
        // A held key repeats. One press, one bot.
        if (!e.repeat) void c.createQuickBot();
        return;
      }
      if (id === "info") {
        if (c.selected) c.openInfo(c.selected);
        return;
      }
      if (id === "routines") {
        if (c.selectedKind === "agent" && c.selected) c.openRoutines(c.selected);
        return;
      }
      if (id === "stop") {
        stopTurn(() => void c.stopAgent());
        return;
      }
      if (id === "bottom") {
        setJumpSeq((n) => n + 1);
        return;
      }
      if (id === "split-row" || id === "split-col") {
        splitCommand.current(id === "split-row" ? "row" : "col");
        return;
      }
      if (id === "prev-chat" || id === "next-chat") {
        const order = chatOrder(
          { groups: c.groups, ungrouped: c.ungrouped, order: c.order },
          c.agents,
          c.remotes,
          loadRemoteFolds(),
          loadRemoteLayout(),
        );
        if (!order.length) return;
        const i = order.findIndex(
          (row) => row.kind === c.selectedKind && row.id === c.selected,
        );
        const next =
          id === "next-chat"
            ? order[(i < 0 ? 0 : i + 1) % order.length]
            : order[(i < 0 ? order.length - 1 : i - 1 + order.length) % order.length];
        c.selectAgent(next.id);
        return;
      }
      if (id === "approve" || id === "deny") {
        const allow = id === "approve";
        const agent = c.currentAgent;
        const waiting =
          agent?.status === "blocked" &&
          c.messagesFor === agent.id &&
          c.messages.some((m) => m.approval === "pending");
        if (waiting && agent) void c.approveAgent(allow, agent.id);
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [helpOpen, settingsOpen, skillsOpen, peek, file, leaveOpen]);

  function renderSlot(slot: Slot) {
    const id = slotIds[slot];
    const agent = slotAgents[slot];
    const rows = slot === 0 ? rows0 : rows1;
    const target = !!view && view.target === slot;
    const onClose = view ? () => closeHalf(slot) : undefined;
    const cls =
      "split-pane" +
      (view && slot === active ? " is-open" : "") +
      (target ? " is-target" : "") +
      (view && !id ? " is-empty" : "");
    // The open half already has the keys. A click there leaves an empty
    // half waiting for its pick.
    const onPointerDownCapture = view
      ? () => {
          if (slot !== active) focusSlot(slot);
        }
      : undefined;
    if (view && !id) {
      return (
        <section className={cls} data-slot={slot} onPointerDownCapture={onPointerDownCapture}>
          <header data-tauri-drag-region="deep">
            <div className="head-identity" />
            <button
              type="button"
              className="head-action"
              title={t("split.close")}
              aria-label={t("split.close")}
              onClick={onClose}
            >
              <X />
            </button>
          </header>
          <div className="split-empty">
            <p>{target ? t("split.emptyTarget") : t("split.empty")}</p>
            <p className="split-empty-hint">{t("split.drop")}</p>
          </div>
        </section>
      );
    }
    if (view && slot !== active) {
      return (
        <section className={cls} data-slot={slot} onPointerDownCapture={onPointerDownCapture}>
          <ChatHeader
            currentAgent={agent}
            groups={crew.groups}
            onOpenInfo={() => {
              if (id) crew.openInfo(id);
            }}
            onRenameAgent={(bot, name) => void crew.renameAgent(bot, name)}
            onClose={onClose}
          />
          <ChatThread
            messages={rows ?? []}
            agents={crew.agents}
            selected={id}
            selectedKind="agent"
            currentAgent={agent}
            stick={paneStick[slot]}
            onStick={(stick) =>
              setPaneStick((cur) => {
                if (cur[slot] === stick) return cur;
                const next: [boolean, boolean] = [...cur];
                next[slot] = stick;
                return next;
              })
            }
            streaming={paneHot(agent)}
            onSelectAgent={crew.selectAgent}
            ready={!!rows}
            showTools={showTools}
            lookAtCaret={false}
          />
        </section>
      );
    }
    return (
      <section className={cls} data-slot={slot} onPointerDownCapture={onPointerDownCapture}>
        <ChatHeader
          currentAgent={crew.currentAgent}
          groups={crew.groups}
          onOpenInfo={() => {
            if (crew.selected) crew.openInfo(crew.selected);
          }}
          onRenameAgent={(id, name) => void crew.renameAgent(id, name)}
          onClose={onClose}
        />
        <ChatThread
          messages={liveRows ?? rows ?? crew.messages}
          agents={crew.agents}
          selected={crew.selected}
          selectedKind={crew.selectedKind}
          currentAgent={crew.currentAgent}
          stick={crew.stick}
          onStick={crew.setStick}
          streaming={
            crew.selectedKind === "agent" &&
            !watchHoldsSend(crew.currentAgent) &&
            (crew.currentAgent?.status === "working" ||
              crew.currentAgent?.status === "blocked")
          }
          onSelectAgent={crew.selectAgent}
          onApprove={(allow, id, always) =>
            void crew.approveAgent(allow, id, !!always)
          }
          onCancelQueued={(id) => void crew.cancelQueued(id)}
          onEditQueued={(id, text, reply) =>
            composerRef.current?.edit(id, text, reply)
          }
          onSendQueued={(id) => void crew.sendQueued(id)}
          queuePick={queuePick}
          onAnswerChoice={(agentId, messageId, answers, values, others, closed) =>
            crew.answerChoice(agentId, messageId, answers, values, others, closed)
          }
          highlightId={crew.highlightId}
          onHighlightDone={crew.clearHighlight}
          openedRead={crew.openedRead}
          ready={!!liveRows || !!rows || crew.messagesFor === crew.selected}
          jumpSeq={jumpSeq}
          onReply={(target) => composerRef.current?.replyTo(target)}
          onJump={crew.highlightMessage}
          peekFocus={peekOpen ? peek?.focus[0] ?? null : null}
          onPeek={togglePeek}
          showTools={showTools}
          onOpenRoutines={
            crew.currentAgent?.remote
              ? undefined
              : () => {
                  if (crew.selected) crew.openRoutines(crew.selected);
                }
          }
          lookAtCaret={
            crew.currentAgent?.status !== "working" &&
            crew.currentAgent?.status !== "blocked" &&
            crew.currentAgent?.status !== "exited"
          }
        />
      </section>
    );
  }

  const app = (
    <div className="app">
      <Sidebar
        agents={crew.agents}
        remotes={crew.remotes}
        groups={crew.groups}
        ungrouped={crew.ungrouped}
        order={crew.order}
        selected={crew.selected}
        selectedKind={crew.selectedKind}
        query={crew.query}
        searchHits={
          showTools
            ? crew.searchHits
            : crew.searchHits.filter((hit) => hit.kind !== "tool")
        }
        renamingId={renamingId}
        onQuery={crew.setQuery}
        onSearchHit={crew.openSearchHit}
        onSelectAgent={crew.selectAgent}
        onCreateMenu={crew.showCreateMenu}
        onSplitMenu={crew.showSplitMenu}
        splitDir={view?.dir ?? null}
        onChatDrag={onChatDrag}
        onAgentCtx={(e, id) => crew.showCtx(e, id, "agent")}
        onGroupCtx={(e, id) => crew.showCtx(e, id, "group")}
        onGroupMenu={crew.showGroupMenu}
        onGroupNewBot={crew.openNewBot}
        onToggleGroup={crew.toggleGroup}
        focusedGroup={crew.focusedGroup}
        onFocusGroup={crew.focusGroup}
        onRenameGroup={crew.renameGroup}
        onStartRenameGroup={(id) => {
          crew.clearPendingRename();
          setRenameId(id);
        }}
        onRenameAgent={(id, name) => void crew.renameAgent(id, name)}
        onRenameDone={finishRename}
        onMove={crew.moveToGroup}
        onReorderGroup={crew.reorderGroup}
        unread={crew.unread}
        drafting={drafting}
        searchRef={searchRef}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <main
        ref={mainRef}
        className={
          [(peekOpen || fileOpen) && "has-peek", chatWidth === "narrow" && "narrow-chat"]
            .filter(Boolean)
            .join(" ") || undefined
        }
      >
        <div className="titlebar-align" data-tauri-drag-region />
        {/* `connected` starts null — not checked yet, which is not a failure. */}
        <ConnectionBanner
          visible={crew.connected === false}
          detail={crew.connDetail}
        />
        <UpdateBanner
          visible={updater.shouldNotify}
          version={updater.available?.version}
          busy={updater.busy}
          error={updater.error}
          onInstall={() => void updater.install()}
          onLater={updater.dismiss}
          onClearError={updater.clearError}
        />
        <div
          className={view ? "chat-split is-split" : "chat-split"}
          data-dir={view?.dir}
          data-open={active ?? undefined}
        >
          {renderSlot(0)}
          {view ? renderSlot(1) : null}
          <Composer
            ref={composerRef}
            agents={crew.agents}
            selected={crew.selected}
            selectedKind={crew.selectedKind}
            focusNonce={crew.composerFocus}
            placeholder={crew.placeholder}
            onSend={crew.onSend}
            onEdit={crew.editQueued}
            waitingIds={waiting}
            queuePick={queuePick}
            onQueuePick={setQueuePick}
            onEditWaiting={(id) => {
              const message = crew.messages.find((m) => m.id === id);
              if (!message) return;
              const next = waitingEdit(message.text || "", crew.agents, t);
              setQueuePick(null);
              composerRef.current?.edit(id, next.body, next.reply);
            }}
            onJump={crew.highlightMessage}
            busy={
              crew.currentAgent?.status === "working" ||
              crew.currentAgent?.status === "blocked"
            }
            canSteer={crew.currentAgent?.status === "working"}
            watching={watchHoldsSend(crew.currentAgent)}
            delivery={delivery}
            onStop={() => stopTurn(() => void crew.stopAgent())}
            onOpenSkills={() => setSkillsOpen(true)}
            onCaret={publishCaret}
            askHold={
              openAsks.length && crew.selected
                ? holdForQuestion.bind(null, crew.selected)
                : undefined
            }
            onDrafts={(ids) =>
              setDrafting((prev) =>
                prev.length === ids.length && prev.every((id, i) => id === ids[i])
                  ? prev
                  : ids,
              )
            }
          />
          {view && active !== null && slotIds[active === 0 ? 1 : 0] ? (
            <div className="composer split-standin" data-slot={active === 0 ? 1 : 0}>
              <button
                type="button"
                className="composer-box"
                onClick={() => focusSlot(active === 0 ? 1 : 0, true)}
              >
                {t("split.standin", {
                  name:
                    slotAgents[active === 0 ? 1 : 0]?.name ||
                    slotIds[active === 0 ? 1 : 0] ||
                    "",
                })}
              </button>
            </div>
          ) : null}
        </div>
        {dropHint ? (
          <div className="split-drop" data-dir={dropHint.dir} data-slot={dropHint.slot} />
        ) : null}
        <AgentPane
          open={crew.paneOpen}
          tab={crew.paneTab}
          agent={crew.currentAgent}
          onTab={crew.setPaneTab}
          onClose={crew.closePane}
          onReset={() => {
            crew.closePane();
            if (crew.selected) crew.openConfirm(crew.selected, "reset");
          }}
          onSetFace={crew.saveAgentFace}
          onSave={crew.saveAgentInfo}
          onSetCli={crew.saveAgentCli}
          onToggleRoutine={crew.toggleRoutine}
          onDeleteRoutine={crew.deleteRoutine}
          onRunRoutine={crew.runRoutine}
        />
        {file && crew.currentAgent ? (
          <FileView
            files={file.list}
            at={file.at}
            onPick={(at) => setFile((cur) => (cur ? { ...cur, at } : cur))}
            onClose={() => setFile(null)}
          />
        ) : null}
        {peek && crew.currentAgent ? (
          <PeekRoom
            peerId={peek.peer}
            focus={peek.focus}
            openAtFocus={peek.openAtFocus}
            self={crew.currentAgent}
            messages={crew.messages}
            agents={crew.agents}
            onClose={() => setPeek(null)}
          />
        ) : null}
      </main>
      <AskHoldDialog
        open={!!askHold}
        busy={!!askHold?.busy}
        onPick={(pick) => void pickAsk(pick)}
      />
      <ConfirmDialog
        open={crew.confirmOpen}
        kind={crew.confirmKind}
        represents={
          crew.confirmKind === "remove" && crew.confirmId
            ? representing(crew.confirmId, crew.remotes)
            : []
        }
        onCancel={crew.closeConfirm}
        onConfirm={(drop) => void crew.doConfirm(drop)}
      />
      <NewBotModal
        open={crew.newBotOpen}
        groups={crew.groups}
        placeId={crew.newBotPlace}
        onClose={crew.closeNewBot}
        onCreate={crew.createBot}
      />
      <NewGroupModal
        open={crew.newGroupOpen}
        onClose={crew.closeNewGroup}
        onPickFolder={crew.pickFolder}
        onCreate={crew.createNamedGroup}
      />
      <RemoteAddModal
        open={crew.remoteAddOpen}
        aliases={crew.remotes.map((r) => r.alias)}
        onClose={crew.closeRemoteAdd}
        onJoin={crew.joinRemote}
      />
      <GroupSettingsModal
        open={!!crew.groupSettingsId}
        group={crew.groups.find((g) => g.id === crew.groupSettingsId) ?? null}
        onClose={crew.closeGroupSettings}
        onPickFolder={crew.pickFolder}
        onLoad={crew.loadGroupMemory}
        onSave={crew.saveGroupSettings}
      />
      <ContextMenu
        open={crew.ctx.open}
        x={crew.ctx.x}
        y={crew.ctx.y}
        items={menuItems(crew, setRenameId, t, {
          on: !!view,
          split: (dir) => {
            crew.hideCtx();
            splitChat(dir);
          },
          off: () => {
            crew.hideCtx();
            unsplit();
          },
        })}
      />
      <SettingsPane
        open={settingsOpen}
        theme={theme}
        onTheme={setTheme}
        chatWidth={chatWidth}
        onChatWidth={(width) => {
          setChatWidth(width);
          saveChatWidth(width);
        }}
        showTools={showTools}
        onShowTools={(show) => {
          setShowTools(show);
          saveShowTools(show);
        }}
        delivery={delivery}
        onDelivery={(mode) => {
          setDelivery(mode);
          saveDelivery(mode);
        }}
        onClose={() => setSettingsOpen(false)}
        onOpenSkills={() => {
          setSettingsOpen(false);
          setSkillsOpen(true);
        }}
        updater={updater}
        remotes={crew.remotes}
        agents={crew.agents}
        onSetRemote={crew.setRemote}
        onLeaveRemote={(alias) => {
          setLeaveAlias(alias);
          setLeaveOpen(true);
        }}
        onAddRemote={() => {
          setSettingsOpen(false);
          crew.openRemoteAdd();
        }}
      />
      <ConfirmDialog
        open={leaveOpen}
        kind="leave-remote"
        leaving={{
          alias: leaveAlias,
          name: crew.remotes.find((r) => r.alias === leaveAlias)?.name ?? "",
        }}
        onCancel={() => setLeaveOpen(false)}
        onConfirm={() => {
          setLeaveOpen(false);
          if (leaveAlias) void crew.leaveRemote(leaveAlias);
        }}
      />
      <SkillsPane open={skillsOpen} onClose={() => setSkillsOpen(false)} />
      <ShortcutHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
      <Island
        notices={crew.islands}
        agents={crew.agents}
        onOpenBot={(id) => {
          // The bot may already be open behind a blurred window; the click answers it either way.
          crew.closeBotNotices(id);
          crew.selectAgent(id);
        }}
        onClose={crew.closeIsland}
        onClearPile={crew.clearPile}
        onHold={crew.holdIsland}
        onRelease={crew.releaseIsland}
      />
    </div>
  );
  // Bots in the open chat's group go by their name; the rest say their group.
  return (
    <BotLabelProvider
      groups={crew.groups}
      viewer={crew.selectedKind === "agent" ? crew.selected : null}
    >
      <FileOpenContext.Provider value={fileCtx}>{app}</FileOpenContext.Provider>
    </BotLabelProvider>
  );
}

/** A half that works or waits is polled as fast as the open chat. */
function paneHot(agent: AgentInfo | null): boolean {
  return (
    !!agent &&
    !watchHoldsSend(agent) &&
    (agent.status === "working" || agent.status === "blocked")
  );
}

type SplitMenu = { on: boolean; split: (dir: SplitDir) => void; off: () => void };

function menuItems(
  crew: ReturnType<typeof useCrew>,
  setRenameId: (id: string | null) => void,
  t: TFn,
  split: SplitMenu,
): MenuEntry[] {
  const { ctx, groups } = crew;
  if (ctx.kind === "split") {
    const items: MenuEntry[] = [
      { type: "action", label: t("split.row"), hint: "⌘D", onClick: () => split.split("row") },
      { type: "action", label: t("split.col"), hint: "⌘⇧D", onClick: () => split.split("col") },
    ];
    if (split.on) {
      items.push({ type: "sep" }, { type: "action", label: t("split.off"), onClick: split.off });
    }
    return items;
  }
  if (ctx.kind === "create") {
    return [
      {
        type: "action",
        label: t("menu.newBot"),
        hint: "⌘N",
        onClick: () => {
          crew.hideCtx();
          crew.openNewBot();
        },
      },
      { type: "sep" },
      {
        type: "action",
        label: t("menu.newGroup"),
        onClick: () => {
          crew.hideCtx();
          crew.openNewGroup();
        },
      },
      {
        type: "action",
        label: t("menu.addRemote"),
        onClick: () => {
          crew.hideCtx();
          crew.openRemoteAdd();
        },
      },
    ];
  }
  if (ctx.kind === "group") {
    const id = ctx.id;
    const items: MenuEntry[] = [];
    items.push(
      {
        type: "action",
        label: t("menu.rename"),
        onClick: () => {
          crew.hideCtx();
          if (id) setRenameId(id);
        },
      },
      {
        type: "action",
        label: t("menu.groupSettings"),
        onClick: () => {
          crew.hideCtx();
          if (id) crew.openGroupSettings(id);
        },
      },
      {
        type: "action",
        label: t("menu.deleteGroup"),
        danger: true,
        onClick: () => {
          crew.hideCtx();
          if (id) crew.openConfirm(id, "remove-group");
        },
      },
    );
    return items;
  }
  const id = ctx.id;
  const remote = crew.agents.find((a) => a.id === id && a.remote);
  if (remote) {
    // A teammate's bot is only talked to: nothing of it lives on this PC.
    return [
      {
        type: "action",
        label: t("menu.openChat"),
        onClick: () => {
          crew.hideCtx();
          crew.selectAgent(remote.id);
        },
      },
      {
        type: "action",
        label: t("menu.copyMention"),
        onClick: () => {
          crew.hideCtx();
          void copyText("@" + remote.id).then((ok) => {
            if (ok) crew.showToast(t("common.copied"), "ok", true);
          });
        },
      },
    ];
  }
  const currentGroup = id ? crew.itemGroupId("agent", id) : null;
  const moveItems: MenuEntry[] = groups
    .filter((g) => g.id !== currentGroup)
    .map((g) => ({
      type: "action" as const,
      label: g.name,
      onClick: () => {
        crew.hideCtx();
        if (id) crew.moveToGroup("agent", id, g.id);
      },
    }));
  if (currentGroup) {
    moveItems.push({
      type: "action",
      label: t("menu.leaveGroup"),
      onClick: () => {
        crew.hideCtx();
        if (id) crew.moveToGroup("agent", id, null);
      },
    });
  }
  const items: MenuEntry[] = [
    {
      type: "action",
      label: t("menu.clearChat"),
      onClick: () => {
        crew.hideCtx();
        if (id) crew.openConfirm(id, "reset");
      },
    },
    {
      type: "action",
      label: t("menu.cloneBot"),
      onClick: () => {
        crew.hideCtx();
        if (id) void crew.cloneBot(id);
      },
    },
    { type: "sep" },
  ];
  if (moveItems.length) {
    items.push({ type: "sub", label: t("menu.moveToGroup"), items: moveItems });
  }
  items.push({
    type: "action",
    label: t("menu.moveToNewGroup"),
    onClick: () => {
      crew.hideCtx();
      if (id) crew.createGroup({ kind: "agent", id });
    },
  });
  const leads = !!currentGroup && groups.find((g) => g.id === currentGroup)?.lead === id;
  if (currentGroup) {
    items.push({
      type: "action",
      label: leads ? t("menu.clearLead") : t("menu.makeLead"),
      onClick: () => {
        crew.hideCtx();
        if (id) crew.setLead(currentGroup, leads ? null : id);
      },
    });
  }
  items.push({ type: "sep" });
  items.push({
    type: "action",
    label: t("menu.deleteBot"),
    danger: true,
    onClick: () => {
      crew.hideCtx();
      if (id) crew.openConfirm(id, "remove");
    },
  });
  return items;
}
