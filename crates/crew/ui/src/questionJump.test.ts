import { describe, expect, it } from "vitest";
import {
  jumpFrames,
  jumpMode,
  openQuestionIds,
  pendingQuestionId,
  questionJumpDir,
} from "./questionJump";
import type { ThreadRow } from "./tools";
import type { ChatMessage, ChoiceState } from "./types";

function row(id: string, state: ChoiceState | null): ThreadRow {
  const msg: ChatMessage = {
    id,
    role: "assistant",
    from: "bot",
    text: "",
    ts: 1,
    choice: state ? { id: "card-" + id, questions: [], state } : null,
  };
  return { kind: "msg", msg };
}

describe("pendingQuestionId", () => {
  it("uses the latest question that is still waiting", () => {
    const notes: ThreadRow = {
      kind: "notes",
      peerId: "other",
      msgs: [
        {
          id: "note",
          role: "assistant",
          from: "other",
          text: "hi",
          ts: 2,
          choice: { id: "hidden", questions: [], state: "pending" },
        },
      ],
    };
    expect(
      pendingQuestionId([
        row("old", "pending"),
        row("done", "answered"),
        notes,
        row("shut", "closed"),
        row("now", "pending"),
      ]),
    ).toBe("now");
  });

  it("is quiet once every card is settled", () => {
    expect(pendingQuestionId([row("a", "answered"), row("b", null)])).toBeNull();
    expect(pendingQuestionId([row("shut", "closed")])).toBeNull();
  });
});

describe("jumpFrames", () => {
  it("moves the down button left before the question fades up", () => {
    const frames = jumpFrames("down", "both");
    expect(frames).toEqual([
      { at: 0, downOn: true, askOn: false, down: "pair", ask: "pair" },
      { at: 200, downOn: true, askOn: true, down: "pair", ask: "pair" },
    ]);
  });

  it("lets the question fade before the down button returns to the center", () => {
    const frames = jumpFrames("both", "down");
    expect(frames[0]).toMatchObject({ at: 0, downOn: true, askOn: false, down: "pair" });
    expect(frames[1]).toMatchObject({ at: 220, downOn: true, askOn: false, down: "alone" });
  });

  it("drops both at once when the question is closed and the thread is at the bottom", () => {
    expect(jumpMode(false, false)).toBe("none");
    expect(jumpFrames("both", "none")[0]).toMatchObject({
      downOn: false,
      askOn: false,
      down: "pair",
    });
  });

  it("lands on the final seats when motion is reduced", () => {
    expect(jumpFrames("down", "both", true)).toEqual([
      { at: 0, downOn: true, askOn: true, down: "pair", ask: "pair" },
    ]);
  });
});

describe("questionJumpDir", () => {
  it("stays hidden when the question head is on screen", () => {
    expect(
      questionJumpDir({
        viewHeight: 600,
        cardOffsetTop: 40,
        rowTop: 0,
        rowBottom: 0,
      }),
    ).toBeNull();
    expect(
      questionJumpDir({
        viewHeight: 600,
        cardOffsetTop: 560,
        rowTop: 0,
        rowBottom: 0,
      }),
    ).toBeNull();
  });

  it("points up when the question starts above the thread", () => {
    expect(
      questionJumpDir({
        viewHeight: 600,
        cardOffsetTop: -40,
        rowTop: 0,
        rowBottom: 0,
      }),
    ).toBe("up");
  });

  it("points down when only the tail of the viewport could reach it", () => {
    expect(
      questionJumpDir({
        viewHeight: 600,
        cardOffsetTop: 590,
        rowTop: 0,
        rowBottom: 0,
      }),
    ).toBe("down");
  });

  it("uses the row offset until the card is mounted", () => {
    expect(
      questionJumpDir({
        viewHeight: 400,
        cardOffsetTop: null,
        rowTop: -200,
        rowBottom: -20,
      }),
    ).toBe("up");
    expect(
      questionJumpDir({
        viewHeight: 400,
        cardOffsetTop: null,
        rowTop: 420,
        rowBottom: 800,
      }),
    ).toBe("down");
    expect(
      questionJumpDir({
        viewHeight: 400,
        cardOffsetTop: null,
        rowTop: -10,
        rowBottom: 80,
      }),
    ).toBeNull();
  });
});

describe("openQuestionIds", () => {
  it("lists every question still waiting, oldest first", () => {
    const rows = [row("a", "pending"), row("b", "answered"), row("c", null), row("d", "pending"), row("e", "closed")];
    const messages = rows.flatMap((r) => (r.kind === "msg" ? [r.msg] : []));
    expect(openQuestionIds(messages)).toEqual(["a", "d"]);
  });

  it("is empty when nothing waits", () => {
    const messages = [row("a", "answered"), row("b", null)].flatMap((r) => (r.kind === "msg" ? [r.msg] : []));
    expect(openQuestionIds(messages)).toEqual([]);
  });
});
