import { describe, expect, it } from "vitest";
import type { ChatMessage } from "./types";
import {
  applyStop,
  composerAfterSend,
  heldFor,
  queueActions,
  rollbackSend,
  sendKeptQueued,
  stopTurn,
  userLineAppearance,
  withUnaccepted,
  type HeldSend,
} from "./sendGate";

function line(partial: Partial<ChatMessage> & Pick<ChatMessage, "id" | "role">): ChatMessage {
  return {
    from: partial.role === "user" ? "user" : "bot",
    text: "",
    ts: 1,
    ...partial,
  };
}

const held: HeldSend = { id: "local-send-1", agent: "bot-a", text: "안녕", at: 100 };

describe("before the daemon accepts", () => {
  it("draws an unaccepted send at once, as sending, with nothing to edit", () => {
    const row = withUnaccepted([], [held])[0];
    expect(userLineAppearance(row)).toBe("sending");
    expect(row.text).toBe("안녕");
    expect(row.ts).toBe(100);
    expect(queueActions(row)).toEqual({ edit: false, cancel: false });
  });

  it("lets the daemon row take the sending line's place, never both", () => {
    const row = line({ id: "d1", role: "user", text: "안녕", ts: 150 });
    expect(withUnaccepted([row], [held]).map((m) => m.id)).toEqual(["d1"]);
    const queued = { ...row, queued: true };
    expect(withUnaccepted([queued], [held]).map((m) => m.id)).toEqual(["d1"]);
  });

  it("does not take an older line with the same text for the send", () => {
    const earlier = line({ id: "d0", role: "user", text: "안녕", ts: 50 });
    expect(withUnaccepted([earlier], [held]).map((m) => m.id)).toEqual([
      "d0",
      "local-send-1",
    ]);
  });

  it("matches each daemon row to one send when the same text goes twice", () => {
    const again: HeldSend = { ...held, id: "local-send-2", at: 120 };
    const first = line({ id: "d1", role: "user", text: "안녕", ts: 110 });
    expect(withUnaccepted([first], [held, again]).map((m) => m.id)).toEqual([
      "d1",
      "local-send-2",
    ]);
    const second = line({ id: "d2", role: "user", text: "안녕", ts: 130 });
    expect(withUnaccepted([first, second], [held, again]).map((m) => m.id)).toEqual([
      "d1",
      "d2",
    ]);
  });

  it("does not take a card answer or a teammate's line for the send", () => {
    const answer = line({ id: "ans", role: "user", text: "안녕", ts: 150, answer: true });
    const peer = line({ id: "p", role: "user", from: "bot-b", text: "안녕", ts: 150 });
    expect(withUnaccepted([answer, peer], [held]).map((m) => m.id)).toEqual([
      "ans",
      "p",
      "local-send-1",
    ]);
  });

  it("shows a user line as waiting only while the daemon row is queued", () => {
    const waiting = line({ id: "q", role: "user", text: "안녕", queued: true });
    const accepted = line({ id: "a", role: "user", text: "안녕" });
    expect(userLineAppearance(waiting)).toBe("waiting");
    expect(userLineAppearance(accepted)).toBe("sent");
    expect(userLineAppearance({ ...accepted, queued: false })).toBe("sent");
  });

  it("keeps the draft cleared when a failed invoke still left the line waiting", () => {
    const waiting = line({ id: "q", role: "user", text: "안녕", queued: true });
    expect(sendKeptQueued([waiting], "안녕")).toBe(true);
    expect(sendKeptQueued([line({ id: "s", role: "user", text: "안녕" })], "안녕")).toBe(false);
    expect(sendKeptQueued([waiting], "다른 글")).toBe(false);
  });

  it("puts the text back and drops the unaccepted line when send fails", () => {
    const older = line({ id: "old", role: "user", text: "앞서" });
    const pending = withUnaccepted([older], [held]);
    const back = rollbackSend(pending, held.id);
    expect(back.messages).toEqual([older]);
    expect(back.restore).toBe("안녕");
    expect(composerAfterSend(false, "안녕")).toBe("안녕");
    expect(composerAfterSend(true, "안녕")).toBeNull();
  });

  it("keeps an unaccepted send off another chat's snapshot", () => {
    const snapshot = [line({ id: "old", role: "assistant", text: "응" })];
    expect(withUnaccepted(snapshot, heldFor("bot-b", [held]))).toBe(snapshot);
    const same = withUnaccepted(snapshot, heldFor("bot-a", [held]));
    expect(same.map((m) => m.id)).toEqual(["old", "local-send-1"]);
    expect(userLineAppearance(same[1])).toBe("sending");
  });
});

describe("edit and cancel", () => {
  it("opens only on a queued user line", () => {
    expect(queueActions(line({ id: "u", role: "user", queued: true }))).toEqual({
      edit: true,
      cancel: true,
    });
    expect(queueActions(line({ id: "out", role: "user" }))).toEqual({
      edit: false,
      cancel: false,
    });
    expect(queueActions(line({ id: "out", role: "user", queued: false }))).toEqual({
      edit: false,
      cancel: false,
    });
    expect(queueActions(line({ id: "bot", role: "assistant", queued: true }))).toEqual({
      edit: false,
      cancel: false,
    });
    expect(queueActions(line({ id: "sys", role: "system", queued: true }))).toEqual({
      edit: false,
      cancel: false,
    });
  });
});

describe("stop", () => {
  it("does not add a local row", () => {
    const before = [
      line({ id: "u", role: "user", text: "해줘" }),
      line({ id: "a", role: "assistant", text: "하는 중" }),
    ];
    expect(applyStop(before)).toBe(before);
    const calls: string[] = [];
    stopTurn(() => calls.push("stop"));
    expect(calls).toEqual(["stop"]);
    expect(applyStop(before).some((m) => /stop|중지/.test(m.text))).toBe(false);
  });
});
