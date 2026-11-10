import type { ThreadRow } from "./tools";
import type { ChatMessage } from "./types";

export type AskJump = "up" | "down";

/** Which jump buttons the thread wants, before the entrance plays. */
export type JumpMode = "none" | "down" | "ask" | "both";

export function jumpMode(away: boolean, asking: boolean): JumpMode {
  if (away && asking) return "both";
  if (away) return "down";
  if (asking) return "ask";
  return "none";
}

/** Slide, then the new button. The new one starts 80ms before the slide ends. */
export const JUMP_SLIDE_MS = 280;
export const JUMP_RISE_MS = 220;
export const JUMP_ASK_LAG_MS = JUMP_SLIDE_MS - 80;

export type JumpSlot = "alone" | "pair";

export type JumpFrame = {
  at: number;
  downOn: boolean;
  askOn: boolean;
  down: JumpSlot;
  ask: JumpSlot;
};

function jumpEnd(mode: JumpMode): JumpFrame {
  const pair = mode === "both";
  return {
    at: 0,
    downOn: mode === "down" || pair,
    askOn: mode === "ask" || pair,
    down: pair ? "pair" : "alone",
    ask: pair ? "pair" : "alone",
  };
}

/**
 * Frames for a change of jump buttons. A button that is already showing
 * slides to its new seat first. The button that is joining fades up just
 * before that slide finishes. A button that is leaving fades before the
 * one that stays recenters.
 */
export function jumpFrames(from: JumpMode, to: JumpMode, reduce = false): JumpFrame[] {
  if (from === to || reduce) return [jumpEnd(to)];
  if ((from === "down" || from === "ask") && to === "both") {
    const lead = from === "down";
    return [
      { at: 0, downOn: lead, askOn: !lead, down: "pair", ask: "pair" },
      { at: JUMP_ASK_LAG_MS, downOn: true, askOn: true, down: "pair", ask: "pair" },
    ];
  }
  if (from === "both" && to === "none") {
    return [{ at: 0, downOn: false, askOn: false, down: "pair", ask: "pair" }];
  }
  if (from === "both" && (to === "down" || to === "ask")) {
    return [
      {
        at: 0,
        downOn: to === "down",
        askOn: to === "ask",
        down: "pair",
        ask: "pair",
      },
      {
        at: JUMP_RISE_MS,
        downOn: to === "down",
        askOn: to === "ask",
        down: "alone",
        ask: "alone",
      },
    ];
  }
  return [jumpEnd(to)];
}

/** Questions in this chat still waiting for the user, oldest first. */
export function openQuestionIds(messages: readonly ChatMessage[]): string[] {
  return messages.filter((m) => m.choice?.state === "pending").map((m) => m.id);
}

/** Where the keys go in an open question card: its first answer control in view. */
export const QUESTION_FOCUS =
  ".choice-fields .mention-field[contenteditable='true'], .choice-option:not([disabled]), .choice-other-input[contenteditable='true']";

export function questionFocusTarget(card: ParentNode): HTMLElement | null {
  for (const el of card.querySelectorAll<HTMLElement>(QUESTION_FOCUS)) {
    // A stacked card holds the questions behind the front one inert.
    if (!el.closest("[inert]")) return el;
  }
  return null;
}

/** The latest question card still waiting on the user. */
export function pendingQuestionId(rows: readonly ThreadRow[]): string | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row.kind === "msg" && row.msg.choice?.state === "pending") return row.msg.id;
  }
  return null;
}

/**
 * Where that question sits relative to the thread.
 * A measured card uses its top inside the viewport. A row that has not
 * mounted yet uses the row's offset, and a row already crossing the
 * viewport waits until the card itself is measured.
 * `null` means the question head is already on screen.
 */
export function questionJumpDir(input: {
  viewHeight: number;
  cardOffsetTop: number | null;
  rowTop: number;
  rowBottom: number;
}): AskJump | null {
  const { viewHeight, cardOffsetTop, rowTop, rowBottom } = input;
  if (viewHeight < 8) return null;
  if (cardOffsetTop !== null) {
    if (cardOffsetTop >= -8 && cardOffsetTop <= viewHeight - 24) return null;
    return cardOffsetTop < 0 ? "up" : "down";
  }
  if (rowBottom <= 8) return "up";
  if (rowTop >= viewHeight - 8) return "down";
  return null;
}
