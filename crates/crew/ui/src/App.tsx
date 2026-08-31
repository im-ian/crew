import { ChatHeader } from "./components/ChatHeader";
import { ChatThread } from "./components/ChatThread";
import { Composer } from "./components/Composer";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { ContextMenu } from "./components/ContextMenu";
import { InfoPane } from "./components/InfoPane";
import { NewBotModal } from "./components/NewBotModal";
import { NewChannelModal } from "./components/NewChannelModal";
import { Sidebar } from "./components/Sidebar";
import { Toast } from "./components/Toast";
import { useCrew } from "./useCrew";

export function App() {
  const crew = useCrew();

  return (
    <div className="app">
      <Sidebar
        agents={crew.agents}
        channels={crew.channels}
        selected={crew.selected}
        selectedKind={crew.selectedKind}
        query={crew.query}
        onQuery={crew.setQuery}
        onSelectAgent={crew.selectAgent}
        onSelectChannel={crew.selectChannel}
        onNewBot={crew.openNewBot}
        onNewChannel={crew.openNewChannel}
        onAgentCtx={(e, id) => crew.showCtx(e, id, "agent")}
        onChannelCtx={(e, id) => crew.showCtx(e, id, "channel")}
        onPickAvatar={crew.pickAvatar}
      />
      <main>
        <div className="titlebar-align" data-tauri-drag-region />
        <ChatHeader
          selectedKind={crew.selectedKind}
          currentAgent={crew.currentAgent}
          currentChannel={crew.currentChannel}
          agents={crew.agents}
          onOpenInfo={() => {
            if (crew.selected) crew.openInfo(crew.selected);
          }}
          onPickAvatar={() => {
            if (crew.selected) crew.pickAvatar(crew.selected);
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
          toId={crew.toId}
          onTo={crew.setToId}
          onSend={crew.onSend}
        />
        <InfoPane
          open={crew.infoOpen}
          agent={crew.currentAgent}
          onClose={crew.closeInfo}
          onReset={() => {
            crew.closeInfo();
            if (crew.selected) crew.openConfirm(crew.selected, "reset");
          }}
          onPickAvatar={() => {
            if (crew.selected) crew.pickAvatar(crew.selected);
          }}
          onClearAvatar={() => {
            if (crew.selected) void crew.clearAvatar(crew.selected);
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
        pendingAvatar={crew.pendingNewAvatar}
        onClose={crew.closeNewBot}
        onPickAvatar={() => crew.pickAvatar("__new__")}
        onClearAvatar={() => crew.setPendingNewAvatar(null)}
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
        kind={crew.ctx.kind}
        onReset={() => {
          const id = crew.ctx.id;
          crew.hideCtx();
          if (id) crew.openConfirm(id, "reset");
        }}
        onClone={() => {
          const id = crew.ctx.id;
          const kind = crew.ctx.kind;
          crew.hideCtx();
          if (id && kind !== "channel") void crew.cloneBot(id);
        }}
        onLeave={() => {
          const id = crew.ctx.id;
          crew.hideCtx();
          if (id) crew.openConfirm(id, "leave-channel");
        }}
        onRemove={() => {
          const id = crew.ctx.id;
          const kind = crew.ctx.kind;
          crew.hideCtx();
          if (id) {
            crew.openConfirm(id, kind === "channel" ? "remove-channel" : "remove");
          }
        }}
      />
      <input
        ref={crew.fileRef}
        className="avatar-file"
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          void crew.onAvatarFile(file);
        }}
      />
      <Toast text={crew.toast.text} show={crew.toast.show} />
    </div>
  );
}
