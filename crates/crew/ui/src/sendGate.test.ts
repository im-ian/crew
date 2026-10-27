import { describe, expect, it } from "vitest";
import type { ChatMessage } from "./types";
import {
  applyStop,
  composerAfterSend,
  heldFor,
  queueActions,
  rollbackSend,
  sendKeptQueued,
  shownInThread,
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

const held: HeldSend = { id: "local-send-1", agent: "bot-a", text: "안녕" };

describe("before the daemon accepts", () => {
  it("does not draw an unaccepted send as a sent bubble", () => {
    const row = withUnaccepted([], [held])[0];
    expect(userLineAppearance(row)).toBe("hold");
    expect(shownInThread(row)).toBe(false);
    expect(queueActions(row)).toEqual({ edit: false, cancel: false });
  });

  it("shows a user line as waiting only while the daemon row is queued", () => {
    const waiting = line({ id: "q", role: "user", text: "안녕", queued: true });
    const accepted = line({ id: "a", role: "user", text: "안녕" });
    expect(userLineAppearance(waiting)).toBe("waiting");
    expect(shownInThread(waiting)).toBe(true);
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
    expect(shownInThread(same[1])).toBe(false);
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
