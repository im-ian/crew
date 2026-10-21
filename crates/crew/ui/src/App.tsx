import { useEffect, useRef, useState } from "react";
import { UpdateBanner } from "./components/UpdateBanner";
import { ChatHeader } from "./components/ChatHeader";
import { ChatThread } from "./components/ChatThread";
import { PeekRoom } from "./components/PeekRoom";
import { Composer, type ComposerHandle } from "./components/Composer";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { ContextMenu, type MenuEntry } from "./components/ContextMenu";
import { AgentPane } from "./components/AgentPane";
import { ConnectionBanner } from "./components/ConnectionBanner";
import { NewBotModal } from "./components/NewBotModal";
import { SettingsPane } from "./components/SettingsPane";
import { SkillsPane } from "./components/SkillsPane";
import { ShortcutHelp } from "./components/ShortcutHelp";
import { Sidebar } from "./components/Sidebar";
import { Toast } from "./components/Toast";
import { railOrder } from "./groups";
import { useT } from "./LocaleContext";
import type { TFn } from "./i18n";
import { isTypingTarget, shortcutId } from "./shortcuts";
import {
  applyTheme,
  loadThemePref,
  saveThemePref,
  type ThemePref,
} from "./theme";
import { useCrew } from "./useCrew";
import { useUpdater } from "./updater";

export function App() {
  const t = useT();
  const crew = useCrew();
  const crewRef = useRef(crew);
  crewRef.current = crew;
  const [renameId, setRenameId] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [theme, setTheme] = useState<ThemePref>(loadThemePref);
  const [jumpSeq, setJumpSeq] = useState(0);
  const [peekPeer, setPeekPeer] = useState<string | null>(null);
  const updater = useUpdater();
  const renamingId = crew.pendingRenameId || renameId;
  const searchRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<ComposerHandle>(null);
  const mainRef = useRef<HTMLElement>(null);
  const peekOpen = !!(peekPeer && crew.currentAgent);

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

  useEffect(() => {
    setPeekPeer(null);
  }, [crew.selected, crew.selectedKind]);

  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    for (const el of Array.from(main.children)) {
      if (el.classList.contains("peek-room")) continue;
      if (peekOpen) el.setAttribute("inert", "");
      else el.removeAttribute("inert");
    }
  }, [peekOpen]);

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
      if (peekPeer && e.key === "Escape") {
        if (typing) return;
        e.preventDefault();
        setPeekPeer(null);
        return;
      }
      const id = shortcutId(e, typing);
      if (!id) return;
      if (helpOpen && id !== "help") return;
      e.preventDefault();
      if (
        peekPeer &&
        (id === "composer" ||
          id === "attach" ||
          id === "info" ||
          id === "routines" ||
          id === "approve" ||
          id === "deny" ||
          id === "bottom")
      ) {
        return;
      }
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
        void c.stopAgent();
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
        if (c.currentAgent?.status === "blocked") {
          void c.approveAgent(allow, c.currentAgent.id);
        }
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [helpOpen, settingsOpen, peekPeer]);

  return (
    <div className="app">
      <Sidebar
        agents={crew.agents}
        groups={crew.groups}
        ungrouped={crew.ungrouped}
        selected={crew.selected}
        selectedKind={crew.selectedKind}
        query={crew.query}
        searchHits={crew.searchHits}
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
        unread={crew.unread}
        searchRef={searchRef}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <main ref={mainRef}>
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
          onOpenRoutines={() => {
            if (crew.selected) crew.openRoutines(crew.selected);
          }}
          onStop={(id) => void crew.stopAgent(id)}
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
          onApprove={(allow, id) => void crew.approveAgent(allow, id)}
          onAnswerChoice={(agentId, messageId, answers, values, closed) =>
            crew.answerChoice(agentId, messageId, answers, values, closed)
          }
          highlightId={crew.highlightId}
          onHighlightDone={crew.clearHighlight}
          jumpSeq={jumpSeq}
          onReply={(target) => composerRef.current?.replyTo(target)}
          onJump={crew.highlightMessage}
          onPeek={setPeekPeer}
        />
        <Composer
          ref={composerRef}
          agents={crew.agents}
          selected={crew.selected}
          selectedKind={crew.selectedKind}
          placeholder={crew.placeholder}
          onSend={crew.onSend}
          onJump={crew.highlightMessage}
          busy={
            crew.currentAgent?.status === "working" ||
            crew.currentAgent?.status === "blocked"
          }
          onStop={() => {
            void crew.stopAgent();
          }}
          onOpenSkills={() => setSkillsOpen(true)}
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
          onAddRoutine={crew.addRoutine}
          onToggleRoutine={crew.toggleRoutine}
          onDeleteRoutine={crew.deleteRoutine}
          onRunRoutine={crew.runRoutine}
          onEditRoutine={crew.editRoutine}
          onLoadRoutineRuns={crew.loadRoutineRuns}
          onLoadMemory={crew.loadMemory}
          onSaveMemory={crew.saveMemory}
        />
        {peekPeer && crew.currentAgent ? (
          <PeekRoom
            peerId={peekPeer}
            self={crew.currentAgent}
            messages={crew.messages}
            agents={crew.agents}
            onClose={() => setPeekPeer(null)}
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
        onClose={crew.closeNewBot}
        onCreate={crew.createBot}
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
      <Toast
        text={crew.toast.text}
        show={crew.toast.show}
        onClick={crew.toast.target ? crew.clickToast : undefined}
      />
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
        onClick: () => {
          crew.hideCtx();
          crew.openNewBot();
        },
      },
      {
        type: "action",
        label: t("menu.newGroup"),
        onClick: () => {
          crew.hideCtx();
          crew.createGroup();
        },
      },
    ];
  }
  if (ctx.kind === "group") {
    const id = ctx.id;
    return [
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
        label: t("menu.deleteGroup"),
        danger: true,
        onClick: () => {
          crew.hideCtx();
          if (id) crew.openConfirm(id, "remove-group");
        },
      },
    ];
  }
  const id = ctx.id;
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
