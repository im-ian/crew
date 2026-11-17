/** One stall of a bot that was mid-task. Built from the transcript, not a model. */
export type IdleState = "cut" | "wait" | "quiet";

export type IdleCard = {
  id: string;
  /** The message the stall follows. The bubble sits after the row that holds it. */
  afterId: string;
  activityTs: number;
  /** Whole minutes of a finished stall. A live bubble recomputes from now. */
  minutes: number;
  /** Still quiet. The minutes in `body` keep moving. A finished stall freezes them. */
  live: boolean;
  state: IdleState;
  /** Spoken markdown: a few sentences, then a short list only when one is needed. */
  body: string;
};
