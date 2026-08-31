import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { api, errMsg } from "./api";
import {
  groupIdOf,
  itemKey,
  layoutChanged,
  moveItem,
  newGroupId,
  normalizeGroups,
  pruneLayout,
  toPersist,
  uniqueGroupName,
  uniqueKeys,
  visibleUngroupedKeys,
  type RailLayout,
} from "./groups";
import type {
  AgentInfo,
  ChannelInfo,
  ChatMessage,
  CliKind,
  ConfirmKind,
  CtxKind,
  Group,
  Kind,
  PaneTab,
  Routine,
} from "./types";

type Ctx = {
  open: boolean;
  x: number;
  y: number;
  id: string | null;
  kind: CtxKind;
};

export function useCrew() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedKind, setSelectedKind] = useState<Kind>("agent");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [query, setQuery] = useState("");
  const [stick, setStick] = useState(true);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [connDetail, setConnDetail] = useState("데몬 확인 중…");
  const [paneOpen, setPaneOpen] = useState(false);
  const [paneTab, setPaneTab] = useState<PaneTab>("info");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmKind, setConfirmKind] = useState<ConfirmKind>("reset");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [newBotOpen, setNewBotOpen] = useState(false);
  const [newChannelOpen, setNewChannelOpen] = useState(false);
  const [toast, setToast] = useState({ text: "", show: false });
  const [ctx, setCtx] = useState<Ctx>({
    open: false,
    x: 0,
    y: 0,
    id: null,
    kind: "agent",
  });
  const [groups, setGroups] = useState<Group[]>([]);
  const [ungrouped, setUngrouped] = useState<string[]>([]);
  const [pendingRenameId, setPendingRenameId] = useState<string | null>(null);

  const selectedRef = useRef({ id: selected, kind: selectedKind });
  selectedRef.current = { id: selected, kind: selectedKind };
  const paneOpenRef = useRef(paneOpen);
  paneOpenRef.current = paneOpen;
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const channelsRef = useRef(channels);
  channelsRef.current = channels;
  const groupsRef = useRef<RailLayout>({ groups, ungrouped });
  groupsRef.current = { groups, ungrouped };
  const groupsLoaded = useRef(false);
  const toastTimer = useRef<number | null>(null);

  const currentAgent = useMemo(() => {
    if (selectedKind !== "agent" || !selected) return null;
    return agents.find((a) => a.id === selected) ?? null;
  }, [agents, selected, selectedKind]);

  const currentChannel = useMemo(() => {
    if (selectedKind !== "channel" || !selected) return null;
    return channels.find((c) => c.id === selected) ?? null;
  }, [channels, selected, selectedKind]);

  const placeholder = currentChannel
    ? `+ ${currentChannel.name || currentChannel.id}에 메시지`
    : currentAgent
      ? `+ ${currentAgent.name || currentAgent.id}에게 메시지 (@이름으로 부르기)`
      : "+ 메시지";

  function showToast(text: string) {
    setToast({ text, show: true });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => {
      setToast((t) => ({ ...t, show: false }));
    }, 2500);
  }

  function showError(err: unknown) {
    const msg = errMsg(err);
    setConnected(false);
    setConnDetail(msg);
    showToast(msg);
  }

  function hideCtx() {
    setCtx((c) => ({ ...c, open: false, id: null, kind: "agent" }));
  }

  function closePane() {
    setPaneOpen(false);
  }

  function closeConfirm() {
    setConfirmOpen(false);
    setConfirmId(null);
    setConfirmKind("reset");
  }

  function closeNewBot() {
    setNewBotOpen(false);
  }

  function closeNewChannel() {
    setNewChannelOpen(false);
  }

  function selectAgent(id: string) {
    selectedRef.current = { id, kind: "agent" };
    setSelected(id);
    setSelectedKind("agent");
    setStick(true);
    closePane();
    void refreshMessages();
  }

  function selectChannel(id: string) {
    selectedRef.current = { id, kind: "channel" };
    setSelected(id);
    setSelectedKind("channel");
    setStick(true);
    closePane();
    void refreshMessages();
  }

  function openPane(id: string, tab: PaneTab) {
    const a = agentsRef.current.find((x) => x.id === id);
    if (!a) return;
    selectedRef.current = { id, kind: "agent" };
    setSelected(id);
    setSelectedKind("agent");
    setPaneTab(tab);
    setPaneOpen(true);
  }

  function openInfo(id: string) {
    openPane(id, "info");
  }

  function openRoutines(id: string) {
    openPane(id, "routines");
  }

  function openConfirm(id: string, kind: ConfirmKind = "reset") {
    if (!id) return;
    setConfirmId(id);
    setConfirmKind(kind);
    setConfirmOpen(true);
  }

  function showCtx(e: MouseEvent, id: string | null, kind: CtxKind) {
    setCtx({ open: true, x: e.clientX, y: e.clientY, id, kind });
  }

  function showCreateMenu(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setCtx({
      open: true,
      x: Math.round(r.right - 168),
      y: Math.round(r.bottom + 4),
      id: null,
      kind: "create",
    });
  }

  function persistLayout(next: RailLayout) {
    const layout = {
      groups: next.groups.filter((g) => g.id !== "__ungrouped"),
      ungrouped: next.ungrouped,
    };
    groupsLoaded.current = true;
    groupsRef.current = layout;
    setGroups(layout.groups);
    setUngrouped(layout.ungrouped);
    void api.setGroups(toPersist(layout)).catch((err) => showError(err));
  }

  function createGroup(withItem?: { kind: Kind; id: string } | null) {
    const current = groupsRef.current;
    const id = newGroupId(current.groups.map((g) => g.id));
    const name = uniqueGroupName(current.groups);
    const key = withItem ? itemKey(withItem.kind, withItem.id) : null;
    if (!key) {
      persistLayout({
        groups: [
          ...current.groups,
          { id, name, collapsed: false, items: [] },
        ],
        ungrouped: current.ungrouped,
      });
    } else {
      const visual = visibleUngroupedKeys(
        current.groups,
        current.ungrouped,
        agentsRef.current,
        channelsRef.current,
      );
      const stripped = moveItem(current, key, null, null, visual);
      persistLayout({
        groups: [
          ...stripped.groups,
          { id, name, collapsed: false, items: [key] },
        ],
        ungrouped: stripped.ungrouped.filter((k) => k !== key),
      });
    }
    setPendingRenameId(id);
  }

  function renameGroup(id: string, name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    persistLayout({
      groups: groupsRef.current.groups.map((g) =>
        g.id === id ? { ...g, name: trimmed } : g,
      ),
      ungrouped: groupsRef.current.ungrouped,
    });
  }

  function removeGroup(id: string) {
    const current = groupsRef.current;
    const gone = current.groups.find((g) => g.id === id);
    persistLayout({
      groups: current.groups.filter((g) => g.id !== id),
      ungrouped: uniqueKeys([...(gone?.items || []), ...current.ungrouped]),
    });
  }

  function moveToGroup(
    kind: Kind,
    id: string,
    groupId: string | null,
    beforeKey?: string | null,
  ) {
    const current = groupsRef.current;
    const visual = visibleUngroupedKeys(
      current.groups,
      current.ungrouped,
      agentsRef.current,
      channelsRef.current,
    );
    persistLayout(moveItem(current, itemKey(kind, id), groupId, beforeKey, visual));
  }

  function toggleGroup(id: string) {
    persistLayout({
      groups: groupsRef.current.groups.map((g) =>
        g.id === id ? { ...g, collapsed: !g.collapsed } : g,
      ),
      ungrouped: groupsRef.current.ungrouped,
    });
  }

  function itemGroupId(kind: Kind, id: string): string | null {
    return groupIdOf(groups, kind, id);
  }

  const refreshList = useCallback(async () => {
    const [list, chans] = await Promise.all([
      api.listAgents(),
      api.listChannels().catch(() => [] as ChannelInfo[]),
    ]);
    let { id: sel, kind } = selectedRef.current;
    if (!sel) {
      if (list.length) {
        sel = list[0].id;
        kind = "agent";
      } else if (chans.length) {
        sel = chans[0].id;
        kind = "channel";
      }
    } else if (kind === "agent") {
      if (!list.some((a) => a.id === sel)) {
        if (list[0]) {
          sel = list[0].id;
          kind = "agent";
        } else if (chans[0]) {
          sel = chans[0].id;
          kind = "channel";
        } else {
          sel = null;
        }
      }
    } else if (!chans.some((c) => c.id === sel)) {
      if (chans[0]) {
        sel = chans[0].id;
        kind = "channel";
      } else if (list[0]) {
        sel = list[0].id;
        kind = "agent";
      } else {
        sel = null;
      }
    }
    selectedRef.current = { id: sel, kind };
    setAgents(list);
    setChannels(chans || []);
    if (groupsLoaded.current) {
      const pruned = pruneLayout(groupsRef.current, list, chans || []);
      if (layoutChanged(pruned, groupsRef.current)) persistLayout(pruned);
    }
    setSelected(sel);
    setSelectedKind(kind);
    if (paneOpenRef.current) {
      const a = kind === "agent" ? list.find((x) => x.id === sel) : null;
      if (!a) setPaneOpen(false);
    }
  }, []);

  const refreshMessages = useCallback(async () => {
    const { id, kind } = selectedRef.current;
    if (!id) {
      setMessages([]);
      return;
    }
    if (kind === "channel") {
      setMessages(await api.getChannelMessages(id));
    } else {
      setMessages(await api.getMessages(id));
    }
  }, []);

  async function onSend(raw: string) {
    const { id: sel, kind } = selectedRef.current;
    if (!sel) return;
    try {
      if (kind === "channel") {
        await api.channelSend(sel, raw);
      } else {
        await api.sendMessage(sel, raw);
      }
      await refreshMessages();
    } catch (err) {
      showError(err);
    }
  }

  async function saveAgentInfo(fields: {
    name: string;
    role: string;
    description: string;
    model: string;
    effort: string;
  }) {
    const id = selectedRef.current.id;
    if (!id || selectedRef.current.kind !== "agent") return;
    const model = fields.model.trim();
    const name = fields.name.trim();
    const role = fields.role.trim();
    const description = fields.description.trim();
    try {
      await api.setAgent({
        id,
        model: model || null,
        effort: fields.effort || null,
        unsetModel: !model,
        unsetEffort: !fields.effort,
        title: null,
        role: role || null,
        description: description || null,
        unsetTitle: false,
        unsetRole: !role,
        unsetDescription: !description,
        shape: null,
        color: null,
        name: name || null,
      });
      await refreshList();
    } catch (err) {
      showError(err);
    }
  }

  async function saveAgentFace(shape?: string | null, color?: string | null) {
    const id = selectedRef.current.id;
    if (!id || selectedRef.current.kind !== "agent") return;
    try {
      await api.setAgent({
        id,
        model: null,
        effort: null,
        unsetModel: false,
        unsetEffort: false,
        title: null,
        role: null,
        description: null,
        unsetTitle: false,
        unsetRole: false,
        unsetDescription: false,
        shape: shape || null,
        color: color || null,
      });
      await refreshList();
    } catch (err) {
      showError(err);
    }
  }

  async function addRoutine(name: string, schedule: string, prompt: string) {
    const id = selectedRef.current.id;
    if (!id) return;
    const n = name.trim();
    const s = schedule.trim();
    const p = prompt.trim();
    if (!n || !s || !p) {
      showError("이름, 시각, 시킬 일을 모두 입력하세요");
      return;
    }
    try {
      await api.addRoutine(id, n, s, p);
      await refreshList();
    } catch (err) {
      showError(err);
    }
  }

  async function toggleRoutine(r: Routine) {
    const id = selectedRef.current.id;
    if (!id || !r) return;
    try {
      await api.setRoutineEnabled(id, r.id || r.name, r.enabled === false);
      await refreshList();
    } catch (err) {
      showError(err);
    }
  }

  async function loadMemory(id: string) {
    try {
      return await api.getMemory(id);
    } catch (err) {
      showError(err);
      return "";
    }
  }

  async function saveMemory(text: string) {
    const id = selectedRef.current.id;
    if (!id || selectedRef.current.kind !== "agent") return;
    try {
      await api.setMemory(id, text);
    } catch (err) {
      showError(err);
    }
  }

  async function deleteRoutine(r: Routine) {
    const id = selectedRef.current.id;
    if (!id || !r) return;
    try {
      await api.removeRoutine(id, r.id || r.name);
      await refreshList();
    } catch (err) {
      showError(err);
    }
  }

  async function doConfirm(dropRoutines: boolean) {
    const id = confirmId;
    const kind = confirmKind;
    closeConfirm();
    if (!id) return;
    try {
      if (kind === "remove") {
        await api.removeAgent(id);
        if (selectedRef.current.id === id && selectedRef.current.kind === "agent") {
          selectedRef.current = { id: null, kind: "agent" };
          setSelected(null);
          setMessages([]);
        }
      } else if (kind === "leave-channel") {
        await api.leaveChannel(id);
        if (
          selectedRef.current.id === id &&
          selectedRef.current.kind === "channel"
        ) {
          selectedRef.current = { id: null, kind: "agent" };
          setSelected(null);
          setMessages([]);
        }
      } else if (kind === "remove-group") {
        removeGroup(id);
        await refreshList();
        await refreshMessages();
        return;
      } else if (kind === "remove-channel") {
        await api.removeChannel(id);
        if (
          selectedRef.current.id === id &&
          selectedRef.current.kind === "channel"
        ) {
          selectedRef.current = { id: null, kind: "agent" };
          setSelected(null);
          setMessages([]);
        }
      } else {
        await api.resetAgent(id, dropRoutines);
      }
      await refreshList();
      await refreshMessages();
    } catch (err) {
      showError(err);
    }
  }

  async function cloneBot(id: string) {
    try {
      const newId = await api.cloneAgent(id, null);
      selectedRef.current = { id: newId, kind: "agent" };
      setSelected(newId);
      setSelectedKind("agent");
      setStick(true);
      setMessages([]);
      closePane();
      await refreshList();
      await refreshMessages();
    } catch (err) {
      showError(err);
      await refreshList();
    }
  }

  async function createBot(args: {
    name: string;
    persona: string;
    cli: CliKind;
    model: string;
    effort: string;
    shape: string | null;
    color: string | null;
  }) {
    const name = args.name.trim();
    if (!name) {
      showError("이름을 입력하세요");
      return;
    }
    const persona = args.persona.trim();
    const model = args.model.trim();
    try {
      const id = await api.addAgent({
        name,
        cli: args.cli || "grok",
        model: model || null,
        effort: args.effort || null,
        role: persona || null,
        description: persona || null,
      });
      if (args.shape || args.color) {
        await api.setAgent({
          id,
          model: null,
          effort: null,
          unsetModel: false,
          unsetEffort: false,
          title: null,
          role: null,
          description: null,
          unsetTitle: false,
          unsetRole: false,
          unsetDescription: false,
          shape: args.shape,
          color: args.color,
        });
      }
      closeNewBot();
      selectedRef.current = { id, kind: "agent" };
      setSelected(id);
      setSelectedKind("agent");
      setStick(true);
      setMessages([]);
      closePane();
      await refreshList();
      await refreshMessages();
    } catch (err) {
      showError(err);
      await refreshList();
    }
  }

  async function createChannel(name: string, members: string[]) {
    const trimmed = name.trim();
    if (!trimmed) {
      showError("이름을 입력하세요");
      return;
    }
    try {
      const id = await api.addChannel(trimmed, members);
      closeNewChannel();
      selectedRef.current = { id, kind: "channel" };
      setSelected(id);
      setSelectedKind("channel");
      setStick(true);
      setMessages([]);
      closePane();
      await refreshList();
      await refreshMessages();
    } catch (err) {
      showError(err);
      await refreshList();
    }
  }

  useEffect(() => {
    let cancelled = false;
    void api
      .listGroups()
      .then((raw) => {
        if (cancelled || groupsLoaded.current) return;
        const next = normalizeGroups(raw);
        groupsLoaded.current = true;
        groupsRef.current = next;
        setGroups(next.groups);
        setUngrouped(next.ungrouped);
      })
      .catch(() => {
        if (cancelled || groupsLoaded.current) return;
        groupsLoaded.current = true;
        setGroups([]);
        setUngrouped([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        await api.daemonPing();
        if (cancelled) return;
        setConnected(true);
        setConnDetail("데몬 연결됨");
        await refreshList();
        if (cancelled) return;
        await refreshMessages();
      } catch (err) {
        if (!cancelled) {
          setConnected(false);
          setConnDetail(errMsg(err));
        }
      }
    }
    void tick();
    const working =
      selectedKind === "agent" &&
      !!currentAgent &&
      (currentAgent.status === "working" || currentAgent.status === "blocked");
    const lastRole = messages[messages.length - 1]?.role;
    const expecting = selectedKind === "agent" && lastRole === "user";
    const ms = working || expecting ? 200 : 400;
    const id = window.setInterval(() => void tick(), ms);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [
    refreshList,
    refreshMessages,
    selectedKind,
    currentAgent?.status,
    messages[messages.length - 1]?.role,
  ]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      closeConfirm();
      closePane();
      closeNewBot();
      closeNewChannel();
      hideCtx();
    }
    function onClick() {
      hideCtx();
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onClick);
    };
  }, []);

  return {
    agents,
    channels,
    selected,
    selectedKind,
    messages,
    query,
    setQuery,
    stick,
    setStick,
    connected,
    connDetail,
    paneOpen,
    paneTab,
    setPaneTab,
    confirmOpen,
    confirmKind,
    newBotOpen,
    newChannelOpen,
    toast,
    ctx,
    groups,
    ungrouped,
    pendingRenameId,
    clearPendingRename: () => setPendingRenameId(null),
    currentAgent,
    currentChannel,
    placeholder,
    selectAgent,
    selectChannel,
    openInfo,
    openRoutines,
    closePane,
    openConfirm,
    closeConfirm,
    doConfirm,
    openNewBot: () => setNewBotOpen(true),
    closeNewBot,
    openNewChannel: () => setNewChannelOpen(true),
    closeNewChannel,
    createBot,
    createChannel,
    cloneBot,
    showCtx,
    showCreateMenu,
    hideCtx,
    createGroup,
    renameGroup,
    removeGroup,
    moveToGroup,
    toggleGroup,
    itemGroupId,
    onSend,
    saveAgentInfo,
    saveAgentFace,
    addRoutine,
    toggleRoutine,
    deleteRoutine,
    loadMemory,
    saveMemory,
    showError,
  };
}
