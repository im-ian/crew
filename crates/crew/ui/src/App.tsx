import { useEffect, useRef, useState } from "react";
import { ChatHeader } from "./components/ChatHeader";
import { ChatThread } from "./components/ChatThread";
import { Composer, type ComposerHandle } from "./components/Composer";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { ContextMenu, type MenuEntry } from "./components/ContextMenu";
import { AgentPane } from "./components/AgentPane";
import { ChannelPane } from "./components/ChannelPane";
import { NewBotModal } from "./components/NewBotModal";
import { NewChannelModal } from "./components/NewChannelModal";
import { SettingsPane } from "./components/SettingsPane";
import { SkillsPane } from "./components/SkillsPane";
import { ShortcutHelp } from "./components/ShortcutHelp";
import { Sidebar } from "./components/Sidebar";
import { Toast } from "./components/Toast";
import { busyInChannel } from "./busy";
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
import type { Kind } from "./types";
import { useCrew } from "./useCrew";

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
  const renamingId = crew.pendingRenameId || renameId;
  const searchRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<ComposerHandle>(null);

  function finishRename() {
    crew.clearPendingRename();
    setRenameId(null);
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
      const id = shortcutId(e, typing);
      if (!id) return;
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
      if (id === "new-channel") {
        c.openNewChannel();
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
        if (c.selectedKind === "channel" && c.currentChannel) {
          const working = busyInChannel(c.agents, c.currentChannel.id).filter(
            (a) => a.status === "working",
          );
          for (const a of working) void c.stopAgent(a.id);
          return;
        }
        void c.stopAgent();
        return;
      }
      if (id === "bottom") {
        setJumpSeq((n) => n + 1);
        return;
      }
      if (id === "prev-chat" || id === "next-chat") {
        const order = railOrder(c.groups, c.ungrouped, c.agents, c.channels);
        if (!order.length) return;
        const i = order.findIndex(
          (row) => row.kind === c.selectedKind && row.id === c.selected,
        );
        const next =
          id === "next-chat"
            ? order[(i < 0 ? 0 : i + 1) % order.length]
            : order[(i < 0 ? order.length - 1 : i - 1 + order.length) % order.length];
        if (next.kind === "channel") c.selectChannel(next.id);
        else c.selectAgent(next.id);
        return;
      }
      if (id === "approve" || id === "deny") {
        const allow = id === "approve";
        if (c.selectedKind === "agent" && c.currentAgent?.status === "blocked") {
          void c.approveAgent(allow, c.currentAgent.id);
          return;
        }
        const blocked = busyInChannel(c.agents, c.currentChannel?.id).find(
          (a) => a.status === "blocked",
        );
        if (blocked) void c.approveAgent(allow, blocked.id);
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [helpOpen, settingsOpen]);

  return (
    <div className="app">
      <Sidebar
        agents={crew.agents}
        channels={crew.channels}
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
        onSelectChannel={crew.selectChannel}
        onCreateMenu={crew.showCreateMenu}
        onAgentCtx={(e, id) => crew.showCtx(e, id, "agent")}
        onChannelCtx={(e, id) => crew.showCtx(e, id, "channel")}
        onGroupCtx={(e, id) => crew.showCtx(e, id, "group")}
        onToggleGroup={crew.toggleGroup}
        onRenameGroup={crew.renameGroup}
        onRenameDone={finishRename}
        onMove={crew.moveToGroup}
        unread={crew.unread}
        searchRef={searchRef}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <main>
        <div className="titlebar-align" data-tauri-drag-region />
        <ChatHeader
          currentAgent={crew.currentAgent}
          currentChannel={crew.currentChannel}
          agents={crew.agents}
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
          channels={crew.channels}
          selected={crew.selected}
          selectedKind={crew.selectedKind}
          currentAgent={crew.currentAgent}
          currentChannel={crew.currentChannel}
          stick={crew.stick}
          onStick={crew.setStick}
          streaming={
            crew.selectedKind === "agent" &&
            (crew.currentAgent?.status === "working" ||
              crew.currentAgent?.status === "blocked")
          }
          onSelectAgent={crew.selectAgent}
          onSelectChannel={crew.selectChannel}
          onApprove={(allow, id) => void crew.approveAgent(allow, id)}
          highlightId={crew.highlightId}
          onHighlightDone={crew.clearHighlight}
          jumpSeq={jumpSeq}
        />
        <Composer
          ref={composerRef}
          agents={crew.agents}
          channels={crew.channels}
          selected={crew.selected}
          selectedKind={crew.selectedKind}
          placeholder={crew.placeholder}
          onSend={crew.onSend}
          busy={
            (crew.selectedKind === "agent" &&
              (crew.currentAgent?.status === "working" ||
                crew.currentAgent?.status === "blocked")) ||
            (crew.selectedKind === "channel" &&
              busyInChannel(crew.agents, crew.currentChannel?.id).some(
                (a) => a.status === "working" || a.status === "blocked",
              ))
          }
          onStop={() => {
            if (crew.selectedKind === "channel" && crew.currentChannel) {
              for (const a of busyInChannel(crew.agents, crew.currentChannel.id)) {
                if (a.status === "working" || a.status === "blocked") {
                  void crew.stopAgent(a.id);
                }
              }
              return;
            }
            void crew.stopAgent();
          }}
          onOpenSkills={() => setSkillsOpen(true)}
        />
        <ChannelPane
          open={crew.paneOpen && crew.selectedKind === "channel"}
          tab={crew.paneTab}
          channel={crew.currentChannel}
          agents={crew.agents}
          onTab={crew.setPaneTab}
          onClose={crew.closePane}
          onSave={crew.saveChannel}
          onAddRoutine={crew.addRoutine}
          onToggleRoutine={crew.toggleRoutine}
          onDeleteRoutine={crew.deleteRoutine}
          onRunRoutine={crew.runRoutine}
          onEditRoutine={crew.editRoutine}
          onLoadRoutineRuns={crew.loadRoutineRuns}
        />
        <AgentPane
          open={crew.paneOpen && crew.selectedKind === "agent"}
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
      <NewChannelModal
        open={crew.newChannelOpen}
        agents={crew.agents}
        onClose={crew.closeNewChannel}
        onCreate={crew.createChannel}
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
        label: t("menu.newChannel"),
        onClick: () => {
          crew.hideCtx();
          crew.openNewChannel();
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
  const kind: Kind = ctx.kind === "channel" ? "channel" : "agent";
  const isCh = kind === "channel";
  const currentGroup = id ? crew.itemGroupId(kind, id) : null;
  const moveItems: MenuEntry[] = groups
    .filter((g) => g.id !== currentGroup)
    .map((g) => ({
      type: "action" as const,
      label: g.name,
      onClick: () => {
        crew.hideCtx();
        if (id) crew.moveToGroup(kind, id, g.id);
      },
    }));
  if (currentGroup) {
    moveItems.push({
      type: "action",
      label: t("menu.leaveGroup"),
      onClick: () => {
        crew.hideCtx();
        if (id) crew.moveToGroup(kind, id, null);
      },
    });
  }
  const items: MenuEntry[] = [];
  if (!isCh) {
    items.push({
      type: "action",
      label: t("menu.clearChat"),
      onClick: () => {
        crew.hideCtx();
        if (id) crew.openConfirm(id, "reset");
      },
    });
    items.push({
      type: "action",
      label: t("menu.cloneBot"),
      onClick: () => {
        crew.hideCtx();
        if (id) void crew.cloneBot(id);
      },
    });
  } else {
    items.push({
      type: "action",
      label: t("menu.leaveChannel"),
      onClick: () => {
        crew.hideCtx();
        if (id) crew.openConfirm(id, "leave-channel");
      },
    });
  }
  items.push({ type: "sep" });
  if (moveItems.length) {
    items.push({ type: "sub", label: t("menu.moveToGroup"), items: moveItems });
  }
  items.push({
    type: "action",
    label: t("menu.moveToNewGroup"),
    onClick: () => {
      crew.hideCtx();
      if (id) crew.createGroup({ kind, id });
    },
  });
  items.push({ type: "sep" });
  items.push({
    type: "action",
    label: isCh ? t("menu.deleteChannel") : t("menu.deleteBot"),
    danger: true,
    onClick: () => {
      crew.hideCtx();
      if (id) crew.openConfirm(id, isCh ? "remove-channel" : "remove");
    },
  });
  return items;
}
