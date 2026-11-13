import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { watchHoldsSend } from "./watchView";
import { api, errMsg, newestOnly, oneAtATime } from "./api";
import {
  applyStop,
  heldFor,
  rollbackSend,
  sendKept,
  sendRowId,
  withUnaccepted,
  type HeldSend,
} from "./sendGate";
import { randomFace } from "./avatar";
import { freeBotName, loadBotDefault } from "./botDefault";
import { openPendingOnFocus } from "./focusChat";
import { useT } from "./LocaleContext";
import { loadLastChat, pickOpenAgent, saveLastChat } from "./lastChat";
import { loadNotify } from "./notifyPref";
import { loadNoticeKeep } from "./noticeKeepPref";
import { publishBotSignals, publishBotUnread } from "./botSignals";
import {
  botNotices,
  byRank,
  lifeAfterHover,
  noticeLife,
  NOTICE_LIFE_MS,
  pushNotice,
  type BotNoticeKind,
  type BotSnap,
  type IslandNotice,
  type PlainTone,
} from "./island";
import { loadRead, markRead, saveRead, unreadKeys } from "./readCursors";
import { isOnline, localAgents, remoteLabel } from "./remote";
import { useRemotes } from "./useRemotes";
import { keepSame } from "./stableList";
import {
  adoptNewGroups,
  firstOpenAgent,
  groupCwd,
  focusedGroupId,
  groupIdOf,
  itemKey,
  layoutChanged,
  applyOrder,
  moveGroup,
  moveItem,
  newGroupId,
  normalizeGroups,
  orderedSlots,
  parseItemKey,
  pruneLayout,
  setGroupFolder,
  setGroupLead,
  settleLeads,
  toPersist,
  UNGROUPED_ID,
  uniqueGroupName,
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
  RemoteJoin,
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
  const [selected, setSelected] = useState<string | null>(loadLastChat);
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
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  const [remoteAddOpen, setRemoteAddOpen] = useState(false);
  const { remotes, refreshRemotes } = useRemotes();
  const [groupSettingsId, setGroupSettingsId] = useState<string | null>(null);
  const [islands, setIslands] = useState<IslandNotice[]>([]);
  const [ctx, setCtx] = useState<Ctx>({
    open: false,
    x: 0,
    y: 0,
    id: null,
    kind: "agent",
  });
  const [groups, setGroups] = useState<Group[]>([]);
  const [ungrouped, setUngrouped] = useState<string[]>([]);
  const [order, setOrder] = useState<string[] | undefined>();
  const [pendingRenameId, setPendingRenameId] = useState<string | null>(null);
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  // Bumps when a person opens a chat, so the composer takes the caret.
  // The chat already on screen counts: the click had moved focus away.
  const [composerFocus, setComposerFocus] = useState(0);
  const [readMap, setReadMap] = useState(loadRead);
  // A group whose head was clicked. Opening any chat lets go of it.
  const [pinnedGroup, setPinnedGroup] = useState<string | null>(null);

  const selectedRef = useRef({ id: selected, kind: selectedKind });
  selectedRef.current = { id: selected, kind: selectedKind };
  const faceSave = useRef(Promise.resolve());
  const paneOpenRef = useRef(paneOpen);
  paneOpenRef.current = paneOpen;
  const newGroupOpenRef = useRef(newGroupOpen);
  newGroupOpenRef.current = newGroupOpen;
  const remoteAddOpenRef = useRef(remoteAddOpen);
  remoteAddOpenRef.current = remoteAddOpen;
  const groupSettingsRef = useRef(groupSettingsId);
  groupSettingsRef.current = groupSettingsId;
  const confirmOpenRef = useRef(confirmOpen);
  confirmOpenRef.current = confirmOpen;
  const newBotOpenRef = useRef(newBotOpen);
  newBotOpenRef.current = newBotOpen;
  const ctxOpenRef = useRef(ctx.open);
  ctxOpenRef.current = ctx.open;
  const agentsRef = useRef(agents);
  const quickBusy = useRef(false);
  agentsRef.current = agents;
  const listAgents = useRef(newestOnly(api.listAgents)).current;
  const getMessages = useRef(newestOnly(api.getMessages)).current;
  const pollMessages = useRef(oneAtATime()).current;
  const pollPing = useRef(oneAtATime()).current;
  const pollList = useRef(oneAtATime()).current;
  const groupsRef = useRef<RailLayout>({ groups, ungrouped, order });
  groupsRef.current = order ? { groups, ungrouped, order } : { groups, ungrouped };
  const groupsLoaded = useRef(false);
  const focusedGroup = focusedGroupId(groups, pinnedGroup, selectedKind, selected);
  const focusedGroupRef = useRef(focusedGroup);
  focusedGroupRef.current = focusedGroup;
  // Each notice in the stack has its own clock. While the pointer is on the
  // stack every clock stands still: `end` is when it would have closed,
  // `left` how much was left when the pointer came.
  const islandClocks = useRef(
    new Map<number, { timer: number | null; end: number; left: number | null }>(),
  );
  const islandHeld = useRef(false);
  const islandsRef = useRef<IslandNotice[]>([]);
  const islandSeq = useRef(0);
  const botSnaps = useRef(new Map<string, BotSnap>());
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

  // Where the reader had got to when this chat opened. Taken before the
  // effect below moves the cursor to the end.
  const [openedRead, setOpenedRead] = useState<{ key: string; ts: number } | null>(
    null,
  );
  useEffect(() => {
    if (selected) saveLastChat(selected);
  }, [selected]);

  useEffect(() => {
    if (!selected) return;
    const key = itemKey(selectedKind, selected);
    setOpenedRead({ key, ts: readMap[key] ?? 0 });
  }, [selected, selectedKind]);

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

  // A chat opened by any route moves the focus to its group.
  useEffect(() => setPinnedGroup(null), [selected, selectedKind]);

  // Opening the bot the island talks about, by any route, answers it.
  useEffect(() => {
    if (selectedKind === "agent" && selected) closeBotNotices(selected);
  }, [selected, selectedKind]);

  // So does coming back to the window with that bot's chat already open: a
  // notice raised while the window was away is read the moment it is seen.
  useEffect(() => {
    const seen = () => {
      const sel = selectedRef.current;
      // Seen means in front: on screen and focused, as `watching` reads it.
      if (sel.kind !== "agent" || !sel.id || document.hidden || !document.hasFocus()) return;
      closeBotNotices(sel.id);
    };
    window.addEventListener("focus", seen);
    document.addEventListener("visibilitychange", seen);
    return () => {
      window.removeEventListener("focus", seen);
      document.removeEventListener("visibilitychange", seen);
    };
  }, []);

  // The faces keep a finished run's reaction going until the chat is seen.
  useEffect(() => {
    const keys = new Set(unread);
    publishBotUnread(
      agents.filter((a) => keys.has(itemKey("agent", a.id))).map((a) => a.id),
    );
  }, [unread, agents]);

  useEffect(() => {
    void api.setDockBadge(unread.length).catch(() => null);
  }, [unread.length]);

  const placeholder = !currentAgent
    ? t("composer.placeholder.generic")
    : currentAgent.remote
      ? t(
          isOnline(currentAgent)
            ? "composer.placeholder.remote"
            : "composer.placeholder.remoteOffline",
          { name: remoteLabel(currentAgent) },
        )
      : t("composer.placeholder.agent", {
          name: currentAgent.name || currentAgent.id,
        });

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

  // The notices under the titlebar, newest on top.
  function setStack(next: IslandNotice[]) {
    islandsRef.current = next;
    setIslands(next);
  }

  function raiseIsland(
    next:
      | { kind: PlainTone; text: string }
      | { kind: BotNoticeKind; botId: string },
    life: number | null,
  ) {
    islandSeq.current += 1;
    const notice = {
      ...next,
      seq: islandSeq.current,
      stays: life === null,
      piled: false,
    } as IslandNotice;
    const { stack, dropped } = pushNotice(islandsRef.current, notice);
    for (const n of dropped) stopIslandClock(n.seq);
    setStack(stack);
    // One that stays still gives up its row after a while, into the pile.
    const ms = life ?? NOTICE_LIFE_MS;
    if (islandHeld.current) {
      islandClocks.current.set(notice.seq, { timer: null, end: 0, left: ms });
    } else startIslandClock(notice.seq, ms);
  }

  function startIslandClock(seq: number, life: number) {
    const timer = window.setTimeout(() => {
      const n = islandsRef.current.find((x) => x.seq === seq);
      if (n?.stays) pileIsland(seq);
      else closeIsland(seq);
    }, life);
    islandClocks.current.set(seq, { timer, end: Date.now() + life, left: null });
  }

  function pileIsland(seq: number) {
    stopIslandClock(seq);
    setStack(islandsRef.current.map((n) => (n.seq === seq ? { ...n, piled: true } : n)));
  }

  function clearPile() {
    setStack(islandsRef.current.filter((n) => !n.piled));
  }

  function stopIslandClock(seq: number) {
    const clock = islandClocks.current.get(seq);
    if (clock?.timer) window.clearTimeout(clock.timer);
    islandClocks.current.delete(seq);
  }

  function holdIsland() {
    if (islandHeld.current) return;
    islandHeld.current = true;
    const now = Date.now();
    for (const clock of islandClocks.current.values()) {
      if (clock.timer === null) continue;
      window.clearTimeout(clock.timer);
      clock.timer = null;
      clock.left = Math.max(0, clock.end - now);
    }
  }

  function releaseIsland() {
    if (!islandHeld.current) return;
    islandHeld.current = false;
    for (const [seq, clock] of [...islandClocks.current]) {
      if (clock.left !== null) startIslandClock(seq, lifeAfterHover(clock.left));
    }
  }

  function closeIsland(seq: number) {
    stopIslandClock(seq);
    if (!islandsRef.current.some((n) => n.seq === seq)) return;
    setStack(islandsRef.current.filter((n) => n.seq !== seq));
  }

  function closeBotNotices(botId: string) {
    for (const n of islandsRef.current) {
      if ("botId" in n && n.botId === botId) closeIsland(n.seq);
    }
  }

  /** `brief`: a word like "Copied" that only confirms what the user just did. */
  function showToast(text: string, tone: PlainTone = "ok", brief = false) {
    raiseIsland({ kind: tone, text }, noticeLife(tone, loadNoticeKeep(), brief));
  }

  function showError(err: unknown) {
    showToast(errMsg(err), "error");
  }

  // What the bots just did, for the island. Not the bot whose chat is in
  // front of the user: they see it there already.
  function noticeBots(list: AgentInfo[]) {
    const { notices, snaps } = botNotices(botSnaps.current, list, Date.now());
    botSnaps.current = snaps;
    const sel = selectedRef.current;
    const watching = (id: string) =>
      sel.kind === "agent" && sel.id === id && document.hasFocus() && !document.hidden;
    const keep = loadNoticeKeep();
    const fresh = notices.filter((n) => !watching(n.botId));
    for (const n of byRank(fresh)) raiseIsland(n, noticeLife(n.kind, keep));
    // A question answered or an approval given somewhere else lets its notice go.
    const said = new Set(fresh.map((n) => n.botId));
    for (const cur of islandsRef.current) {
      if (!("botId" in cur) || said.has(cur.botId)) continue;
      const snap = snaps.get(cur.botId);
      const over =
        !snap ||
        (cur.kind === "question" && !snap.asking) ||
        (cur.kind === "blocked" && snap.status !== "blocked") ||
        (cur.kind === "failure" && snap.status === "working");
      if (over) closeIsland(cur.seq);
    }
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

  function focusComposer() {
    setComposerFocus((n) => n + 1);
  }

  /** `focus: false` leaves the keys where they are, as a click on a split half does. */
  function selectAgent(id: string, highlight: string | null = null, focus = true) {
    // The chat may already be open, so the selection effect would not run.
    setPinnedGroup(null);
    selectedRef.current = { id, kind: "agent" };
    setSelected(id);
    setSelectedKind("agent");
    setStick(!highlight);
    setHighlightId(highlight);
    closePane();
    if (focus) focusComposer();
    void refreshMessages();
  }

  function openPane(id: string, tab: PaneTab) {
    const a = agentsRef.current.find((x) => x.id === id);
    // A teammate's bot has no settings, routines or memory on this PC.
    if (!a || a.remote) return;
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

  function showSplitMenu(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setCtx({
      open: true,
      x: Math.round(r.right - 168),
      y: Math.round(r.bottom + 4),
      id: null,
      kind: "split",
    });
  }

  /** The "..." on a folder head opens the same menu as a right click, under it. */
  function showGroupMenu(e: MouseEvent, id: string) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setCtx({
      open: true,
      x: Math.round(r.left),
      y: Math.round(r.bottom + 4),
      id,
      kind: "group",
    });
  }

  function persistLayout(raw: RailLayout) {
    // A bot that moved out of its group no longer leads it.
    const next = settleLeads(raw);
    const groupsOnly = next.groups.filter((g) => g.id !== UNGROUPED_ID);
    const layout = applyOrder(
      groupsOnly,
      orderedSlots({
        groups: groupsOnly,
        ungrouped: next.ungrouped,
        order: next.order,
      }),
    );
    groupsLoaded.current = true;
    groupsRef.current = layout;
    setGroups(layout.groups);
    setUngrouped(layout.ungrouped);
    setOrder(layout.order);
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
        order: current.order,
      });
    } else {
      const visual = visibleUngroupedKeys(
        current.groups,
        current.ungrouped,
        localAgents(agentsRef.current),
      );
      const stripped = moveItem(current, key, null, null, visual);
      persistLayout({
        groups: [
          ...stripped.groups,
          { id, name, collapsed: false, items: [key] },
        ],
        ungrouped: stripped.ungrouped.filter((k) => k !== key),
        order: stripped.order,
      });
    }
    setPendingRenameId(id);
  }

  function openNewGroup() {
    setNewGroupOpen(true);
  }

  function closeNewGroup() {
    setNewGroupOpen(false);
  }

  async function pickFolder(): Promise<string | null> {
    try {
      return await api.pickFolder();
    } catch (err) {
      showError(err);
      return null;
    }
  }

  /** A folder is optional. With one, it becomes the working folder of the group's bots. */
  function createNamedGroup(name: string, path: string, memory = "") {
    const trimmed = name.trim();
    if (!trimmed) return;
    const current = groupsRef.current;
    const id = newGroupId(current.groups.map((g) => g.id));
    const created: Group = {
      id,
      name: uniqueGroupName(current.groups, trimmed),
      collapsed: false,
      items: [],
    };
    const folder = path.trim();
    if (folder) created.path = folder;
    persistLayout({
      groups: [...current.groups, created],
      ungrouped: current.ungrouped,
      order: current.order,
    });
    setNewGroupOpen(false);
    // The group is there either way; a memory that fails to save can be
    // written again from its settings.
    if (memory.trim()) {
      void api.setGroupMemory(id, memory, "").catch((err) => showError(err));
    }
  }

  function openGroupSettings(id: string) {
    setGroupSettingsId(id);
  }

  function closeGroupSettings() {
    setGroupSettingsId(null);
  }

  async function loadGroupMemory(id: string) {
    try {
      return await api.getGroupMemory(id);
    } catch (err) {
      showError(err);
      return "";
    }
  }

  /** A new folder becomes the working folder of the bots already inside, as
      if each had just moved in. Clearing it leaves their folders alone. */
  async function saveGroupSettings(
    id: string,
    fields: { path: string; memory: string; base: string },
  ): Promise<boolean> {
    const before = groupsRef.current.groups.find((g) => g.id === id);
    if (!before) return false;
    try {
      // Untouched notes are not written, so a bot's note since then stays and
      // a folder change still goes through.
      const same = fields.memory === fields.base;
      if (!same && !(await api.setGroupMemory(id, fields.memory, fields.base))) {
        showToast(t("groupSettings.changed"), "warn");
        return false;
      }
    } catch (err) {
      showError(err);
      return false;
    }
    const folder = fields.path.trim();
    if (folder !== (groupCwd(before) ?? "")) {
      persistLayout(setGroupFolder(groupsRef.current, id, folder));
      if (folder) {
        for (const key of before.items) {
          const item = parseItemKey(key);
          if (item?.kind === "agent") pinCwd(item.id, folder);
        }
      }
    }
    showToast(t("memory.saved"), "ok", true);
    return true;
  }

  function renameGroup(id: string, name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    persistLayout({
      groups: groupsRef.current.groups.map((g) =>
        g.id === id ? { ...g, name: trimmed } : g,
      ),
      ungrouped: groupsRef.current.ungrouped,
      order: groupsRef.current.order,
    });
  }

  function removeGroup(id: string) {
    const current = groupsRef.current;
    const gone = current.groups.find((g) => g.id === id);
    const items = (gone?.items || []).filter((k) => parseItemKey(k));
    const slots = orderedSlots(current).flatMap((k) => (k === id ? items : [k]));
    persistLayout(
      applyOrder(
        current.groups.filter((g) => g.id !== id),
        slots,
      ),
    );
    void api.removeGroupMemory(id).catch((err) => showError(err));
  }

  function moveToGroup(
    kind: Kind,
    id: string,
    groupId: string | null,
    beforeKey?: string | null,
  ) {
    // A teammate's bot sits under its router, not in the folders.
    if (agentsRef.current.find((a) => a.id === id)?.remote) return;
    const current = groupsRef.current;
    const fromId = groupIdOf(current.groups, kind, id);
    const visual = visibleUngroupedKeys(
      current.groups,
      current.ungrouped,
      localAgents(agentsRef.current),
    );
    persistLayout(moveItem(current, itemKey(kind, id), groupId, beforeKey, visual));
    if (kind !== "agent" || !groupId || groupId === fromId) return;
    const dest = groupCwd(current.groups.find((g) => g.id === groupId));
    const prev = groupCwd(current.groups.find((g) => g.id === fromId));
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
      order: groupsRef.current.order,
    });
  }

  /** Make `botId` lead the group it sits in, or clear that group's lead. */
  function setLead(groupId: string, botId: string | null) {
    persistLayout(setGroupLead(groupsRef.current, groupId, botId));
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

  // The open chat survives a restart. A bot that is no longer in the list
  // waits for the folder layout, then the window opens the first visible row.
  function applyOpenAgent(list: AgentInfo[]) {
    const ready = groupsLoaded.current;
    const sel = pickOpenAgent(
      selectedRef.current.id,
      loadLastChat(),
      list,
      ready
        ? firstOpenAgent(
            groupsRef.current.groups,
            groupsRef.current.ungrouped,
            localAgents(list),
            groupsRef.current.order,
          )
        : null,
      ready,
    );
    selectedRef.current = { id: sel, kind: "agent" };
    setSelected(sel);
    setSelectedKind("agent");
    if (paneOpenRef.current && !list.some((x) => x.id === sel)) {
      setPaneOpen(false);
    }
  }

  const refreshList = useCallback(async () => {
    const list = await listAgents();
    if (!list) return;
    // Before the list state, so a face sees its status and signal together.
    publishBotSignals(list);
    noticeBots(list);
    // A bot at work is polled five times a second, mostly to the same answer.
    setAgents((prev) => keepSame(prev, list));
    if (groupsLoaded.current) {
      const pruned = pruneLayout(groupsRef.current, localAgents(list));
      if (layoutChanged(pruned, groupsRef.current)) persistLayout(pruned);
    }
    applyOpenAgent(list);
  }, []);

  const refreshMessages = useCallback(async () => {
    const { id } = selectedRef.current;
    if (!id) {
      setMessages([]);
      return;
    }
    const next = await getMessages(id);
    if (!next) return;
    // A send the daemon has not answered stays on the end as a sending line
    // until its own row is in this snapshot.
    const shown = withUnaccepted(next, heldFor(id, heldSends.current));
    setMessages((prev) => keepSame(prev, shown));
    setMessagesFor(id);
  }, []);

  async function onSend(raw: string, steer = false): Promise<boolean> {
    const { id: sel } = selectedRef.current;
    if (!sel) return false;
    sendSeq.current += 1;
    const now = Date.now();
    const held: HeldSend = {
      id: sendRowId(sendSeq.current, now),
      agent: sel,
      text: raw,
      at: now,
    };
    heldSends.current = [...heldSends.current, held];
    if (selectedRef.current.id === sel) {
      setMessages((prev) => withUnaccepted(prev, [held]));
    }
    let accepted = false;
    try {
      await api.sendMessage(sel, raw, steer, held.id);
      accepted = true;
    } catch (err) {
      // A failed start can still leave the line queued. That is the waiting
      // row, so the composer must not also put the draft back. Asked straight,
      // not through the poll's newest-only gate, which can answer null.
      try {
        const next = await api.getMessages(sel);
        if (sendKept(next, held.id)) accepted = true;
        else showError(err);
      } catch {
        showError(err);
      }
    }
    // Drops the sending line too. Once the daemon row with its id is in, the
    // row is that one and this finds nothing; if it never came (a failed
    // send, a fetch that failed, another chat open), no line is left behind.
    // On failure the draft goes back.
    const release = () => {
      heldSends.current = heldSends.current.filter((h) => h.id !== held.id);
      setMessages((prev) => rollbackSend(prev, held.id).messages);
    };
    if (!accepted) {
      release();
      return false;
    }
    // Still held while this fetch runs, so a poll that left before the daemon
    // row existed cannot drop the bubble. The daemon row has the same id, so
    // it takes the line's place without a remount.
    try {
      if (selectedRef.current.id === sel) await refreshMessages();
    } catch (err) {
      showError(err);
    } finally {
      release();
    }
    return true;
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
    others: string[],
    closed: boolean,
  ) {
    try {
      await api.answerChoice({
        agent: agentId,
        messageId,
        answers,
        values,
        others,
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

  async function renameAgent(id: string, name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    const agent = agentsRef.current.find((a) => a.id === id);
    if (!agent || agent.remote) return;
    if (trimmed === (agent.name || agent.id)) return;
    try {
      await api.setName(id, trimmed);
      await refreshList();
    } catch (err) {
      showError(err);
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
      } else if (kind === "remove-group") {
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
      // Read before the list refresh: the copy lands in the original's group,
      // right after it.
      const fromGroup = groupsRef.current.groups.find((g) =>
        g.items.includes(itemKey("agent", id)),
      );
      const after = fromGroup?.items[fromGroup.items.indexOf(itemKey("agent", id)) + 1];
      selectedRef.current = { id: newId, kind: "agent" };
      setSelected(newId);
      setSelectedKind("agent");
      setStick(true);
      setMessages([]);
      closePane();
      focusComposer();
      await refreshList();
      if (fromGroup && groupsRef.current.groups.some((g) => g.id === fromGroup.id)) {
        moveToGroup("agent", newId, fromGroup.id, after);
      }
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
    const group = args.groupId
      ? groupsRef.current.groups.find((g) => g.id === args.groupId)
      : undefined;
    const placeId = group?.id ?? null;
    const cwd = groupCwd(group);
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
      focusComposer();
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

  function openRemoteAdd() {
    setRemoteAddOpen(true);
  }

  function closeRemoteAdd() {
    setRemoteAddOpen(false);
  }

  /** A failed change is shown; the list is read again either way. */
  async function setRemote(change: {
    alias: string;
    trusted: string[] | null;
    blocked: string[] | null;
  }) {
    try {
      await api.remoteSet(change);
    } catch (err) {
      showError(err);
    }
    await refreshRemotes();
  }

  /** Leaves the router. The representative bot and its chat stay. */
  async function leaveRemote(alias: string) {
    try {
      await api.remoteLeave(alias);
      showToast(t("remote.left", { alias }));
    } catch (err) {
      showError(err);
    }
    await refreshRemotes();
    await refreshList().catch(showError);
  }

  /**
   * Signs up to a router and opens the representative bot it made. A refusal
   * is thrown back, so the dialog can put it under the field it is about.
   */
  async function joinRemote(args: RemoteJoin) {
    const custom = args.cli === "custom";
    const id = await api.remoteJoin({
      url: args.url,
      alias: args.alias,
      name: args.name,
      invite: args.invite,
      cli: args.cli,
      avatar: null,
      avatarShape: args.shape,
      avatarColor: args.color,
      role: args.role,
    });
    // The account exists now. What sign-up does not carry is set on the bot
    // after, and a failure there is shown, not thrown: the dialog must close
    // or the next Join asks for a second account.
    const model = args.model.trim();
    try {
      if (custom && args.cmd.trim()) await api.setAgentCli(id, "custom", args.cmd.trim());
      if (model || args.effort) {
        await api.setAgent({
          id,
          model: model || null,
          effort: args.effort || null,
          unsetModel: false,
          unsetEffort: false,
          title: null,
          role: null,
          description: null,
          unsetTitle: false,
          unsetRole: false,
          unsetDescription: false,
          cwd: null,
          unsetCwd: false,
        });
      }
    } catch (err) {
      showError(err);
    }
    closeRemoteAdd();
    selectedRef.current = { id, kind: "agent" };
    setSelected(id);
    setSelectedKind("agent");
    setStick(true);
    setMessages([]);
    closePane();
    focusComposer();
    await refreshList().catch(showError);
    void refreshRemotes();
    await refreshMessages().catch(showError);
  }

  /**
   * ⌘⇧N: a bot on the default AI with a random face, no form. It joins the
   * focused group, so it works in that group's folder.
   */
  async function createQuickBot() {
    if (quickBusy.current) return;
    quickBusy.current = true;
    try {
      const start = loadBotDefault();
      const face = randomFace();
      await createBot({
        name: freeBotName(t("quickBot.name"), agentsRef.current.map((a) => a.name)),
        cli: start.cli,
        model: start.model,
        effort: start.effort,
        cmd: start.cmd,
        shape: face.shape,
        color: face.color,
        groupId: focusedGroupRef.current,
      });
    } finally {
      quickBusy.current = false;
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
        setOrder(next.order);
        if (agentsRef.current.length) applyOpenAgent(agentsRef.current);
      })
      .catch(() => {
        if (cancelled || groupsLoaded.current) return;
        groupsLoaded.current = true;
        setGroups([]);
        setUngrouped([]);
        if (agentsRef.current.length) applyOpenAgent(agentsRef.current);
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
    // A turn that still owns its watch is not about to say anything. An idle
    // bot with a watch is a resident CLI, and the next message goes now.
    const working =
      selectedKind === "agent" &&
      !!currentAgent &&
      !watchHoldsSend(currentAgent) &&
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
      if (e.defaultPrevented || e.isComposing) return;
      if (e.key !== "Escape") return;
      if (newGroupOpenRef.current) {
        e.preventDefault();
        setNewGroupOpen(false);
        return;
      }
      if (remoteAddOpenRef.current) {
        e.preventDefault();
        setRemoteAddOpen(false);
        return;
      }
      if (groupSettingsRef.current) {
        e.preventDefault();
        setGroupSettingsId(null);
        return;
      }
      // Idle Escape still leaves fullscreen. Only a layer that this key
      // closes marks the event handled.
      if (
        !confirmOpenRef.current &&
        !paneOpenRef.current &&
        !newBotOpenRef.current &&
        !ctxOpenRef.current
      ) {
        return;
      }
      e.preventDefault();
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
      // The file records who finished while the window was away. Opening that
      // chat here is why coming back lands on a different bot. A notification
      // click calls go() itself. This only opens a pending chat when the
      // window has none yet.
      void api
        .takePendingFocus()
        .then((hit) => {
          const open = openPendingOnFocus(
            selectedRef.current.id,
            hit?.id ?? null,
          );
          if (hit && open) go(hit);
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
    openedRead,
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
    confirmId,
    newBotOpen,
    newBotPlace,
    newGroupOpen,
    remoteAddOpen,
    remotes,
    refreshRemotes,
    groupSettingsId,
    islands,
    closeIsland,
    closeBotNotices,
    clearPile,
    holdIsland,
    releaseIsland,
    ctx,
    groups,
    ungrouped,
    order,
    pendingRenameId,
    clearPendingRename: () => setPendingRenameId(null),
    currentAgent,
    placeholder,
    composerFocus,
    selectAgent,
    openInfo,
    openRoutines,
    closePane,
    openConfirm,
    closeConfirm,
    doConfirm,
    openNewBot,
    createQuickBot,
    closeNewBot,
    createBot,
    openNewGroup,
    closeNewGroup,
    openRemoteAdd,
    closeRemoteAdd,
    joinRemote,
    setRemote,
    leaveRemote,
    pickFolder,
    createNamedGroup,
    openGroupSettings,
    closeGroupSettings,
    loadGroupMemory,
    saveGroupSettings,
    cloneBot,
    showCtx,
    showCreateMenu,
    showSplitMenu,
    showGroupMenu,
    hideCtx,
    createGroup,
    renameGroup,
    removeGroup,
    moveToGroup,
    reorderGroup,
    toggleGroup,
    setLead,
    focusedGroup,
    focusGroup: setPinnedGroup,
    itemGroupId,
    onSend,
    stopAgent,
    cancelQueued,
    editQueued,
    sendQueued,
    approveAgent,
    answerChoice,
    renameAgent,
    saveAgentInfo,
    saveAgentCli,
    saveAgentFace,
    toggleRoutine,
    deleteRoutine,
    runRoutine,
    showError,
    showToast,
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
