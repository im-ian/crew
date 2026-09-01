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
import { ShortcutHelp } from "./components/ShortcutHelp";
import { Sidebar } from "./components/Sidebar";
import { Toast } from "./components/Toast";
import { busyInChannel } from "./busy";
import { railOrder } from "./groups";
import { isTypingTarget, shortcutId } from "./shortcuts";
import type { Kind } from "./types";
import { useCrew } from "./useCrew";

export function App() {
  const crew = useCrew();
  const crewRef = useRef(crew);
  crewRef.current = crew;
  const [renameId, setRenameId] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [jumpSeq, setJumpSeq] = useState(0);
  const renamingId = crew.pendingRenameId || renameId;
  const searchRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<ComposerHandle>(null);

  function finishRename() {
    crew.clearPendingRename();
    setRenameId(null);
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.isComposing) return;
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
  }, [helpOpen]);

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
          onApprove={(allow, id) => void crew.approveAgent(allow, id)}
          highlightId={crew.highlightId}
          onHighlightDone={crew.clearHighlight}
          jumpSeq={jumpSeq}
        />
        <Composer
          ref={composerRef}
          agents={crew.agents}
          selected={crew.selected}
          selectedKind={crew.selectedKind}
          placeholder={crew.placeholder}
          onSend={crew.onSend}
        />
        <ChannelPane
          open={crew.paneOpen && crew.selectedKind === "channel"}
          channel={crew.currentChannel}
          agents={crew.agents}
          onClose={crew.closePane}
          onSave={crew.saveChannel}
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
        items={menuItems(crew, setRenameId)}
      />
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
): MenuEntry[] {
  const { ctx, groups } = crew;
  if (ctx.kind === "create") {
    return [
      {
        type: "action",
        label: "새 봇",
        onClick: () => {
          crew.hideCtx();
          crew.openNewBot();
        },
      },
      {
        type: "action",
        label: "새 채널",
        onClick: () => {
          crew.hideCtx();
          crew.openNewChannel();
        },
      },
      {
        type: "action",
        label: "새 그룹",
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
        label: "이름 변경",
        onClick: () => {
          crew.hideCtx();
          if (id) setRenameId(id);
        },
      },
      {
        type: "action",
        label: "그룹 삭제",
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
      label: "그룹에서 빼기",
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
      label: "대화 지우기",
      onClick: () => {
        crew.hideCtx();
        if (id) crew.openConfirm(id, "reset");
      },
    });
    items.push({
      type: "action",
      label: "봇 복제",
      onClick: () => {
        crew.hideCtx();
        if (id) void crew.cloneBot(id);
      },
    });
  } else {
    items.push({
      type: "action",
      label: "채널 나가기",
      onClick: () => {
        crew.hideCtx();
        if (id) crew.openConfirm(id, "leave-channel");
      },
    });
  }
  items.push({ type: "sep" });
  if (moveItems.length) {
    items.push({ type: "sub", label: "그룹으로 이동", items: moveItems });
  }
  items.push({
    type: "action",
    label: "새 그룹으로 이동",
    onClick: () => {
      crew.hideCtx();
      if (id) crew.createGroup({ kind, id });
    },
  });
  items.push({ type: "sep" });
  items.push({
    type: "action",
    label: isCh ? "채널 삭제" : "봇 삭제",
    danger: true,
    onClick: () => {
      crew.hideCtx();
      if (id) crew.openConfirm(id, isCh ? "remove-channel" : "remove");
    },
  });
  return items;
}
