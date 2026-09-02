import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { api, errMsg } from "./api";
import { useT } from "./LocaleContext";
import { loadRead, markRead, saveRead, unreadKeys } from "./readCursors";
import {
  groupIdOf,
  itemKey,
  layoutChanged,
  moveItem,
  newGroupId,
  normalizeGroups,
  pruneLayout,
  toPersist,
  UNGROUPED_ID,
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
  FocusTarget,
  Group,
  Kind,
  PaneTab,
  Routine,
  SearchHit,
} from "./types";

type Ctx = {
  open: boolean;
  x: number;
  y: number;
  id: string | null;
  kind: CtxKind;
};

export function useCrew() {
  const t = useT();
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedKind, setSelectedKind] = useState<Kind>("agent");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [query, setQuery] = useState("");
  const [stick, setStick] = useState(true);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [connDetail, setConnDetail] = useState(() => t("conn.checking"));
  const [paneOpen, setPaneOpen] = useState(false);
  const [paneTab, setPaneTab] = useState<PaneTab>("info");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmKind, setConfirmKind] = useState<ConfirmKind>("reset");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [newBotOpen, setNewBotOpen] = useState(false);
  const [newChannelOpen, setNewChannelOpen] = useState(false);
  const [toast, setToast] = useState<{
    text: string;
    show: boolean;
    target: FocusTarget | null;
  }>({ text: "", show: false, target: null });
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
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [readMap, setReadMap] = useState(loadRead);

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

  const unread = useMemo(
    () => unreadKeys(readMap, agents, channels, selectedKind, selected),
    [readMap, agents, channels, selectedKind, selected],
  );

  useEffect(() => {
    if (!selected) return;
    const ts =
      selectedKind === "channel"
        ? currentChannel?.last_ts || 0
        : currentAgent?.last_ts || 0;
    if (!ts) return;
    setReadMap((prev) => {
      const next = markRead(prev, selectedKind, selected, ts);
      if (next === prev) return prev;
      saveRead(next);
      return next;
    });
  }, [
    selected,
    selectedKind,
    currentAgent?.last_ts,
    currentChannel?.last_ts,
  ]);

  useEffect(() => {
    void api.setDockBadge(unread.length).catch(() => null);
  }, [unread.length]);

  const placeholder = currentChannel
    ? t("composer.placeholder.channel", {
        name: currentChannel.name || currentChannel.id,
      })
    : currentAgent?.status === "working"
      ? t("composer.placeholder.redirect")
      : currentAgent
        ? t("composer.placeholder.agent", {
            name: currentAgent.name || currentAgent.id,
          })
        : t("composer.placeholder.generic");

  const tRef = useRef(t);
  tRef.current = t;

  // The daemon ships a ready-made Korean sentence for the case where no window is
  // open; when the UI is up it renders the event in the language the user picked.
  function focusBody(hit: FocusTarget): string {
    const name = hit.name || "";
    if (hit.event === "done") return tRef.current("notify.done", { name });
    if (hit.event === "blocked") return tRef.current("notify.blocked", { name });
    if (hit.event === "routine_failed") {
      return tRef.current("notify.routineFailed", { name });
    }
    return hit.body;
  }

  function showToast(text: string, target: FocusTarget | null = null) {
    setToast({ text, show: true, target });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => {
      setToast((t) => ({ ...t, show: false }));
    }, target ? 8000 : 2500);
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

  function selectAgent(id: string, highlight: string | null = null) {
    selectedRef.current = { id, kind: "agent" };
    setSelected(id);
    setSelectedKind("agent");
    setStick(!highlight);
    setHighlightId(highlight);
    closePane();
    void refreshMessages();
  }

  function selectChannel(id: string, highlight: string | null = null) {
    selectedRef.current = { id, kind: "channel" };
    setSelected(id);
    setSelectedKind("channel");
    setStick(!highlight);
    setHighlightId(highlight);
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
    const ch = channelsRef.current.find((c) => c.id === id);
    if (ch) {
      selectedRef.current = { id, kind: "channel" };
      setSelected(id);
      setSelectedKind("channel");
      setPaneOpen(true);
      return;
    }
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
      groups: next.groups.filter((g) => g.id !== UNGROUPED_ID),
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
    const name = uniqueGroupName(current.groups, t("group.new"));
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

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setSearchHits([]);
      return;
    }
    const t = window.setTimeout(() => {
      void api.searchCrew(q).then(setSearchHits).catch(() => setSearchHits([]));
    }, 160);
    return () => window.clearTimeout(t);
  }, [query]);

  function openSearchHit(hit: SearchHit) {
    if (hit.kind === "bot") {
      selectAgent(hit.id);
      return;
    }
    if (hit.kind === "routine") {
      const agent = hit.id.split(":")[0];
      if (agent) {
        selectAgent(agent);
        openRoutines(agent);
      }
      return;
    }
    if (hit.kind === "message") {
      const parsed = parseMessageHit(hit.id);
      if (!parsed) return;
      if (parsed.kind === "channel") selectChannel(parsed.id, parsed.messageId);
      else selectAgent(parsed.id, parsed.messageId);
    }
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
      const still =
        kind === "agent"
          ? list.some((x) => x.id === sel)
          : (chans || []).some((c) => c.id === sel);
      if (!still) setPaneOpen(false);
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

  async function stopAgent(agentId?: string) {
    const id =
      agentId ||
      (selectedRef.current.kind === "agent" ? selectedRef.current.id : null);
    if (!id) return;
    try {
      await api.stopAgent(id);
      await refreshList();
      await refreshMessages();
    } catch (err) {
      showError(err);
    }
  }

  async function approveAgent(allow: boolean, agentId?: string) {
    const id =
      agentId ||
      (selectedRef.current.kind === "agent" ? selectedRef.current.id : null);
    if (!id) return;
    try {
      await api.approveAgent(id, allow);
      await refreshList();
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
    cwd: string;
  }) {
    const id = selectedRef.current.id;
    if (!id || selectedRef.current.kind !== "agent") return;
    const model = fields.model.trim();
    const name = fields.name.trim();
    const role = fields.role.trim();
    const description = fields.description.trim();
    const cwd = fields.cwd.trim();
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
        cwd: cwd || null,
        unsetCwd: !cwd,
      });
      await refreshList();
    } catch (err) {
      showError(err);
    }
  }

  async function saveChannel(fields: {
    name: string;
    brief: string;
    members: string[];
  }) {
    const id = selectedRef.current.id;
    if (!id || selectedRef.current.kind !== "channel") return;
    const name = fields.name.trim();
    const brief = fields.brief.trim();
    try {
      await api.setChannel({
        id,
        name: name || null,
        brief,
        unsetBrief: !brief,
        members: fields.members,
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
        cwd: null,
        unsetCwd: false,
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
    if (!s) {
      showError(t("error.routineFields"));
      return;
    }
    if ((!n || !p) && s.trim().split(/\s+/).length === 5 && /^\S+ \S+ \S+ \S+ \S+$/.test(s.trim())) {
      showError(t("error.routineFields"));
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

  async function runRoutine(r: Routine) {
    const id = selectedRef.current.id;
    if (!id || !r) return;
    try {
      await api.runRoutine(id, r.id || r.name);
      await refreshList();
    } catch (err) {
      showError(err);
    }
  }

  async function editRoutine(
    r: Routine,
    fields: { name?: string; schedule?: string; prompt?: string },
  ) {
    const id = selectedRef.current.id;
    if (!id || !r) return;
    try {
      await api.editRoutine(id, r.id || r.name, fields);
      await refreshList();
    } catch (err) {
      showError(err);
    }
  }

  async function loadRoutineRuns(r: Routine) {
    const id = selectedRef.current.id;
    if (!id || !r) return [];
    try {
      return await api.listRoutineRuns(id, r.id || r.name);
    } catch (err) {
      showError(err);
      return [];
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
      showError(t("error.nameRequired"));
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
      showError(t("error.nameRequired"));
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
        setConnDetail(t("conn.ok"));
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
      (currentAgent.status === "working" ||
        currentAgent.status === "blocked");
    const lastRole = messages[messages.length - 1]?.role;
    const expecting = lastRole === "user";
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
    t,
  ]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented) return;
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

  function openFocus(hit: FocusTarget) {
    void api.takePendingFocus().catch(() => null);
    if (hit.kind === "channel") selectChannel(hit.id);
    else selectAgent(hit.id);
  }

  function clickToast() {
    const target = toast.target;
    if (!target) return;
    setToast((t) => ({ ...t, show: false, target: null }));
    openFocus(target);
  }

  useEffect(() => {
    let last = "";
    let noticeKey = "";
    function go(hit: FocusTarget) {
      void api.takePendingFocus().catch(() => null);
      if (hit.kind === "channel") selectChannel(hit.id);
      else selectAgent(hit.id);
    }
    function fireNotice(hit: FocusTarget) {
      const Ctor = window.Notification;
      if (!Ctor) return;
      const show = () => {
        const n = new Ctor("Crew", {
          body: focusBody(hit),
          tag: `crew:${hit.kind}:${hit.id}`,
        });
        n.onclick = () => {
          window.focus();
          go(hit);
          n.close();
        };
      };
      if (Ctor.permission === "granted") show();
      else if (Ctor.permission !== "denied") {
        void Ctor.requestPermission().then((p) => {
          if (p === "granted") show();
        });
      }
    }
    async function tick() {
      const hit = await api.peekPendingFocus().catch(() => null);
      if (!hit) {
        last = "";
        return;
      }
      const key = `${hit.kind}:${hit.id}:${hit.body}`;
      if (document.hidden) {
        if (noticeKey !== key) {
          noticeKey = key;
          fireNotice(hit);
        }
        return;
      }
      if (last === key) return;
      last = key;
      showToast(focusBody(hit), hit);
    }
    function onWinFocus() {
      void api
        .takePendingFocus()
        .then((hit) => {
          if (hit) go(hit);
        })
        .catch(() => null);
    }
    function onVis() {
      if (!document.hidden) onWinFocus();
    }
    const iv = window.setInterval(() => void tick(), 900);
    window.addEventListener("focus", onWinFocus);
    document.addEventListener("visibilitychange", onVis);
    void tick();
    return () => {
      window.clearInterval(iv);
      window.removeEventListener("focus", onWinFocus);
      document.removeEventListener("visibilitychange", onVis);
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
    unread,
    searchHits,
    openSearchHit,
    highlightId,
    clearHighlight: () => setHighlightId(null),
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
    clickToast,
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
    stopAgent,
    approveAgent,
    saveAgentInfo,
    saveChannel,
    saveAgentFace,
    addRoutine,
    toggleRoutine,
    deleteRoutine,
    runRoutine,
    editRoutine,
    loadRoutineRuns,
    loadMemory,
    saveMemory,
    showError,
  };
}

function parseMessageHit(
  id: string,
): { kind: Kind; id: string; messageId: string } | null {
  const last = id.lastIndexOf(":");
  if (last <= 0) return null;
  const messageId = id.slice(last + 1);
  const scope = id.slice(0, last);
  if (!messageId || !scope) return null;
  if (scope.startsWith("ch:")) {
    const channel = scope.slice(3);
    if (!channel) return null;
    return { kind: "channel", id: channel, messageId };
  }
  return { kind: "agent", id: scope, messageId };
}
