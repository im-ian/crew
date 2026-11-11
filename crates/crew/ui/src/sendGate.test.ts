import { describe, expect, it } from "vitest";
import type { ChatMessage } from "./types";
import {
  applyStop,
  composerAfterSend,
  heldFor,
  queueActions,
  rollbackSend,
  sendRowId,
  sendKept,
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

const held: HeldSend = { id: "u-100-1-ab", agent: "bot-a", text: "안녕", at: 100 };

describe("before the daemon accepts", () => {
  it("draws an unaccepted send at once, as sending, with nothing to edit", () => {
    const row = withUnaccepted([], [held])[0];
    expect(userLineAppearance(row)).toBe("sending");
    expect(row.text).toBe("안녕");
    expect(row.ts).toBe(100);
    expect(queueActions(row)).toEqual({ edit: false, cancel: false });
  });

  it("lets the daemon row with the send's id take its place, never both", () => {
    const row = line({ id: held.id, role: "user", text: "안녕", ts: 150 });
    expect(withUnaccepted([row], [held])).toEqual([row]);
    const queued = { ...row, queued: true };
    expect(withUnaccepted([queued], [held])).toEqual([queued]);
  });

  it("does not take another line with the same text for the send", () => {
    const other = line({ id: "d1", role: "user", text: "안녕", ts: 150 });
    expect(withUnaccepted([other], [held]).map((m) => m.id)).toEqual(["d1", held.id]);
  });

  it("does not add the sending line twice", () => {
    const once = withUnaccepted([], [held]);
    expect(withUnaccepted(once, [held])).toBe(once);
  });

  it("makes a plain token the daemon will keep as the row id", () => {
    const id = sendRowId(3, 1700000000000, 0.5);
    expect(id).toMatch(/^u-1700000000000-3-[0-9a-z]+$/);
    expect(id.length).toBeLessThanOrEqual(64);
    expect(sendRowId(4, 1)).not.toBe(sendRowId(4, 1));
  });

  it("shows a user line as waiting only while the daemon row is queued", () => {
    const waiting = line({ id: "q", role: "user", text: "안녕", queued: true });
    const accepted = line({ id: "a", role: "user", text: "안녕" });
    expect(userLineAppearance(waiting)).toBe("waiting");
    expect(userLineAppearance(accepted)).toBe("sent");
    expect(userLineAppearance({ ...accepted, queued: false })).toBe("sent");
  });

  it("keeps the draft cleared only when a failed invoke still left this send's row", () => {
    const kept = line({ id: held.id, role: "user", text: "안녕", queued: true });
    expect(sendKept([kept], held.id)).toBe(true);
    // An earlier line with the same text waiting is not this send.
    const earlier = line({ id: "q", role: "user", text: "안녕", queued: true });
    expect(sendKept([earlier], held.id)).toBe(false);
    // The window's own sending line is not the daemon's row.
    expect(sendKept(withUnaccepted([], [held]), held.id)).toBe(false);
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
    expect(same.map((m) => m.id)).toEqual(["old", held.id]);
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
