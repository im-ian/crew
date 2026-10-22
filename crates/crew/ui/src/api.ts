import { invoke } from "@tauri-apps/api/core";
import type {
  AgentInfo,
  ChatMessage,
  Group,
  ModelList,
  FocusTarget,
  SearchHit,
  Skill,
} from "./types";

const modelLists = new Map<string, Promise<ModelList>>();

export function errMsg(err: unknown): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

export const api = {
  listAgents: () => invoke<AgentInfo[]>("list_agents"),
  sendMessage: (agent: string, text: string) =>
    invoke<void>("send_message", { agent, text }),
  stopAgent: (agent: string) => invoke<void>("stop_agent", { agent }),
  approveAgent: (agent: string, allow: boolean) =>
    invoke<void>("approve_agent", { agent, allow }),
  answerChoice: (args: {
    agent: string;
    messageId: string;
    answers: string[][];
    values?: string[][];
    closed: boolean;
  }) =>
    invoke<void>("answer_choice", {
      agent: args.agent,
      messageId: args.messageId,
      answers: args.answers,
      values: args.values ?? [],
      closed: args.closed,
    }),
  tellMessage: (to: string, text: string, from = "user") =>
    invoke<void>("tell_message", { from, to, text }),
  getMessages: (agent: string) => invoke<ChatMessage[]>("get_messages", { agent }),
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
  setAgentCli: (id: string, cli: string) => invoke<void>("set_agent_cli", { id, cli }),
  addAgent: (args: {
    name: string;
    cli: string;
    model: string | null;
    effort: string | null;
    role: string | null;
    description: string | null;
  }) => invoke<string>("add_agent", args),
  cloneAgent: (id: string, name: string | null = null) =>
    invoke<string>("clone_agent", { id, name }),
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
  getMemory: (agent: string) => invoke<string>("get_memory", { agent }),
  setMemory: (agent: string, text: string, base: string) =>
    invoke<boolean>("set_memory", { agent, text, base }),
  listGroups: () => invoke<Group[]>("list_groups"),
  setGroups: (groups: Group[]) => invoke<void>("set_groups", { groups }),
  searchCrew: (query: string) => invoke<SearchHit[]>("search_crew", { query }),
  listSkills: () => invoke<Skill[]>("list_skills"),
  lookupSkill: (query: string) => invoke<Skill | null>("lookup_skill", { query }),
  saveSkill: (name: string, body: string) =>
    invoke<Skill>("save_skill", { name, body }),
  removeSkill: (name: string) => invoke<void>("remove_skill", { name }),
  saveUpload: (name: string, data: string) =>
    invoke<string>("save_upload", { name, data }),
  peekPendingFocus: () => invoke<FocusTarget | null>("peek_pending_focus"),
  takePendingFocus: () => invoke<FocusTarget | null>("take_pending_focus"),
  openPath: (path: string) => invoke<void>("open_path", { path }),
  openUrl: (url: string) => invoke<void>("open_url", { url }),
  setDockBadge: (count: number) => invoke<void>("set_dock_badge", { count }),
  setLocale: (locale: string) => invoke<void>("set_locale", { locale }),
  setNotifications: (enabled: boolean) =>
    invoke<void>("set_notifications", { enabled }),
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
