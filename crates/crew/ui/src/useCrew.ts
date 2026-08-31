import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { api, errMsg } from "./api";
import type {
  AgentInfo,
  ChannelInfo,
  ChatMessage,
  CliKind,
  ConfirmKind,
  Kind,
  PendingAvatar,
  Routine,
} from "./types";

type Ctx = {
  open: boolean;
  x: number;
  y: number;
  id: string | null;
  kind: Kind;
};

export function useCrew() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedKind, setSelectedKind] = useState<Kind>("agent");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [query, setQuery] = useState("");
  const [stick, setStick] = useState(true);
  const [toId, setToId] = useState("");
  const [connected, setConnected] = useState<boolean | null>(null);
  const [connDetail, setConnDetail] = useState("데몬 확인 중…");
  const [infoOpen, setInfoOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmKind, setConfirmKind] = useState<ConfirmKind>("reset");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [newBotOpen, setNewBotOpen] = useState(false);
  const [newChannelOpen, setNewChannelOpen] = useState(false);
  const [pendingNewAvatar, setPendingNewAvatar] = useState<PendingAvatar | null>(
    null,
  );
  const [toast, setToast] = useState({ text: "", show: false });
  const [ctx, setCtx] = useState<Ctx>({
    open: false,
    x: 0,
    y: 0,
    id: null,
    kind: "agent",
  });

  const selectedRef = useRef({ id: selected, kind: selectedKind });
  selectedRef.current = { id: selected, kind: selectedKind };
  const infoOpenRef = useRef(infoOpen);
  infoOpenRef.current = infoOpen;
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const toastTimer = useRef<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const avatarPickId = useRef<string | null>(null);

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
      ? `+ ${currentAgent.name || currentAgent.id}에게 메시지`
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

  function closeInfo() {
    setInfoOpen(false);
  }

  function closeConfirm() {
    setConfirmOpen(false);
    setConfirmId(null);
    setConfirmKind("reset");
  }

  function closeNewBot() {
    setNewBotOpen(false);
    setPendingNewAvatar(null);
  }

  function closeNewChannel() {
    setNewChannelOpen(false);
  }

  function selectAgent(id: string) {
    selectedRef.current = { id, kind: "agent" };
    setSelected(id);
    setSelectedKind("agent");
    setToId(id);
    setStick(true);
    closeInfo();
    void refreshMessages();
  }

  function selectChannel(id: string) {
    selectedRef.current = { id, kind: "channel" };
    setSelected(id);
    setSelectedKind("channel");
    setStick(true);
    closeInfo();
    void refreshMessages();
  }

  function openInfo(id: string) {
    const a = agentsRef.current.find((x) => x.id === id);
    if (!a) return;
    selectedRef.current = { id, kind: "agent" };
    setSelected(id);
    setSelectedKind("agent");
    setInfoOpen(true);
  }

  function openConfirm(id: string, kind: ConfirmKind = "reset") {
    if (!id) return;
    setConfirmId(id);
    setConfirmKind(kind);
    setConfirmOpen(true);
  }

  function showCtx(e: MouseEvent, id: string, kind: Kind) {
    setCtx({ open: true, x: e.clientX, y: e.clientY, id, kind });
  }

  function pickAvatar(id: string) {
    avatarPickId.current = id;
    fileRef.current?.click();
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
    setSelected(sel);
    setSelectedKind(kind);
    setToId((prev) => {
      if (list.some((a) => a.id === prev)) return prev;
      return sel && kind === "agent" ? sel : list[0]?.id || "";
    });
    if (infoOpenRef.current) {
      const a = kind === "agent" ? list.find((x) => x.id === sel) : null;
      if (!a) setInfoOpen(false);
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
    if (kind === "channel") {
      if (!sel) return;
      try {
        await api.channelSend(sel, raw);
        await refreshMessages();
      } catch (err) {
        showError(err);
      }
      return;
    }
    const parsed = parseOutgoing(raw, agentsRef.current, toId || sel);
    if (parsed.mention && !parsed.to) {
      showError("unknown agent " + parsed.mention);
      return;
    }
    const to = parsed.to || sel;
    if (!to) return;
    try {
      if (parsed.mention || to !== sel) {
        await api.tellMessage(to, parsed.text);
        showToast("user → " + to);
      } else {
        await api.sendMessage(to, parsed.text);
      }
      await refreshMessages();
    } catch (err) {
      showError(err);
    }
  }

  async function saveAgentInfo(fields: {
    title: string;
    role: string;
    description: string;
    model: string;
    effort: string;
  }) {
    const id = selectedRef.current.id;
    if (!id || selectedRef.current.kind !== "agent") return;
    const model = fields.model.trim();
    const title = fields.title.trim();
    const role = fields.role.trim();
    const description = fields.description.trim();
    try {
      await api.setAgent({
        id,
        model: model || null,
        effort: fields.effort || null,
        unsetModel: !model,
        unsetEffort: !fields.effort,
        title: title || null,
        role: role || null,
        description: description || null,
        unsetTitle: !title,
        unsetRole: !role,
        unsetDescription: !description,
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
      showError("루틴 이름, cron, 프롬프트를 모두 입력하세요");
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
      closeInfo();
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
      if (pendingNewAvatar) {
        await api.setAvatar(id, pendingNewAvatar.data, pendingNewAvatar.name);
      }
      closeNewBot();
      selectedRef.current = { id, kind: "agent" };
      setSelected(id);
      setSelectedKind("agent");
      setStick(true);
      setMessages([]);
      closeInfo();
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
      closeInfo();
      await refreshList();
      await refreshMessages();
    } catch (err) {
      showError(err);
      await refreshList();
    }
  }

  async function onAvatarFile(file: File | undefined) {
    const target = avatarPickId.current;
    avatarPickId.current = null;
    if (!file || !target) return;
    const okType = /image\/(png|jpeg|jpg|webp|gif)/i.test(file.type);
    const okName = /\.(png|jpe?g|webp|gif)$/i.test(file.name || "");
    if (!okType && !okName) {
      showError("png, jpg, webp, gif만 사용할 수 있습니다");
      return;
    }
    const data = await readFileDataUrl(file);
    if (target === "__new__") {
      setPendingNewAvatar({ data, name: file.name });
      return;
    }
    try {
      await api.setAvatar(target, data, file.name);
      await refreshList();
    } catch (err) {
      showError(err);
    }
  }

  async function clearAvatar(id: string) {
    try {
      await api.clearAvatar(id);
      await refreshList();
    } catch (err) {
      showError(err);
    }
  }

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
      closeInfo();
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
    toId,
    setToId,
    connected,
    connDetail,
    infoOpen,
    confirmOpen,
    confirmKind,
    newBotOpen,
    newChannelOpen,
    pendingNewAvatar,
    toast,
    ctx,
    currentAgent,
    currentChannel,
    placeholder,
    fileRef,
    selectAgent,
    selectChannel,
    openInfo,
    closeInfo,
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
    hideCtx,
    pickAvatar,
    onAvatarFile,
    clearAvatar,
    setPendingNewAvatar,
    onSend,
    saveAgentInfo,
    addRoutine,
    toggleRoutine,
    deleteRoutine,
    loadMemory,
    saveMemory,
    showError,
  };
}

function parseOutgoing(
  raw: string,
  agents: AgentInfo[],
  fallback: string | null,
): { to: string | null; text: string; mention: string | null } {
  const m = raw.match(/^@(\S+)\s+([\s\S]*)$/);
  if (m) {
    const key = m[1];
    const text = m[2];
    const lower = key.toLowerCase();
    const agent =
      agents.find((a) => a.id === key || a.name === key) ||
      agents.find(
        (a) =>
          a.id.toLowerCase() === lower || (a.name || "").toLowerCase() === lower,
      );
    return { to: agent ? agent.id : null, text, mention: key };
  }
  return { to: fallback, text: raw, mention: null };
}

function readFileDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(r.error || new Error("read failed"));
    r.readAsDataURL(file);
  });
}
