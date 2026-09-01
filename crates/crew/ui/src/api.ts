import { invoke } from "@tauri-apps/api/core";
import type {
  AgentInfo,
  ChannelInfo,
  ChatMessage,
  Group,
  ModelList,
  RoutineRun,
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
  listChannels: () => invoke<ChannelInfo[]>("list_channels"),
  sendMessage: (agent: string, text: string) =>
    invoke<void>("send_message", { agent, text }),
  stopAgent: (agent: string) => invoke<void>("stop_agent", { agent }),
  approveAgent: (agent: string, allow: boolean) =>
    invoke<void>("approve_agent", { agent, allow }),
  tellMessage: (to: string, text: string, from = "user") =>
    invoke<void>("tell_message", { from, to, text }),
  channelSend: (channel: string, text: string) =>
    invoke<void>("channel_send", { channel, text }),
  getMessages: (agent: string) => invoke<ChatMessage[]>("get_messages", { agent }),
  getChannelMessages: (channel: string) =>
    invoke<ChatMessage[]>("get_channel_messages", { channel }),
  daemonPing: () => invoke<boolean>("daemon_ping"),
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
  }) => invoke<void>("set_agent", args),
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
  addChannel: (name: string, members: string[]) =>
    invoke<string>("add_channel", { name, members }),
  setChannel: (args: {
    id: string;
    name?: string | null;
    brief?: string | null;
    unsetBrief?: boolean;
    members?: string[] | null;
  }) =>
    invoke<void>("set_channel", {
      id: args.id,
      name: args.name ?? null,
      brief: args.brief ?? null,
      unsetBrief: args.unsetBrief ?? false,
      members: args.members ?? null,
    }),
  leaveChannel: (channel: string, agent?: string | null) =>
    invoke<void>("leave_channel", { channel, agent: agent ?? null }),
  removeChannel: (channel: string) => invoke<void>("remove_channel", { channel }),
  addRoutine: (agent: string, name: string, schedule: string, prompt: string) =>
    invoke<void>("add_routine", { agent, name, schedule, prompt }),
  removeRoutine: (agent: string, key: string) =>
    invoke<void>("remove_routine", { agent, key }),
  setRoutineEnabled: (agent: string, key: string, enabled: boolean) =>
    invoke<void>("set_routine_enabled", { agent, key, enabled }),
  runRoutine: (agent: string, key: string) =>
    invoke<void>("run_routine", { agent, key }),
  editRoutine: (
    agent: string,
    key: string,
    fields: { name?: string | null; schedule?: string | null; prompt?: string | null },
  ) =>
    invoke<void>("edit_routine", {
      agent,
      key,
      name: fields.name ?? null,
      schedule: fields.schedule ?? null,
      prompt: fields.prompt ?? null,
    }),
  listRoutineRuns: (agent: string, key: string) =>
    invoke<RoutineRun[]>("list_routine_runs", { agent, key }),
  getMemory: (agent: string) => invoke<string>("get_memory", { agent }),
  setMemory: (agent: string, text: string) =>
    invoke<void>("set_memory", { agent, text }),
  listGroups: () => invoke<Group[]>("list_groups"),
  setGroups: (groups: Group[]) => invoke<void>("set_groups", { groups }),
  searchCrew: (query: string) => invoke<SearchHit[]>("search_crew", { query }),
  listSkills: () => invoke<Skill[]>("list_skills"),
  lookupSkill: (query: string) => invoke<Skill | null>("lookup_skill", { query }),
  saveSkill: (name: string, body: string) =>
    invoke<Skill>("save_skill", { name, body }),
  saveUpload: (name: string, data: string) =>
    invoke<string>("save_upload", { name, data }),
  listModels: (cli: string) => {
    let pending = modelLists.get(cli);
    if (!pending) {
      pending = invoke<ModelList>("list_models", { cli }).catch((err) => {
        modelLists.delete(cli);
        throw err;
      });
      modelLists.set(cli, pending);
    }
    return pending;
  },
};
