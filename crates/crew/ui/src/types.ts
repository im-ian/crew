export type AgentStatus = "working" | "idle" | "blocked" | "exited";
export type Effort = "low" | "medium" | "high";
export type Role = "user" | "assistant" | "system";
export type Kind = "agent" | "channel";
export type PaneTab = "info" | "routines" | "memory";
export type CtxKind = Kind | "group" | "create";
export type ConfirmKind =
  | "reset"
  | "remove"
  | "leave-channel"
  | "remove-channel"
  | "remove-group";

export type Group = {
  id: string;
  name: string;
  collapsed: boolean;
  items: string[];
};
export type CliKind = "grok" | "claude" | "codex";

export type ModelList = {
  models: string[];
  default?: string | null;
};

export type Routine = {
  id: string;
  name: string;
  prompt: string;
  schedule: string;
  enabled: boolean;
  last_run?: string | null;
};

export type AgentInfo = {
  id: string;
  name: string;
  status: AgentStatus;
  cmd: string[];
  cwd: string;
  model?: string | null;
  effort?: Effort | null;
  avatar?: string | null;
  avatar_shape?: string | null;
  avatar_color?: string | null;
  title?: string | null;
  description?: string | null;
  role?: string | null;
  routines: Routine[];
  preview?: string | null;
};

export type ChannelInfo = {
  id: string;
  name: string;
  members: string[];
  preview?: string | null;
};

export type MessageKind = "sent" | "received" | "routine" | "handoff";

export type ChatMessage = {
  id: string;
  role: Role;
  from: string;
  text: string;
  ts: number;
  queued?: boolean;
  kind?: MessageKind | null;
};

export type PendingAvatar = {
  data: string;
  name: string;
};
