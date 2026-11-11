export type AgentStatus = "working" | "idle" | "blocked" | "exited";
export type Effort = "low" | "medium" | "high";
export type Role = "user" | "assistant" | "system";
export type Kind = "agent";
export type PaneTab = "info" | "routines";
/** How saving an edit to a waiting message ended. "gone": it went out first. */
export type EditResult = "saved" | "gone" | "failed";
export type CtxKind = Kind | "group" | "create";
export type ConfirmKind = "reset" | "remove" | "remove-group" | "leave-remote";

export type Group = {
  id: string;
  name: string;
  collapsed: boolean;
  items: string[];
  /** Working folder for the group's bots. A group need not have one. */
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
  /** The bot the hit is in. */
  bot?: string;
  /** When a message was written; 0 for a routine. */
  ts?: number;
};

export type FocusTarget = {
  kind: string;
  id: string;
  body: string;
  event?: string;
  name?: string;
};

/** One limit window. `resetsAt` is Unix seconds. */
export type PlanWindow = { usedPercent: number; resetsAt?: number | null };

/** How much of a CLI's plan is used. A window it does not have right now is null. */
export type PlanUsage = {
  cli: string;
  fiveHour?: PlanWindow | null;
  weekly?: PlanWindow | null;
  capturedAt?: number | null;
  /** Separate pools inside one plan, each with its own weekly window. */
  groups?: { name: string; window: PlanWindow }[];
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
  /** The last turn ended in an error with nothing said. Clears when the next turn starts. */
  failed?: boolean;
  /** A question card is open and waiting for the user. */
  asking?: boolean;
  /** Alias of the router a teammate's bot is on. Set only for remote bots. */
  remote?: string;
  /** The teammate's PC is connected to the router. */
  remote_online?: boolean;
  /** It answered, and its CLI is up only for this background work, such as a CI watch. */
  watch?: Watch[];
};

/** One task a bot left running after it answered. */
export type Watch = {
  /** The task's own description. */
  what: string;
  /** When it started, in ms since the epoch. */
  since: number;
};

export type SignupMode = "open" | "invite" | "closed";

/** What a router says about itself before anyone signs up. */
export type RemoteServer = {
  url: string;
  name: string;
  version: string;
  protocol: number;
  title: string;
  signup: SignupMode;
};

/** A teammate's representative bot on a router. */
export type RemoteMember = {
  account: string;
  name: string;
  role?: string | null;
  avatar?: string | null;
  avatar_shape?: string | null;
  avatar_color?: string | null;
  online: boolean;
  status: "idle" | "working" | "asking";
};

/** A teammate, by router account. The name is only for showing. */
export type RemoteAccount = { account: string; name: string };

/** One router this PC is signed up to. */
export type RemoteInfo = {
  alias: string;
  url: string;
  /** My representative bot's name on the router. */
  name: string;
  /** Id of my local representative bot. */
  bot: string;
  connected: boolean;
  members: RemoteMember[];
  trusted: RemoteAccount[];
  blocked: RemoteAccount[];
  /** Why this PC stopped trying to connect: same account elsewhere, or removed. */
  error?: string | null;
};

export type TeamMemory = { text: string; version: number };

/** What the add-remote dialog hands back: the sign-up and the bot's AI. */
export type RemoteJoin = {
  url: string;
  alias: string;
  name: string;
  invite: string | null;
  role: string | null;
  cli: CliKind;
  model: string;
  effort: string;
  cmd: string;
  shape: string | null;
  color: string | null;
};

export type MessageKind =
  | "sent"
  | "received"
  | "routine"
  | "handoff"
  | "tool"
  | "compact";
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
  /** Window-only. The daemon has not accepted this send yet; it is drawn as sending. */
  optimistic?: boolean;
  /** The bot that asked for the turn this row came from: it belongs beside the thread, with that bot. */
  peer?: string | null;
  kind?: MessageKind | null;
  approval?: ApprovalState | null;
  choice?: ChoiceCard | null;
  /** Sent receipt of a user's @mention. A side chat leaves that sentence where it was typed. */
  mention?: boolean;
  /** A question card's answer, sent on as the user's line. The card shows it, so the thread does not. */
  answer?: boolean;
};

export type PendingAvatar = {
  data: string;
  name: string;
};
