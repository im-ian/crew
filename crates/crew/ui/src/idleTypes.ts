/** One stall of a bot that was mid-task. Built from the transcript, not a model. */
export type IdleState = "cut" | "wait" | "quiet";

export type IdleSpan = { t: string; strong?: boolean; code?: boolean };

export type IdleStep = { text: string; stop: boolean };

export type IdleFile = { name: string; path: string };

export type IdlePr = { label: string; href?: string };

export type IdleWait = { name: string; at: number };

export type IdleDetail = {
  task: { who: string; what: string } | null;
  steps: IdleStep[];
  files: IdleFile[];
  prs: IdlePr[];
  /** Cut off, and the turn never mentioned a pull request. */
  prEmpty: boolean;
  waiting: IdleWait[];
};

export type IdleCard = {
  id: string;
  /** The message the stall follows. The card sits after the row that holds it. */
  afterId: string;
  activityTs: number;
  /** Whole minutes of a finished stall. A live card recomputes from now. */
  minutes: number;
  /** Still quiet. A finished stall draws as a pill until it is opened. */
  live: boolean;
  state: IdleState;
  /** One line, and no details control. */
  short: boolean;
  /** The folded pill's last clause. */
  hint: string;
  paragraphs: IdleSpan[][];
  detail: IdleDetail | null;
};
