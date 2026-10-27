import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { api, errMsg, newestOnly, oneAtATime } from "./api";
import {
  applyStop,
  heldFor,
  rollbackSend,
  sendKeptQueued,
  withUnaccepted,
  type HeldSend,
} from "./sendGate";
import { useT } from "./LocaleContext";
import { loadNotify } from "./notifyPref";
import { loadRead, markRead, saveRead, unreadKeys } from "./readCursors";
import {
  adoptNewGroups,
  groupIdOf,
  itemKey,
  layoutChanged,
  moveGroup,
  moveItem,
  newGroupId,
  normalizeGroups,
  projectCwd,
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
  ChatMessage,
  CliKind,
  ConfirmKind,
  CtxKind,
  EditResult,
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
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedKind, setSelectedKind] = useState<Kind>("agent");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // Right after a switch, `messages` are still the last chat's.
  const [messagesFor, setMessagesFor] = useState<string | null>(null);
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
  const [newBotPlace, setNewBotPlace] = useState<string | null>(null);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
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
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [readMap, setReadMap] = useState(loadRead);

  const selectedRef = useRef({ id: selected, kind: selectedKind });
  selectedRef.current = { id: selected, kind: selectedKind };
  const faceSave = useRef(Promise.resolve());
  const paneOpenRef = useRef(paneOpen);
  paneOpenRef.current = paneOpen;
  const newProjectOpenRef = useRef(newProjectOpen);
  newProjectOpenRef.current = newProjectOpen;
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const listAgents = useRef(newestOnly(api.listAgents)).current;
  const getMessages = useRef(newestOnly(api.getMessages)).current;
  const pollMessages = useRef(oneAtATime()).current;
  const pollPing = useRef(oneAtATime()).current;
  const pollList = useRef(oneAtATime()).current;
  const groupsRef = useRef<RailLayout>({ groups, ungrouped });
  groupsRef.current = { groups, ungrouped };
  const groupsLoaded = useRef(false);
  const toastTimer = useRef<number | null>(null);
  const cancelling = useRef(new Set<string>());
  const sendingQueued = useRef(new Set<string>());
  const heldSends = useRef<HeldSend[]>([]);
  const sendSeq = useRef(0);

  const currentAgent = useMemo(() => {
    if (selectedKind !== "agent" || !selected) return null;
    return agents.find((a) => a.id === selected) ?? null;
  }, [agents, selected, selectedKind]);

  const unread = useMemo(
    () => unreadKeys(readMap, agents, selectedKind, selected),
    [readMap, agents, selectedKind, selected],
  );

  useEffect(() => {
    if (!selected) return;
    const ts = currentAgent?.last_ts || 0;
    if (!ts) return;
    setReadMap((prev) => {
      const next = markRead(prev, selectedKind, selected, ts);
      if (next === prev) return prev;
      saveRead(next);
      return next;
    });
  }, [selected, selectedKind, currentAgent?.last_ts]);

  useEffect(() => {
    void api.setDockBadge(unread.length).catch(() => null);
  }, [unread.length]);

  const placeholder = currentAgent
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

  function showToast(text: string) {
    setToast({ text, show: true });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => {
      setToast((prev) => ({ ...prev, show: false }));
    }, 2500);
  }

  function showError(err: unknown) {
    showToast(errMsg(err));
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

  function openNewBot(groupId?: string | null) {
    setNewBotPlace(groupId || null);
    setNewBotOpen(true);
  }

  function closeNewBot() {
    setNewBotPlace(null);
    setNewBotOpen(false);
  }

  function pinCwd(id: string, cwd: string) {
    void api.setCwd(id, cwd).then(() => refreshList()).catch((err) => showError(err));
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

  function openNewProject() {
    setNewProjectOpen(true);
  }

  function closeNewProject() {
    setNewProjectOpen(false);
  }

  async function pickProjectFolder(): Promise<string | null> {
    try {
      return await api.pickFolder();
    } catch (err) {
      showError(err);
      return null;
    }
  }

  function createProject(name: string, path: string) {
    const trimmed = name.trim();
    const folder = path.trim();
    if (!trimmed || !folder) return;
    const current = groupsRef.current;
    const id = newGroupId(current.groups.map((g) => g.id));
    persistLayout({
      groups: [
        ...current.groups,
        {
          id,
          name: uniqueGroupName(current.groups, trimmed),
          collapsed: false,
          items: [],
          path: folder,
        },
      ],
      ungrouped: current.ungrouped,
    });
    setNewProjectOpen(false);
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
    const fromId = groupIdOf(current.groups, kind, id);
    const visual = visibleUngroupedKeys(
      current.groups,
      current.ungrouped,
      agentsRef.current,
    );
    persistLayout(moveItem(current, itemKey(kind, id), groupId, beforeKey, visual));
    if (kind !== "agent" || !groupId || groupId === fromId) return;
    const dest = projectCwd(current.groups.find((g) => g.id === groupId));
    const prev = projectCwd(current.groups.find((g) => g.id === fromId));
    if (dest && dest !== prev) pinCwd(id, dest);
  }

  function reorderGroup(id: string, beforeId: string | null) {
    const next = moveGroup(groupsRef.current, id, beforeId);
    if (next === groupsRef.current) return;
    persistLayout(next);
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
    // A search for an earlier query can answer after this one.
    let stale = false;
    const t = window.setTimeout(() => {
      void api
        .searchCrew(q)
        .catch(() => [])
        .then((hits) => {
          if (!stale) setSearchHits(hits);
        });
    }, 160);
    return () => {
      stale = true;
      window.clearTimeout(t);
    };
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
    if (hit.kind === "message" || hit.kind === "tool") {
      const parsed = parseMessageHit(hit.id);
      if (!parsed) return;
      selectAgent(parsed.id, parsed.messageId);
    }
  }

  const refreshList = useCallback(async () => {
    const list = await listAgents();
    if (!list) return;
    let { id: sel } = selectedRef.current;
    if (!sel || !list.some((a) => a.id === sel)) {
      sel = list[0]?.id ?? null;
    }
    selectedRef.current = { id: sel, kind: "agent" };
    setAgents(list);
    if (groupsLoaded.current) {
      const pruned = pruneLayout(groupsRef.current, list);
      if (layoutChanged(pruned, groupsRef.current)) persistLayout(pruned);
    }
    setSelected(sel);
    setSelectedKind("agent");
    if (paneOpenRef.current && !list.some((x) => x.id === sel)) {
      setPaneOpen(false);
    }
  }, []);

  const refreshMessages = useCallback(async () => {
    const { id } = selectedRef.current;
    if (!id) {
      setMessages([]);
      return;
    }
    const next = await getMessages(id);
    if (!next) return;
    // A send the daemon has not answered stays held, and stays off the bubble path.
    setMessages(withUnaccepted(next, heldFor(id, heldSends.current)));
    setMessagesFor(id);
  }, []);

  async function onSend(raw: string, steer = false): Promise<boolean> {
    const { id: sel } = selectedRef.current;
    if (!sel) return false;
    sendSeq.current += 1;
    const held: HeldSend = {
      id: `local-send-${sendSeq.current}`,
      agent: sel,
      text: raw,
    };
    heldSends.current = [...heldSends.current, held];
    if (selectedRef.current.id === sel) {
      setMessages((prev) => withUnaccepted(prev, [held]));
    }
    let accepted = false;
    try {
      await api.sendMessage(sel, raw, steer);
      accepted = true;
    } catch (err) {
      // A failed start can still leave the line queued. That is the waiting
      // row, so the composer must not also put the draft back.
      try {
        const next = await getMessages(sel);
        if (next && sendKeptQueued(next, raw)) accepted = true;
        else showError(err);
      } catch {
        showError(err);
      }
    } finally {
      heldSends.current = heldSends.current.filter((h) => h.id !== held.id);
    }
    if (selectedRef.current.id === sel) {
      // Failure drops the line this window inserted. Success then takes the daemon rows.
      setMessages((prev) => rollbackSend(prev, held.id).messages);
      if (accepted) {
        try {
          await refreshMessages();
        } catch (err) {
          showError(err);
        }
      }
    }
    return accepted;
  }

  async function stopAgent(agentId?: string) {
    const id =
      agentId ||
      (selectedRef.current.kind === "agent" ? selectedRef.current.id : null);
    if (!id) return;
    try {
      await api.stopAgent(id);
      // Stop adds no thread row. Whatever the daemon sends next is the thread.
      setMessages((prev) => applyStop(prev));
      await refreshList();
      await refreshMessages();
    } catch (err) {
      showError(err);
    }
  }

  async function cancelQueued(messageId: string) {
    const { id } = selectedRef.current;
    // A double click would otherwise report the first cancel's row as gone.
    if (!id || cancelling.current.has(messageId)) return;
    cancelling.current.add(messageId);
    try {
      await api.cancelQueued(id, messageId);
      await refreshMessages();
    } catch (err) {
      showError(err);
    } finally {
      cancelling.current.delete(messageId);
    }
  }

  async function sendQueued(messageId: string) {
    const { id } = selectedRef.current;
    if (!id || sendingQueued.current.has(messageId)) return;
    sendingQueued.current.add(messageId);
    try {
      await api.sendQueued(id, messageId);
      await refreshMessages();
    } catch (err) {
      showError(err);
    } finally {
      sendingQueued.current.delete(messageId);
    }
  }

  async function editQueued(messageId: string, raw: string): Promise<EditResult> {
    const { id } = selectedRef.current;
    if (!id) return "failed";
    try {
      await api.editQueued(id, messageId, raw);
    } catch (err) {
      showError(err);
      // Only one that went out leaves the edit to send anew. One still waiting
      // keeps the edit open, so it cannot go out twice.
      const rows = await api.getMessages(id).catch(() => null);
      return rows && !rows.find((m) => m.id === messageId)?.queued ? "gone" : "failed";
    }
    void refreshMessages().catch(showError);
    return "saved";
  }

  async function approveAgent(allow: boolean, agentId?: string, always = false) {
    const id =
      agentId ||
      (selectedRef.current.kind === "agent" ? selectedRef.current.id : null);
    if (!id) return;
    try {
      await api.approveAgent(id, allow, always);
      await refreshList();
      await refreshMessages();
    } catch (err) {
      showError(err);
    }
  }

  async function answerChoice(
    agentId: string,
    messageId: string,
    answers: string[][],
    values: string[][],
    closed: boolean,
  ) {
    try {
      await api.answerChoice({
        agent: agentId,
        messageId,
        answers,
        values,
        closed,
      });
      await refreshList();
      await refreshMessages();
    } catch (err) {
      const msg = errMsg(err);
      if (msg.includes("already resolved")) return;
      showError(err);
      throw err;
    }
  }

  async function saveAgentInfo(fields: {
    name: string;
    model: string;
    effort: string;
    cwd: string;
  }) {
    const id = selectedRef.current.id;
    if (!id || selectedRef.current.kind !== "agent") return;
    const model = fields.model.trim();
    const name = fields.name.trim();
    const cwd = fields.cwd.trim();
    try {
      await api.setAgent({
        id,
        model: model || null,
        effort: fields.effort || null,
        unsetModel: !model,
        unsetEffort: !fields.effort,
        title: null,
        role: null,
        description: null,
        unsetTitle: false,
        unsetRole: false,
        unsetDescription: false,
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

  /** False when the daemon refused, e.g. mid-turn; the error is shown. */
  async function saveAgentCli(cli: CliKind, cmd?: string): Promise<boolean> {
    const id = selectedRef.current.id;
    if (!id || selectedRef.current.kind !== "agent") return false;
    try {
      await api.setAgentCli(id, cli, cmd ?? null);
      await refreshList();
      return true;
    } catch (err) {
      showError(err);
      return false;
    }
  }

  async function saveAgentFace(shape?: string | null, color?: string | null) {
    const id = selectedRef.current.id;
    if (!id || selectedRef.current.kind !== "agent") return;
    // set_agent writes the whole record, so a later color must not land before an earlier one.
    const run = faceSave.current
      .catch(() => undefined)
      .then(async () => {
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
    });
    faceSave.current = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function routineTarget(): string | null {
    const { id, kind } = selectedRef.current;
    if (!id || kind !== "agent") return null;
    return id;
  }

  async function toggleRoutine(r: Routine) {
    const id = routineTarget();
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

  async function loadShared() {
    try {
      return await api.getSharedMemory();
    } catch (err) {
      showError(err);
      return "";
    }
  }

  async function saveShared(text: string, base: string): Promise<boolean> {
    try {
      if (await api.setSharedMemory(text, base)) {
        showToast(t("memory.saved"));
        return true;
      }
      showToast(t("memory.sharedChanged"));
    } catch (err) {
      showError(err);
    }
    return false;
  }

  async function saveMemory(text: string, base: string): Promise<boolean> {
    const id = selectedRef.current.id;
    if (!id || selectedRef.current.kind !== "agent") return false;
    try {
      if (await api.setMemory(id, text, base)) {
        showToast(t("memory.saved"));
        return true;
      }
      showToast(t("memory.changed"));
    } catch (err) {
      showError(err);
    }
    return false;
  }

  async function runRoutine(r: Routine) {
    const id = routineTarget();
    if (!id || !r) return;
    try {
      await api.runRoutine(id, r.id || r.name);
      await refreshList();
    } catch (err) {
      showError(err);
    }
  }

  async function deleteRoutine(r: Routine) {
    const id = routineTarget();
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
      } else if (kind === "remove-group" || kind === "remove-project") {
        removeGroup(id);
        await refreshList();
        await refreshMessages();
        return;
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
    cli: CliKind;
    model: string;
    effort: string;
    cmd: string;
    shape: string | null;
    color: string | null;
    groupId: string | null;
    projectId: string | null;
  }) {
    const name = args.name.trim();
    if (!name) {
      showError(t("error.nameRequired"));
      return;
    }
    const cmd = args.cmd.trim();
    if (args.cli === "custom" && !cmd) {
      showError(t("error.cmdRequired"));
      return;
    }
    const model = args.model.trim();
    const project = args.projectId
      ? groupsRef.current.groups.find(
          (g) => g.id === args.projectId && projectCwd(g),
        )
      : undefined;
    const group =
      project || !args.groupId
        ? undefined
        : groupsRef.current.groups.find(
            (g) => g.id === args.groupId && !projectCwd(g),
          );
    const placeId = project?.id ?? group?.id ?? null;
    const cwd = project ? projectCwd(project) : null;
    try {
      const id = await api.addAgent({
        name,
        cli: args.cli || "grok",
        model: model || null,
        effort: args.effort || null,
        role: null,
        description: null,
        cmd: args.cli === "custom" ? cmd : null,
        cwd,
      });
      if (args.shape || args.color) {
        // The bot already exists. A face that fails to stick must not leave
        // the modal open over it, or the next Create mints a second bot with
        // the same name.
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
            shape: args.shape,
            color: args.color,
            cwd: null,
            unsetCwd: false,
          });
        } catch (err) {
          showError(err);
        }
      }
      closeNewBot();
      selectedRef.current = { id, kind: "agent" };
      setSelected(id);
      setSelectedKind("agent");
      setStick(true);
      setMessages([]);
      closePane();
      await refreshList();
      if (placeId && groupsRef.current.groups.some((g) => g.id === placeId)) {
        moveToGroup("agent", id, placeId);
      }
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
    // The ping owns connection state. A message fetch fails fast with a bare
    // socket error, and at 200ms it would overwrite the ping's reason — and
    // flip `connected` — several times a second.
    async function tickMessages() {
      try {
        await refreshMessages();
      } catch (err) {
        // The ping owns whether the daemon is up; this only says a fetch
        // failed, which at 200ms is far too often to put in front of anyone.
        // It still has to leave a trace — a daemon that is up and answering
        // `Error` here would otherwise freeze the thread on stale messages.
        console.error("refreshMessages", err);
      }
    }
    function lost(err: unknown) {
      if (!cancelled) {
        setConnected(false);
        setConnDetail(errMsg(err));
      }
    }
    async function refreshGroups() {
      if (!groupsLoaded.current) return;
      try {
        const raw = await api.listGroups();
        if (cancelled) return;
        const next = adoptNewGroups(groupsRef.current, raw);
        if (!next) return;
        persistLayout(next);
      } catch (err) {
        console.error("refreshGroups", err);
      }
    }
    async function tickList() {
      try {
        await api.daemonPing();
      } catch (err) {
        lost(err);
        void refreshGroups();
        return;
      }
      if (cancelled) return;
      setConnected(true);
      setConnDetail(t("conn.ok"));
      // Not awaited: a list stuck on a daemon that stopped answering must not
      // hold the ping, which is what notices and brings a dead daemon back.
      void pollList(refreshList).catch(lost);
      void refreshGroups();
    }
    void tickList();
    void tickMessages();
    const working =
      selectedKind === "agent" &&
      !!currentAgent &&
      (currentAgent.status === "working" ||
        currentAgent.status === "blocked");
    const lastRole = messages[messages.length - 1]?.role;
    const expecting = lastRole === "user";
    const hot = working || expecting;
    const msgMs = hot ? 200 : 2000;
    // Status ends the wait dots, so it must not lag the messages while hot.
    const listMs = hot ? 200 : 2000;
    // Only the interval waits its turn. The ticks above run when the status,
    // the last role, or the view changes — when the window has to catch up
    // now — and a daemon that stops answering changes none of those.
    const msgId = window.setInterval(
      () => void pollMessages(tickMessages),
      msgMs,
    );
    const listId = window.setInterval(() => void pollPing(tickList), listMs);
    return () => {
      cancelled = true;
      window.clearInterval(msgId);
      window.clearInterval(listId);
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
      if (newProjectOpenRef.current) {
        e.preventDefault();
        setNewProjectOpen(false);
        return;
      }
      closeConfirm();
      closePane();
      closeNewBot();
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

  useEffect(() => {
    let noticeKey = "";
    function go(hit: FocusTarget) {
      void api.takePendingFocus().catch(() => null);
      selectAgent(hit.id);
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
        noticeKey = "";
        return;
      }
      // A visible window already has the unread dot. Notifying here would
      // repeat the banner the daemon sent while the window was closed.
      if (!loadNotify() || !document.hidden) return;
      const key = `${hit.kind}:${hit.id}:${hit.body}`;
      if (noticeKey === key) return;
      noticeKey = key;
      fireNotice(hit);
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
    selected,
    selectedKind,
    messages,
    messagesFor,
    query,
    setQuery,
    unread,
    searchHits,
    openSearchHit,
    highlightId,
    clearHighlight: () => setHighlightId(null),
    highlightMessage: (id: string) => {
      setStick(false);
      setHighlightId(id);
    },
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
    newBotPlace,
    newProjectOpen,
    toast,
    ctx,
    groups,
    ungrouped,
    pendingRenameId,
    clearPendingRename: () => setPendingRenameId(null),
    currentAgent,
    placeholder,
    selectAgent,
    openInfo,
    openRoutines,
    closePane,
    openConfirm,
    closeConfirm,
    doConfirm,
    openNewBot,
    closeNewBot,
    createBot,
    openNewProject,
    closeNewProject,
    pickProjectFolder,
    createProject,
    cloneBot,
    showCtx,
    showCreateMenu,
    hideCtx,
    createGroup,
    renameGroup,
    removeGroup,
    moveToGroup,
    reorderGroup,
    toggleGroup,
    itemGroupId,
    onSend,
    stopAgent,
    cancelQueued,
    editQueued,
    sendQueued,
    approveAgent,
    answerChoice,
    saveAgentInfo,
    saveAgentCli,
    saveAgentFace,
    toggleRoutine,
    deleteRoutine,
    runRoutine,
    loadMemory,
    saveMemory,
    loadShared,
    saveShared,
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
  if (scope.startsWith("ch:")) return null;
  return { kind: "agent", id: scope, messageId };
}
