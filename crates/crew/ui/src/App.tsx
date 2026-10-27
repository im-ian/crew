import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { NewProjectModal } from "./components/NewProjectModal";
import { SettingsPane } from "./components/SettingsPane";
import { SkillsPane } from "./components/SkillsPane";
import { ShortcutHelp } from "./components/ShortcutHelp";
import { Sidebar } from "./components/Sidebar";
import { Toast } from "./components/Toast";
import { railOrder } from "./groups";
import { Folder, Layers } from "./icons";
import { useT } from "./LocaleContext";
import type { TFn } from "./i18n";
import { isTypingTarget, shortcutId } from "./shortcuts";
import { popoverIsOpen } from "./usePopover";
import {
  applyTheme,
  loadThemePref,
  saveThemePref,
  type ThemePref,
} from "./theme";
import { loadDelivery, saveDelivery } from "./deliveryPref";
import { loadShowTools, saveShowTools } from "./tools";
import { waitingEdit, waitingIds } from "./queuePick";
import { samePoint, type CaretPoint } from "./caretPoint";
import { stopTurn } from "./sendGate";
import { useCrew } from "./useCrew";
import { useUpdater } from "./updater";

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
  const [theme, setTheme] = useState<ThemePref>(loadThemePref);
  const [showTools, setShowTools] = useState(loadShowTools);
  const [delivery, setDelivery] = useState(loadDelivery);
  const [jumpSeq, setJumpSeq] = useState(0);
  const [queuePick, setQueuePick] = useState<string | null>(null);
  const [caretAt, setCaretAt] = useState<CaretPoint | null>(null);
  const caretRef = useRef<CaretPoint | null>(null);
  const waiting = useMemo(() => waitingIds(crew.messages), [crew.messages]);
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
  const autoFor = useRef<string | null>(null);
  const hitFor = useRef<string | null>(null);

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
    autoFor.current = null;
  }, [crew.selected, crew.selectedKind]);

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
    if (peer) setPeek({ peer, focus: hit ? [hit] : [], openAtFocus: !!hit });
  }, [
    crew.selected,
    crew.messagesFor,
    crew.messages,
    crew.agents,
    crew.highlightId,
  ]);

  function togglePeek(peer: string, focus: string[] = []) {
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
    function onKey(e: KeyboardEvent) {
      if (e.isComposing) return;
      // The skills window handles its own Escape, and no shortcut should act
      // on the app hidden behind it.
      if (skillsOpen) return;
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
      if (peek && e.key === "Escape") {
        if (typing) return;
        e.preventDefault();
        setPeek(null);
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
      if (id === "prev-chat" || id === "next-chat") {
        const order = railOrder(c.groups, c.ungrouped, c.agents);
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
  }, [helpOpen, settingsOpen, skillsOpen, peek]);

  return (
    <div className="app">
      <Sidebar
        agents={crew.agents}
        groups={crew.groups}
        ungrouped={crew.ungrouped}
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
        onAgentCtx={(e, id) => crew.showCtx(e, id, "agent")}
        onGroupCtx={(e, id) => crew.showCtx(e, id, "group")}
        onToggleGroup={crew.toggleGroup}
        onRenameGroup={crew.renameGroup}
        onRenameDone={finishRename}
        onMove={crew.moveToGroup}
        onReorderGroup={crew.reorderGroup}
        unread={crew.unread}
        drafting={drafting}
        searchRef={searchRef}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <main className={peekOpen ? "has-peek" : undefined}>
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
        <ChatHeader
          currentAgent={crew.currentAgent}
          onOpenInfo={() => {
            if (crew.selected) crew.openInfo(crew.selected);
          }}
        />
        <ChatThread
          messages={crew.messages}
          agents={crew.agents}
          selected={crew.selected}
          selectedKind={crew.selectedKind}
          currentAgent={crew.currentAgent}
          stick={crew.stick}
          onStick={crew.setStick}
          streaming={
            crew.selectedKind === "agent" &&
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
          onAnswerChoice={(agentId, messageId, answers, values, closed) =>
            crew.answerChoice(agentId, messageId, answers, values, closed)
          }
          highlightId={crew.highlightId}
          onHighlightDone={crew.clearHighlight}
          jumpSeq={jumpSeq}
          onReply={(target) => composerRef.current?.replyTo(target)}
          onJump={crew.highlightMessage}
          peekFocus={peekOpen ? peek?.focus[0] ?? null : null}
          onPeek={togglePeek}
          showTools={showTools}
          onOpenRoutines={() => {
            if (crew.selected) crew.openRoutines(crew.selected);
          }}
          lookAt={
            crew.currentAgent?.status === "working" ||
            crew.currentAgent?.status === "blocked" ||
            crew.currentAgent?.status === "exited"
              ? null
              : caretAt
          }
        />
        <Composer
          ref={composerRef}
          agents={crew.agents}
          selected={crew.selected}
          selectedKind={crew.selectedKind}
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
          delivery={delivery}
          onStop={() => stopTurn(() => void crew.stopAgent())}
          onOpenSkills={() => setSkillsOpen(true)}
          onCaret={(point) => {
            if (samePoint(caretRef.current, point)) return;
            caretRef.current = point;
            setCaretAt(point);
          }}
          onDrafts={(ids) =>
            setDrafting((prev) =>
              prev.length === ids.length && prev.every((id, i) => id === ids[i])
                ? prev
                : ids,
            )
          }
        />
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
          onLoadMemory={crew.loadMemory}
          onSaveMemory={crew.saveMemory}
          agents={crew.agents}
          onLoadShared={crew.loadShared}
          onSaveShared={crew.saveShared}
        />
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
      <ConfirmDialog
        open={crew.confirmOpen}
        kind={crew.confirmKind}
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
      <NewProjectModal
        open={crew.newProjectOpen}
        onClose={crew.closeNewProject}
        onPickFolder={crew.pickProjectFolder}
        onCreate={crew.createProject}
      />
      <ContextMenu
        open={crew.ctx.open}
        x={crew.ctx.x}
        y={crew.ctx.y}
        items={menuItems(crew, setRenameId, t)}
      />
      <SettingsPane
        open={settingsOpen}
        theme={theme}
        onTheme={setTheme}
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
        onOpenShortcuts={() => {
          setSettingsOpen(false);
          setHelpOpen(true);
        }}
        onOpenSkills={() => {
          setSettingsOpen(false);
          setSkillsOpen(true);
        }}
        updater={updater}
      />
      <SkillsPane open={skillsOpen} onClose={() => setSkillsOpen(false)} />
      <ShortcutHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
      <Toast text={crew.toast.text} show={crew.toast.show} />
    </div>
  );
}

function menuItems(
  crew: ReturnType<typeof useCrew>,
  setRenameId: (id: string | null) => void,
  t: TFn,
): MenuEntry[] {
  const { ctx, groups } = crew;
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
        icon: <Layers size={14} />,
        onClick: () => {
          crew.hideCtx();
          crew.createGroup();
        },
      },
      {
        type: "action",
        label: t("menu.newProject"),
        icon: <Folder size={14} />,
        onClick: () => {
          crew.hideCtx();
          crew.openNewProject();
        },
      },
    ];
  }
  if (ctx.kind === "group") {
    const id = ctx.id;
    const project = id ? groups.find((g) => g.id === id) : undefined;
    const items: MenuEntry[] = [];
    if (id) {
      items.push({
        type: "action",
        label: t("menu.newBot"),
        onClick: () => {
          crew.hideCtx();
          crew.openNewBot(id);
        },
      });
      items.push({ type: "sep" });
    }
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
        label: project?.path ? t("menu.deleteProject") : t("menu.deleteGroup"),
        danger: true,
        onClick: () => {
          crew.hideCtx();
          if (id) crew.openConfirm(id, project?.path ? "remove-project" : "remove-group");
        },
      },
    );
    return items;
  }
  const id = ctx.id;
  const currentGroup = id ? crew.itemGroupId("agent", id) : null;
  const moveItems: MenuEntry[] = groups
    .filter((g) => g.id !== currentGroup)
    .map((g) => ({
      type: "action" as const,
      label: g.name,
      icon: g.path ? <Folder size={14} /> : <Layers size={14} />,
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
