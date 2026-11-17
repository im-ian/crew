import { describe, expect, it } from "vitest";
import { translate } from "./i18n";
import { idleFrom } from "./idlePref";
import { formatAgo, idleCards, withIdleRows, type IdleFacts } from "./idleSummary";
import { threadRows } from "./tools";
import type { AgentInfo, ChatMessage } from "./types";

const MIN = 60_000;
const T0 = 1_700_000_000_000;

const RESUME = "Crew가 다시 켜지면서 끊긴 작업을 이어서 하도록 다시 보냈어요";
const GAVE_UP = "Crew가 다시 켜질 때마다 끊긴 작업이라 더는 다시 보내지 않아요";

function line(partial: Partial<ChatMessage> & Pick<ChatMessage, "id">): ChatMessage {
  return { role: "assistant", from: "bot", text: "", ts: T0, ...partial };
}

function user(id: string, ts: number, text: string): ChatMessage {
  return line({ id, role: "user", from: "user", ts, text });
}

function tool(
  id: string,
  ts: number,
  from: string,
  args: Record<string, string>,
): ChatMessage {
  return line({ id, role: "assistant", from, kind: "tool", ts, text: JSON.stringify(args) });
}

function bot(over: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: "bot",
    name: "봇",
    status: "working",
    cmd: ["x"],
    cwd: "/tmp",
    routines: [],
    ...over,
  };
}

function facts(over: Partial<IdleFacts> & Pick<IdleFacts, "messages">): IdleFacts {
  return {
    now: T0,
    thresholdMin: 10,
    status: "working",
    agents: [bot(), bot({ id: "designer", name: "디자이너", status: "idle" })],
    lang: "ko",
    ...over,
  };
}

const ko = (key: Parameters<typeof translate>[1], vars?: Parameters<typeof translate>[2]) =>
  translate("ko", key, vars);

describe("idleFrom", () => {
  it("defaults to 10 and refuses anything under 10", () => {
    expect(idleFrom(null)).toBe(10);
    expect(idleFrom("10")).toBe(10);
    expect(idleFrom("5")).toBe(10);
    expect(idleFrom("nope")).toBe(10);
    expect(idleFrom("off")).toBe(0);
    expect(idleFrom("0")).toBe(0);
    expect(idleFrom("30")).toBe(30);
    expect(idleFrom("60")).toBe(60);
  });
});

describe("formatAgo", () => {
  it("counts hours once the stall reaches one", () => {
    expect(formatAgo(14, ko)).toBe("14분째 활동 없음");
    expect(formatAgo(60, ko)).toBe("1시간째 활동 없음");
    expect(formatAgo(72, ko)).toBe("1시간 12분째 활동 없음");
  });
});

describe("idleCards", () => {
  it("hides every card when the setting is off, and a 14 minute stall under a 30 minute setting", () => {
    const messages = [
      user("u", T0, "테스트 돌려"),
      tool("t", T0 + 1000, "Bash", { command: "npm test" }),
    ];
    const now = T0 + 1000 + 14 * MIN;
    expect(idleCards(facts({ messages, now, thresholdMin: 0 }))).toEqual([]);
    expect(idleCards(facts({ messages, now, thresholdMin: 30 }))).toEqual([]);
  });

  it("shows a short quiet card while a working bot sits on one tool", () => {
    const messages = [
      user("u", T0, "테스트 돌려"),
      tool("t", T0 + 1000, "Bash", { command: "npm test" }),
    ];
    const cards = idleCards(facts({ messages, now: T0 + 1000 + 14 * MIN }));
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      afterId: "t",
      live: true,
      state: "quiet",
      minutes: 14,
    });
    expect(cards[0].body).toContain("npm test");
    expect(cards[0].body).toContain("14분째 활동 없음");
    expect(cards[0].body).not.toContain("**");
  });

  it("keeps a read with no answer to one sentence", () => {
    const messages = [
      user("u", T0, "읽어 줘"),
      tool("t", T0 + 1000, "read_file", { file_path: "src/app.ts" }),
    ];
    const cards = idleCards(
      facts({ messages, status: "idle", now: T0 + 1000 + 12 * MIN }),
    );
    expect(cards).toHaveLength(1);
    expect(cards[0].state).toBe("quiet");
    expect(cards[0].body).toContain("`app.ts`");
    expect(cards[0].body).toContain("12분째 활동 없음");
    expect(cards[0].body).not.toContain("**");
  });

  it("does not card a finished answer the user has not come back to", () => {
    const messages = [
      user("u", T0, "해 줘"),
      line({ id: "a", text: "다 했어요", ts: T0 + 1000 }),
    ];
    expect(
      idleCards(facts({ messages, status: "idle", now: T0 + 1000 + 40 * MIN })),
    ).toEqual([]);
  });

  it("does not card two asks when the bot never started", () => {
    const messages = [user("u", T0, "해 줘"), user("u2", T0 + 20 * MIN, "아직?")];
    expect(
      idleCards(facts({ messages, status: "idle", now: T0 + 20 * MIN + 1000 })),
    ).toEqual([]);
  });

  it("leaves the stall in place once the user speaks, and does not keep a live card", () => {
    const toolTs = T0 + 1000;
    const spoken = toolTs + 15 * MIN;
    const messages = [
      user("u", T0, "해 줘"),
      tool("t", toolTs, "Bash", { command: "npm test" }),
      user("u2", spoken, "이어서"),
    ];
    const cards = idleCards(facts({ messages, now: spoken + 1000 }));
    expect(cards).toHaveLength(1);
    expect(cards[0].live).toBe(false);
    expect(cards[0].afterId).toBe("t");
    expect(cards[0].minutes).toBe(15);
    expect(cards[0].body).toContain("15분째 활동 없음");
  });

  it("keeps the older stall and adds a new card when it stalls again", () => {
    const first = T0 + 1000;
    const second = first + 15 * MIN;
    const messages = [
      user("u", T0, "해 줘"),
      tool("a", first, "Bash", { command: "npm test" }),
      tool("b", second, "read_file", { file_path: "src/app.ts" }),
    ];
    const cards = idleCards(facts({ messages, now: second + 16 * MIN }));
    expect(cards.map((card) => [card.afterId, card.live])).toEqual([
      ["a", false],
      ["b", true],
    ]);
  });

  it("names who it is waiting on, and a cut off wins over that", () => {
    const messages = [
      user("u", T0, "물어봐"),
      tool("t", T0 + 1000, "Bash", { command: "crew tell" }),
    ];
    const now = T0 + 1000 + 11 * MIN;
    const waiting = idleCards(facts({ messages, now, waitingOn: ["designer"] }));
    expect(waiting[0].state).toBe("wait");
    expect(waiting[0].body).toContain("디자이너");
    expect(waiting[0].body).toContain("기다리는 중");
    expect(waiting[0].body).not.toContain("**기다리는");

    const cut = idleCards(
      facts({ messages, now, waitingOn: ["designer"], cutOff: true, status: "idle" }),
    );
    expect(cut[0].state).toBe("cut");
    expect(cut[0].body).toContain("데몬 재시작으로 끊김");
    expect(cut[0].body).toContain("끊겼어요");
  });

  it("treats an unresolved restart line as a cut, and work after it as recovered", () => {
    const stalled = (text: string) =>
      idleCards(
        facts({
          messages: [
            user("u", T0, "고쳐 줘"),
            line({ id: "n", role: "system", from: "crew", text, ts: T0 + 1000 }),
          ],
          status: "idle",
          now: T0 + 1000 + 12 * MIN,
        }),
      );
    const resumed = stalled(RESUME);
    expect(resumed).toEqual([]);
    const stillCut = idleCards(
      facts({
        messages: [
          user("u", T0, "고쳐 줘"),
          line({ id: "n", role: "system", from: "crew", text: RESUME, ts: T0 + 1000 }),
        ],
        status: "idle",
        cutOff: true,
        now: T0 + 1000 + 12 * MIN,
      }),
    );
    expect(stillCut[0].state).toBe("cut");
    expect(stillCut[0].body).toContain("데몬이 다시 켜지면서 끊겼어요");

    const gave = stalled(GAVE_UP);
    expect(gave[0].state).toBe("cut");
    expect(gave[0].body).toContain("더는 이어가지 않아요");
    expect(gave[0].body).not.toContain("아직 없음");

    const recovered = idleCards(
      facts({
        messages: [
          user("u", T0, "고쳐 줘"),
          line({ id: "n", role: "system", from: "crew", text: RESUME, ts: T0 + 1000 }),
          tool("t", T0 + 2000, "Bash", { command: "npm test" }),
          tool("t2", T0 + 3000, "read_file", { file_path: "src/app.ts" }),
        ],
        now: T0 + 3000 + 12 * MIN,
      }),
    );
    expect(recovered).toHaveLength(1);
    expect(recovered[0].afterId).toBe("t2");
    expect(recovered[0].state).not.toBe("cut");
  });

  it("reads pull request links and PR numbers, not a bare issue number", () => {
    const messages = [
      user("u", T0, "올려 줘"),
      line({
        id: "a",
        text: "열었어요 https://github.com/im-ian/crew/pull/293 그리고 PR #12. 이슈는 #289.",
        ts: T0 + 1000,
      }),
      tool("t", T0 + 2000, "Bash", { command: "git push" }),
    ];
    const cards = idleCards(facts({ messages, now: T0 + 2000 + 12 * MIN }));
    const prs = cards[0].body.split("**PR**")[1] ?? "";
    expect(prs).toContain("[#293](https://github.com/im-ian/crew/pull/293)");
    expect(prs).toContain("- #12");
    expect(prs).not.toContain("#289");
  });

  it("turns the worktree's dirty paths into file chips", () => {
    const messages = [
      user("u", T0, "고쳐"),
      tool("t1", T0 + 1000, "Bash", { command: "npm test" }),
      tool("t2", T0 + 2000, "read_file", { file_path: "src/app.ts" }),
    ];
    const cards = idleCards(
      facts({
        messages,
        changed: ["src/a.ts", "lib/a.ts", "src/b ts"],
        now: T0 + 2000 + 12 * MIN,
      }),
    );
    expect(cards[0].body).toContain("`src/a.ts`");
    expect(cards[0].body).toContain("`lib/a.ts`");
    expect(cards[0].body).toContain("`b ts`");
    expect(cards[0].body).not.toContain("`a.ts`");
  });

  it("skips a stall the user is holding with an approval, a question, or a blocked bot", () => {
    const messages = [
      user("u", T0, "해 줘"),
      line({ id: "p", text: "허용?", ts: T0 + 1000, approval: "pending" }),
    ];
    const now = T0 + 1000 + 30 * MIN;
    expect(idleCards(facts({ messages, now }))).toEqual([]);

    const working = [
      user("u", T0, "해 줘"),
      tool("t", T0 + 1000, "Bash", { command: "npm test" }),
    ];
    const later = T0 + 1000 + 20 * MIN;
    expect(idleCards(facts({ messages: working, now: later, asking: true }))).toEqual([]);
    expect(idleCards(facts({ messages: working, now: later, status: "blocked" }))).toEqual([]);
    expect(idleCards(facts({ messages: working, now: later, status: "exited" }))).toEqual([]);
  });
});

describe("withIdleRows", () => {
  it("splits a tool run so the card sits on the call it follows", () => {
    const first = T0 + 1000;
    const second = first + 15 * MIN;
    const messages = [
      user("u", T0, "해 줘"),
      tool("a", first, "Bash", { command: "one" }),
      tool("b", second, "Bash", { command: "two" }),
    ];
    const cards = idleCards(facts({ messages, status: "idle", now: second + 1000 }));
    expect(cards).toHaveLength(1);
    const rows = withIdleRows(threadRows(messages, []), cards);
    expect(
      rows.map((row) =>
        row.kind === "idle" ? "idle" : row.kind === "tools" ? row.msgs.map((m) => m.id).join("+") : row.kind,
      ),
    ).toEqual(["msg", "a", "idle", "b"]);
  });

  it("places a card whose anchor is a hidden tool by time", () => {
    const toolTs = T0 + 5 * MIN;
    const saidTs = toolTs + 15 * MIN;
    const messages = [
      user("u", T0, "해 줘"),
      tool("hidden", toolTs, "read_file", { file_path: "src/app.ts" }),
      line({ id: "said", text: "봤어요", ts: saidTs }),
    ];
    const cards = idleCards(facts({ messages, status: "idle", now: saidTs + 1000 }));
    expect(cards.map((card) => card.afterId)).toEqual(["hidden"]);
    const visible = messages.filter((m) => m.kind !== "tool");
    const rows = withIdleRows(threadRows(visible, []), cards);
    expect(
      rows.map((row) => (row.kind === "idle" ? "idle" : row.kind === "msg" ? row.msg.id : row.kind)),
    ).toEqual(["u", "idle", "said"]);
  });
});
