export type AgentStatus = "working" | "idle" | "blocked" | "exited";
export type Effort = "low" | "medium" | "high";
export type Role = "user" | "assistant" | "system";
export type Kind = "agent";
export type PaneTab = "info" | "routines" | "memory";
/** How saving an edit to a waiting message ended. "gone": it went out first. */
export type EditResult = "saved" | "gone" | "failed";
export type CtxKind = Kind | "group" | "create";
export type ConfirmKind = "reset" | "remove" | "remove-group" | "remove-project";

export type Group = {
  id: string;
  name: string;
  collapsed: boolean;
  items: string[];
  /** Folder this project is bound to. Ordinary groups leave it unset. */
  path?: string;
};
export type CliKind =
  | "grok"
  | "claude"
  | "codex"
  | "agy"
  | "gemini"
  | "copilot"
  | "opencode"
  | "custom";

export type ModelList = {
  models: string[];
  default?: string | null;
  installed: boolean;
};

export type Routine = {
  id: string;
  name: string;
  prompt: string;
  schedule: string;
  enabled: boolean;
  last_run?: string | null;
};

export type Skill = {
  name: string;
  body: string;
};

export type SavedSkill =
  | { kind: "saved"; skill: Skill }
  | { kind: "exists"; name: string };

export type SearchHit = {
  kind: "bot" | "routine" | "message" | "tool" | string;
  id: string;
  title: string;
  snippet: string;
};

export type FocusTarget = {
  kind: string;
  id: string;
  body: string;
  event?: string;
  name?: string;
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
  last_ts?: number;
  /** Unknown command that chats. A terminal stub leaves this unset. */
  headless?: boolean;
};

export type MessageKind = "sent" | "received" | "routine" | "handoff" | "tool";
export type ApprovalState = "pending" | "allowed" | "denied";
export type ChoiceState = "pending" | "answered" | "closed";

export type ChoiceOption = {
  id: string;
  label: string;
  description?: string | null;
};

export type ChoiceField = {
  id: string;
  label: string;
  value?: string;
  secret?: boolean;
  required?: boolean;
};

export type ChoiceQuestion = {
  question: string;
  header?: string | null;
  hint?: string | null;
  options: ChoiceOption[];
  fields?: ChoiceField[];
  multi?: boolean;
  selected?: string[];
  /** The user's own answer, typed into the "other" row. */
  other?: string;
};

export type ChoiceCard = {
  id: string;
  questions: ChoiceQuestion[];
  state: ChoiceState;
};

export type ChatMessage = {
  id: string;
  role: Role;
  from: string;
  text: string;
  ts: number;
  queued?: boolean;
  /** Window-only. The daemon has not accepted this send, so it is not a bubble. */
  optimistic?: boolean;
  /** The bot that asked for the turn this row came from: it belongs beside the thread, with that bot. */
  peer?: string | null;
  kind?: MessageKind | null;
  approval?: ApprovalState | null;
  choice?: ChoiceCard | null;
  /** Sent receipt of a user's @mention. A side chat leaves that sentence where it was typed. */
  mention?: boolean;
};

export type PendingAvatar = {
  data: string;
  name: string;
};
