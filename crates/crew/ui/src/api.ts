import { invoke } from "./transport";
import type { CloneParts } from "./cloneParts";
import type { MobilePair, MobileStatus } from "./mobileAccess";
import type { Template } from "./templates";
import type { PathKind } from "./dropAttach";
import type { DisplayPrefs } from "./displayPrefs";
import type {
  AgentInfo,
  ChatMessage,
  Group,
  ModelList,
  FocusTarget,
  PlanUsage,
  RemoteInfo,
  RemoteServer,
  SearchHit,
  SavedSkill,
  Skill,
  TeamMemory,
  TextFile,
} from "./types";

const modelLists = new Map<string, Promise<ModelList>>();

/** What `link_states` says of one link: no state when `gh` could not read it. */
export type LinkState = { url: string; kind?: string; state?: string; title?: string };
/** What GitHub says a link is now. `kind` is what it really is: GitHub sends an issue address of a PR on to the PR. */
export type GithubState = { state: "open" | "merged" | "closed"; title?: string; kind?: "pr" | "issue" };

export function linkStateMap(list: readonly LinkState[]): Record<string, GithubState> {
  const out: Record<string, GithubState> = {};
  for (const s of list) {
    if (s.state === "open" || s.state === "merged" || s.state === "closed") {
      const kind = s.kind === "pr" || s.kind === "issue" ? s.kind : undefined;
      out[s.url] = { state: s.state, title: s.title, ...(kind ? { kind } : {}) };
    }
  }
  return out;
}

/**
 * What the daemon says of a file: there, not there, or in a place it does not
 * show files from (a hidden folder, or outside the home and temp folders) and
 * so does not say whether it is there.
 */
export type FileState = "exists" | "missing" | "blocked";

/** `file_states` answers in the order it was asked. */
export function fileStateMap(paths: readonly string[], found: readonly unknown[]): Record<string, FileState> {
  const out: Record<string, FileState> = {};
  paths.forEach((p, i) => {
    const s = found[i];
    if (s === "exists" || s === "missing" || s === "blocked") out[p] = s;
  });
  return out;
}

export function errMsg(err: unknown): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

/**
 * Daemon commands run off the main thread, side by side, so an answer can
 * land after one sent later. Null means a later call already landed and this
 * answer is older than what the window shows.
 */
export function newestOnly<A extends unknown[], T>(
  fetch: (...args: A) => Promise<T>,
): (...args: A) => Promise<T | null> {
  let sent = 0;
  let shown = 0;
  return async (...args) => {
    const seq = ++sent;
    const value = await fetch(...args);
    if (seq < shown) return null;
    shown = seq;
    return value;
  };
}

/**
 * A poll that skips its turn while the last one is still out. A daemon that
 * stops answering holds each call for the answer timeout, and an interval that
 * kept firing would stack one more call per tick until it came back.
 */
export function oneAtATime() {
  let busy = false;
  return async (work: () => Promise<void>) => {
    if (busy) return;
    busy = true;
    try {
      await work();
    } finally {
      busy = false;
    }
  };
}

export const api = {
  listAgents: () => invoke<AgentInfo[]>("list_agents"),
  /** `id` is the row id the window drew the line under; the daemon's row keeps it. */
  sendMessage: (agent: string, text: string, steer = false, id?: string) =>
    invoke<void>("send_message", { agent, text, steer, id }),
  stopAgent: (agent: string) => invoke<void>("stop_agent", { agent }),
  cancelQueued: (agent: string, messageId: string) =>
    invoke<void>("cancel_queued", { agent, messageId }),
  editQueued: (agent: string, messageId: string, text: string) =>
    invoke<void>("edit_queued", { agent, messageId, text }),
  sendQueued: (agent: string, messageId: string) =>
    invoke<void>("send_queued", { agent, messageId }),
  approveAgent: (agent: string, allow: boolean, always = false) =>
    invoke<void>("approve_agent", { agent, allow, always }),
  answerChoice: (args: {
    agent: string;
    messageId: string;
    answers: string[][];
    values?: string[][];
    others?: string[];
    closed: boolean;
  }) =>
    invoke<void>("answer_choice", {
      agent: args.agent,
      messageId: args.messageId,
      answers: args.answers,
      values: args.values ?? [],
      others: args.others ?? [],
      closed: args.closed,
    }),
  tellMessage: (to: string, text: string, from = "user") =>
    invoke<void>("tell_message", { from, to, text }),
  getMessages: (agent: string) => invoke<ChatMessage[]>("get_messages", { agent }),
  /**
   * How far each chat has been read, on any device (the window or a paired
   * phone), by chat key. A device keeps its own copy too; the later wins.
   */
  readMarks: () => invoke<Record<string, number>>("get_read_marks"),
  /** Move a chat's shared read mark forward. It never moves back. */
  markRead: (key: string, ts: number) => invoke<number>("mark_read", { key, ts }),
  /** 보관함: the bot's pinned links and files, by key (a link's address or a file's path). */
  archivePins: (agent: string) => invoke<string[]>("get_pins", { agent }),
  setArchivePin: (agent: string, key: string, pinned: boolean) =>
    invoke<string[]>("set_pin", { agent, key, pinned }),
  /** GitHub PRs and issues `gh` could read, by address. Others are left out. */
  githubStates: async (urls: string[]) =>
    linkStateMap(await invoke<LinkState[]>("link_states", { urls })),
  /** Whether each file is there, is not, or is somewhere the archive cannot show files from, by path. */
  fileStates: async (paths: string[]) => fileStateMap(paths, await invoke<string[]>("file_states", { paths })),
  daemonPing: () => invoke<void>("daemon_ping"),
  resetAgent: (agent: string, dropRoutines: boolean) =>
    invoke<string>("reset_agent", { agent, dropRoutines }),
  setAgent: (args: {
    id: string;
    model: string | null;
    effort: string | null;
    unsetModel: boolean;
    unsetEffort: boolean;
    title: string | null;
    description: string | null;
    role: string | null;
    unsetTitle: boolean;
    unsetDescription: boolean;
    unsetRole: boolean;
    shape?: string | null;
    color?: string | null;
    name?: string | null;
    cwd?: string | null;
    // Required, like the other five `unset*` flags: Tauri reads a missing key
    // for an `Option<T>` as `None`, but a `bool` with no key is an error. The
    // optional marker is what let a caller drop it.
    unsetCwd: boolean;
  }) => invoke<void>("set_agent", args),
  setAgentCli: (id: string, cli: string, cmd?: string | null) =>
    invoke<void>("set_agent_cli", { id, cli, cmd: cmd ?? null }),
  addAgent: (args: {
    name: string;
    cli: string;
    model: string | null;
    effort: string | null;
    role: string | null;
    description: string | null;
    cmd?: string | null;
    cwd?: string | null;
    /** No first turn asking what to take on. */
    quiet?: boolean;
    /** One from `reserveAgentIds`. Without it the daemon makes one up. */
    id?: string | null;
    /** The face, set as the bot is made. */
    shape?: string | null;
    color?: string | null;
  }) =>
    invoke<string>("add_agent", {
      ...args,
      cwd: args.cwd ?? null,
      quiet: args.quiet ?? null,
      id: args.id ?? null,
      shape: args.shape ?? null,
      color: args.color ?? null,
    }),
  /** Ids for bots about to be made, free now and of each other. */
  reserveAgentIds: (names: string[]) => invoke<string[]>("reserve_agent_ids", { names }),
  /** Display name only. The other set_agent fields stay as they are. */
  setName: (id: string, name: string) =>
    invoke<void>("set_agent", {
      id,
      model: null,
      effort: null,
      unsetModel: false,
      unsetEffort: false,
      title: null,
      description: null,
      role: null,
      unsetTitle: false,
      unsetDescription: false,
      unsetRole: false,
      name,
      unsetCwd: false,
    }),
  /** Working folder only. The other set_agent fields stay as they are. */
  setCwd: (id: string, cwd: string) =>
    invoke<void>("set_agent", {
      id,
      model: null,
      effort: null,
      unsetModel: false,
      unsetEffort: false,
      title: null,
      description: null,
      role: null,
      unsetTitle: false,
      unsetDescription: false,
      unsetRole: false,
      cwd,
      unsetCwd: false,
    }),
  pickFolder: () => invoke<string | null>("pick_folder"),
  /** Without `parts` the daemon clones as it always did. */
  cloneAgent: (id: string, name: string | null = null, parts: CloneParts | null = null) =>
    invoke<string>("clone_agent", { id, name, parts }),
  removeAgent: (id: string) => invoke<void>("remove_agent", { id }),
  setAvatar: (id: string, data: string, name?: string | null) =>
    invoke<void>("set_avatar", { id, data, name: name ?? null }),
  clearAvatar: (id: string) => invoke<void>("clear_avatar", { id }),
  removeRoutine: (agent: string, key: string) =>
    invoke<void>("remove_routine", { agent, key }),
  setRoutineEnabled: (agent: string, key: string, enabled: boolean) =>
    invoke<void>("set_routine_enabled", { agent, key, enabled }),
  runRoutine: (agent: string, key: string) =>
    invoke<void>("run_routine", { agent, key }),
  getGroupMemory: (group: string) => invoke<string>("get_group_memory", { group }),
  setGroupMemory: (group: string, text: string, base: string) =>
    invoke<boolean>("set_group_memory", { group, text, base }),
  removeGroupMemory: (group: string) => invoke<void>("remove_group_memory", { group }),
  listGroups: () => invoke<Group[]>("list_groups"),
  planUsage: (clis: string[]) => invoke<PlanUsage[]>("plan_usage", { clis }),
  setGroups: (groups: Group[]) => invoke<void>("set_groups", { groups }),
  searchCrew: (query: string) => invoke<SearchHit[]>("search_crew", { query }),
  listSkills: () => invoke<Skill[]>("list_skills"),
  lookupSkill: (query: string) => invoke<Skill | null>("lookup_skill", { query }),
  saveSkill: (
    name: string,
    body: string,
    previous: string | null,
    overwrite: string | null,
  ) =>
    invoke<SavedSkill>("save_skill", { name, body, previous, overwrite }),
  removeSkill: (name: string) => invoke<void>("remove_skill", { name }),
  saveUpload: (name: string, data: string) =>
    invoke<string>("save_upload", { name, data }),
  pathKinds: (paths: string[]) => invoke<PathKind[]>("path_kinds", { paths }),
  peekPendingFocus: () => invoke<FocusTarget | null>("peek_pending_focus"),
  takePendingFocus: () => invoke<FocusTarget | null>("take_pending_focus"),
  openPath: (path: string) => invoke<void>("open_path", { path }),
  readTextFile: (path: string, near?: { base: string; rel: string }) =>
    invoke<TextFile>("read_text_file", { path, base: near?.base ?? null, rel: near?.rel ?? null }),
  openUrl: (url: string) => invoke<void>("open_url", { url }),
  setDockBadge: (count: number) => invoke<void>("set_dock_badge", { count }),
  setLocale: (locale: string) => invoke<void>("set_locale", { locale }),
  setNotifications: (enabled: boolean) =>
    invoke<void>("set_notifications", { enabled }),
  setLeadOnlyNotify: (enabled: boolean) =>
    invoke<void>("set_lead_only_notify", { enabled }),
  /** The window's fonts and text size, for a paired phone to read. */
  setDisplayPrefs: (prefs: DisplayPrefs) => invoke<void>("set_display_prefs", { prefs }),
  getDisplayPrefs: () => invoke<DisplayPrefs>("get_display_prefs"),
  /** Empty clears it, so bots go back to "the user". */
  setUserName: (name: string) => invoke<void>("set_user_name", { name }),
  /** Installed Nerd Fonts. Each entry is the `local()` names of one family. */
  listNerdFonts: () => invoke<string[][]>("list_nerd_fonts"),
  setEscapeLayer: (open: boolean) => invoke<void>("set_escape_layer", { open }),
  remoteProbe: (url: string) => invoke<RemoteServer>("remote_probe", { url }),
  /** The new local representative bot's id. */
  remoteJoin: (args: {
    url: string;
    alias: string;
    name: string;
    invite: string | null;
    cli: string;
    avatar: string | null;
    avatarShape: string | null;
    avatarColor: string | null;
    role: string | null;
  }) => invoke<string>("remote_join", args),
  remoteList: () => invoke<RemoteInfo[]>("remote_list"),
  /** Null leaves that list as it is. Trusted and blocked are account ids. */
  remoteSet: (args: {
    alias: string;
    trusted: string[] | null;
    blocked: string[] | null;
  }) => invoke<void>("remote_set", args),
  remoteLeave: (alias: string) => invoke<void>("remote_leave", { alias }),
  getTeamMemory: (alias: string) => invoke<TeamMemory>("team_memory_get", { alias }),
  /** False when a teammate changed it after `version` was read. */
  setTeamMemory: (alias: string, text: string, version: number) =>
    invoke<boolean>("team_memory_set", { alias, text, version }),
  /** Mobile access: on or off, its addresses and paired devices. */
  mobileStatus: () => invoke<MobileStatus>("mobile_status"),
  mobileSet: (enabled: boolean) => invoke<MobileStatus>("mobile_set", { enabled }),
  /** A new pairing code, good for a few minutes, with its QR code. */
  mobilePair: () => invoke<MobilePair>("mobile_pair"),
  mobileRevoke: (id: string) => invoke<MobileStatus>("mobile_revoke", { id }),
  /** Crew's templates, then the user's. */
  listTemplates: () => invoke<Template[]>("list_templates"),
  /** Returns it as saved: a new one comes back with its id. */
  saveTemplate: (template: Template) => invoke<Template>("save_template", { template }),
  removeTemplate: (id: string) => invoke<void>("remove_template", { id }),
  /** The default AI and the ones a turn falls back to. Null until first saved. */
  getFallbackAis: () => invoke<unknown>("get_fallback_ais"),
  setFallbackAis: (list: { cli: string; model: string; effort: string; cmd: string }[]) =>
    invoke<void>("set_fallback_ais", { list }),
  listModels: (cli: string) => {
    let pending = modelLists.get(cli);
    if (!pending) {
      pending = invoke<ModelList>("list_models", { cli }).then(
        (list) => {
          // Ask again next time: the CLI may be installed while the app runs.
          if (!list.installed) modelLists.delete(cli);
          return list;
        },
        (err) => {
          modelLists.delete(cli);
          throw err;
        },
      );
      modelLists.set(cli, pending);
    }
    return pending;
  },
};
