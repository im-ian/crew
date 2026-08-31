import { useState } from "react";
import { ChatHeader } from "./components/ChatHeader";
import { ChatThread } from "./components/ChatThread";
import { Composer } from "./components/Composer";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { ContextMenu, type MenuEntry } from "./components/ContextMenu";
import { AgentPane } from "./components/AgentPane";
import { NewBotModal } from "./components/NewBotModal";
import { NewChannelModal } from "./components/NewChannelModal";
import { Sidebar } from "./components/Sidebar";
import { Toast } from "./components/Toast";
import type { Kind } from "./types";
import { useCrew } from "./useCrew";

export function App() {
  const crew = useCrew();
  const [renameId, setRenameId] = useState<string | null>(null);
  const renamingId = crew.pendingRenameId || renameId;

  function finishRename() {
    crew.clearPendingRename();
    setRenameId(null);
  }

  return (
    <div className="app">
      <Sidebar
        agents={crew.agents}
        channels={crew.channels}
        groups={crew.groups}
        selected={crew.selected}
        selectedKind={crew.selectedKind}
        query={crew.query}
        renamingId={renamingId}
        onQuery={crew.setQuery}
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
        />
        <ChatThread
          messages={crew.messages}
          agents={crew.agents}
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
        />
        <Composer
          agents={crew.agents}
          selected={crew.selected}
          selectedKind={crew.selectedKind}
          placeholder={crew.placeholder}
          onSend={crew.onSend}
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
      <Toast text={crew.toast.text} show={crew.toast.show} />
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
