// Dev-only page for the README screens: `npm run dev`, then open
// /readme.html. The real App runs on made-up bots, so a screenshot shows the
// app as it is. Production builds only bundle index.html, so this never ships.
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { AgentInfo, ChatMessage, Group, PlanUsage, RemoteInfo, RemoteServer } from "./types";

const MIN = 60_000;
const now = Date.now();
const at = (minAgo: number) => now - minAgo * MIN;
const hour = 3600;

const agents: AgentInfo[] = [
  {
    id: "impl", name: "구현", status: "idle", cmd: ["grok", "--always-approve"],
    cwd: "~/Projects/crew", model: "grok-4", avatar_shape: "square", avatar_color: "#4f8cff",
    routines: [], preview: "머지할까요?", last_ts: at(1),
  },
  {
    id: "review", name: "리뷰어", status: "working", cmd: ["claude", "--dangerously-skip-permissions"],
    cwd: "~/Projects/crew", model: "opus", avatar_shape: "teardrop", avatar_color: "#3fbf7f",
    routines: [], preview: "포커스만 검색창으로 옮겨 주세요.", last_ts: at(2),
  },
  {
    id: "design", name: "디자이너", status: "idle", cmd: ["agy", "--dangerously-skip-permissions"],
    cwd: "~/Projects/crew", avatar_shape: "cloud", avatar_color: "#a57bff",
    routines: [], preview: "접힌 레일 폭은 72px로 갈게요.", last_ts: at(25),
  },
  {
    id: "brief", name: "브리핑", status: "idle", cmd: ["codex", "--yolo"],
    cwd: "~/Notes", avatar_shape: "hexagon", avatar_color: "#f2b33d",
    routines: [
      { id: "r1", name: "아침 브리핑", prompt: "오늘 일정과 할 일을 정리해 줘", schedule: "0 8 * * 1-5", enabled: true, last_run: new Date(at(180)).toISOString() },
      { id: "r2", name: "주간 회고", prompt: "이번 주 머지된 PR을 모아 회고 초안을 써 줘", schedule: "0 18 * * 5", enabled: true },
      { id: "r3", name: "의존성 점검", prompt: "업데이트가 필요한 의존성을 확인해 줘", schedule: "0 10 1 * *", enabled: false },
    ],
    preview: "오늘 회의 2개, 리뷰 대기 PR 3개예요.", last_ts: at(180),
  },
  {
    id: "infra", name: "서버", status: "blocked", cmd: ["codex", "--yolo"],
    cwd: "~/Projects/infra", avatar_shape: "triangle", avatar_color: "#ff6a5a",
    routines: [], preview: "배포 스크립트를 실행해도 될까요?", last_ts: at(40),
  },
];

const groups: Group[] = [
  { id: "g-crew", name: "Crew", collapsed: false, items: ["agent:impl", "agent:review", "agent:design"], path: "~/Projects/crew" },
  { id: "__ungrouped", name: "", collapsed: false, items: ["agent:brief", "agent:infra"] },
];

const thread: Record<string, ChatMessage[]> = {
  impl: [
    { id: "m1", role: "user", from: "user", ts: at(14), text: "사이드바를 얼굴만 남게 접는 기능 만들어 줘. 끝나면 @review 에게 리뷰 받아줘." },
    { id: "m3", role: "assistant", from: "impl", ts: at(9), text: "접힌 상태는 다시 열어도 남고, ⌘K나 →로 원래 폭에 펼쳐져요. 테스트 6개를 더했어요." },
    { id: "m4", role: "system", from: "to:review", kind: "sent", ts: at(8), text: "사이드바 접기 올렸어요. 폭 계산이랑 키보드로 펼치는 부분 봐 주세요. @review" },
    { id: "m5", role: "system", from: "review", kind: "handoff", ts: at(3), text: "폭 계산은 좋아요. → 키로 펼칠 때 포커스만 검색창으로 옮겨 주세요." },
    { id: "m6", role: "assistant", from: "impl", ts: at(2), text: "리뷰 반영했어요. `→`로 펼치면 검색창에 포커스가 가요." },
    {
      id: "m7", role: "assistant", from: "ask-1", ts: at(1), text: "",
      choice: {
        id: "ask-1:q", state: "pending",
        questions: [{
          question: "PR을 머지할까요?",
          options: [
            { id: "merge", label: "머지" },
            { id: "wait", label: "디자이너 확인 후 머지" },
            { id: "hold", label: "보류" },
          ],
        }],
      },
    },
  ],
};

thread.review = [
  { id: "r1", role: "system", from: "impl", kind: "received", ts: at(8), text: "[crew from:impl]\n사이드바 접기 올렸어요. 폭 계산이랑 키보드로 펼치는 부분 봐 주세요." },
  { id: "r2", role: "assistant", from: "review", ts: at(5), text: "Sidebar.tsx와 rail.ts를 읽어 볼게요." },
  { id: "r3", role: "assistant", from: "review", ts: at(3), text: "폭 계산은 좋아요. → 키로 펼칠 때 포커스만 검색창으로 옮겨 주세요." },
];
thread.brief = [
  { id: "b1", role: "user", from: "user", ts: at(60 * 24), text: "평일 아침 8시에 오늘 일정이랑 할 일 브리핑해 줘." },
  { id: "b2", role: "assistant", from: "brief", ts: at(60 * 24 - 1), text: "‘아침 브리핑’ 루틴을 만들었어요. 평일 08:00에 실행돼요." },
  { id: "b3", role: "system", from: "아침 브리핑", kind: "routine", ts: at(180), text: "오늘 일정과 할 일을 정리해 줘" },
  { id: "b4", role: "assistant", from: "brief", ts: at(179), text: "오늘 회의 2개, 리뷰 대기 PR 3개예요.\n\n- 10:00 디자인 리뷰\n- 15:00 릴리즈 점검" },
];

const usage: PlanUsage[] = [
  { cli: "claude", fiveHour: { usedPercent: 42, resetsAt: now / 1000 + 2 * hour }, weekly: { usedPercent: 63, resetsAt: now / 1000 + 3 * 24 * hour }, capturedAt: now / 1000 - 60 },
  { cli: "grok", weekly: { usedPercent: 84, resetsAt: now / 1000 + 2 * 24 * hour }, capturedAt: now / 1000 - 300 },
  { cli: "codex", fiveHour: { usedPercent: 18, resetsAt: now / 1000 + 4 * hour }, weekly: { usedPercent: 31, resetsAt: now / 1000 + 5 * 24 * hour }, capturedAt: now / 1000 - 600 },
];

const params = new URLSearchParams(location.search);
const shot = params.get("shot") ?? "window";

// `?shot=remote…`: one router with three teammates, and this PC's
// representative bot. The other shots leave them out.
const remoteShot = shot.startsWith("remote");
const remotes: RemoteInfo[] = [];
if (remoteShot) {
  agents.push(
    {
      id: "rep", name: "이안", status: "idle", cmd: ["claude"], cwd: "~", avatar_shape: "flower",
      avatar_color: "#3fbf7f", routines: [], preview: "민지 님 요청은 리뷰어에게 맡겼어요.", last_ts: at(4),
    },
    {
      id: "acme/acc_k3j9x0", name: "민지", status: "working", cmd: [], cwd: "", remote: "acme", remote_online: true,
      avatar_shape: "cloud", avatar_color: "#ff8a3d", role: "백엔드", routines: [], preview: "스키마 바꾸는 중이에요.", last_ts: at(3),
    },
    {
      id: "acme/acc_p2m8q1", name: "준", status: "idle", cmd: [], cwd: "", remote: "acme", remote_online: false,
      avatar_shape: "hexagon", avatar_color: "#5ac8fa", role: "디자인", routines: [], preview: "내일 시안 올릴게요.", last_ts: at(60 * 20),
    },
    {
      id: "acme/acc_r4t6w2", name: "소라", status: "working", cmd: [], cwd: "", remote: "acme", remote_online: true,
      asking: true, avatar_shape: "square", avatar_color: "#a57bff", routines: [], preview: "주인 확인 기다리는 중", last_ts: at(12),
    },
  );
  // `&folder=1` puts the representative in the Crew folder, whose bots it hands work to.
  groups[params.get("folder") === "1" ? 0 : 1].items.unshift("agent:rep");
  remotes.push({
    alias: "acme", url: "wss://router.acme.dev:7420", name: "ian", bot: "rep", connected: true,
    members: [],
    trusted: [{ account: "acc_k3j9x0", name: "민지" }],
    blocked: [{ account: "acc_zz01", name: "spam-bot" }],
  });
  // Settings with a second router, away, and its own representative.
  if (shot === "remote-settings") {
    agents.push({
      id: "rep-lab", name: "랩 대표", status: "idle", cmd: ["codex"], cwd: "~", avatar_shape: "square",
      avatar_color: "#5ac8fa", routines: [],
    });
    groups[1].items.push("agent:rep-lab");
    remotes.push({
      alias: "lab", url: "ws://10.0.0.7:7420", name: "ian-lab", bot: "rep-lab", connected: false,
      members: [], trusted: [], blocked: [],
    });
  }
  // `?shot=remote-handon`: the representative, outside a folder, wants to hand
  // 민지's work on, and the owner picks the bot.
  thread.rep = [
    { id: "h1", role: "system", from: "acme/acc_k3j9x0", kind: "received", ts: at(5), text: "주문 API에 `discount` 필드 넣고, 화면 문구도 같이 봐 주세요." },
    { id: "h2", role: "assistant", from: "rep", ts: at(4), text: "구현 봇에게 맡겨 볼게요." },
    {
      id: "h3", role: "assistant", from: "rep", ts: at(4), text: "",
      choice: {
        id: "h3:q", state: "pending",
        questions: [{
          question: "이안이(가) 팀원이 맡긴 일을 이 PC의 봇에게 넘기려 해요. 어느 봇에게 맡길까요?",
          hint: "주문 API에 discount 필드를 넣고 마이그레이션까지 만들어 주세요. 화면 문구는 @design 에게 확인",
          options: [
            { id: "A", label: "구현" },
            { id: "B", label: "디자이너" },
            { id: "C", label: "리뷰어" },
            { id: "D", label: "맡기지 않기" },
          ],
        }],
      },
    },
  ];
  thread["acme/acc_k3j9x0"] = [
    { id: "x1", role: "user", from: "user", ts: at(9), text: "주문 API에 `discount` 필드 넣을 수 있을까요? 금요일 배포 전에요." },
    { id: "x2", role: "assistant", from: "acme/acc_k3j9x0", ts: at(6), text: "네, 스키마에 넣고 마이그레이션까지 만들게요. 끝나면 PR 링크 드릴게요." },
    { id: "x3", role: "assistant", from: "acme/acc_k3j9x0", ts: at(3), text: "마이그레이션 쓰는 중이에요. @acme/acc_p2m8q1 에게 화면 문구도 물어볼게요." },
  ];
}
const probe: RemoteServer = {
  url: "wss://router.acme.dev:7420", name: "crew-router", version: "0.1.0", protocol: 1, title: "Acme Team", signup: "invite",
};
// The App opens the first bot in the list.
const first =
  shot === "routines" ? "brief" : shot === "remote-handon" ? "rep" : remoteShot ? "acme/acc_k3j9x0" : "impl";
agents.sort((a, b) => (a.id === first ? -1 : b.id === first ? 1 : 0));

localStorage.clear();
localStorage.setItem("crew.theme", "dark");
// Only the reviewer and the server bot wait to be read.
localStorage.setItem("crew.read", JSON.stringify({ "agent:design": now, "agent:brief": now, "agent:impl": now }));
localStorage.setItem("crew.locale", "ko");
if (remoteShot) localStorage.setItem("crew.last-chat", first);

mockWindows("main");
mockIPC(
  (cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    switch (cmd) {
      case "list_agents": return agents;
      case "list_groups": return groups;
      case "get_messages": return thread[String(a.agent)] ?? [];
      case "plan_usage": return usage;
      case "list_skills": return [];
      case "list_models": {
        const models: Record<string, string[]> = {
          grok: ["grok-4", "grok-4-fast"], claude: ["opus", "sonnet"], codex: ["gpt-5.5", "gpt-5.5-mini"],
        };
        const list = models[String(a.cli)] ?? [];
        return { models: list, default: list[0] ?? null, installed: true };
      }
      case "get_memory": return "";
      case "get_shared_memory": return "";
      case "get_group_memory": return "";
      case "peek_pending_focus":
      case "take_pending_focus": return null;
      case "search_crew": return [];
      case "remote_list": return remotes;
      case "remote_probe": return probe;
      case "remote_join": return "rep";
      case "team_memory_get": return { text: "- 금요일 오후에는 배포하지 않아요\n- API 스펙: docs/api.md", version: 4 };
      case "team_memory_set": return true;
      case "plugin:app|version": return "0.4.1";
      case "plugin:updater|check": return null;
      default: return null;
    }
  },
  { shouldMockEvents: true },
);

await import("./main");

function key(k: string, shift = false) {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: k, metaKey: true, shiftKey: shift, bubbles: true }));
}

function when(find: () => HTMLElement | null, then: (el: HTMLElement) => void) {
  const tick = () => {
    const el = find();
    if (el) then(el);
    else setTimeout(tick, 50);
  };
  tick();
}

when(
  () => document.querySelector<HTMLElement>(".composer, textarea"),
  () => {
    if (shot === "window") when(() => document.querySelector<HTMLElement>(".note-run-head"), (el) => el.click());
    if (shot === "new-bot") key("n");
    if (shot === "routines") key("R", true);
    if (shot === "remote-add" || shot === "remote-join") {
      document.querySelector<HTMLElement>(".search-row .icon-btn:last-child")?.click();
      when(
        () => [...document.querySelectorAll<HTMLElement>(".ctx.open button")].find((b) => b.textContent === "원격 봇 추가") ?? null,
        (el) => {
          el.click();
          if (shot !== "remote-join") return;
          when(() => document.querySelector<HTMLInputElement>("#remote-address"), (input) => {
            const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
            set?.call(input, "router.acme.dev");
            input.dispatchEvent(new Event("input", { bubbles: true }));
            when(
              () => [...document.querySelectorAll<HTMLElement>(".modal.open .primary")].find((b) => b.textContent === "확인") ?? null,
              (ok) => ok.click(),
            );
          });
        },
      );
    }
    if (shot === "remote-settings") {
      key(",");
      when(() => document.querySelector<HTMLElement>('[data-section="remote"]'), (el) => {
        el.click();
        // `&open=acme` unfolds that router's card.
        const open = params.get("open");
        if (open) {
          when(
            () => document.querySelector<HTMLElement>(`.remote-card[aria-label="${open}"] .remote-card-head`),
            (head) => head.click(),
          );
        }
        // `#end` shows the bottom of the page: the team memo and Leave.
        if (location.hash !== "#end") return;
        setTimeout(() => document.querySelector(".settings-body")?.scrollTo(0, 9999), 300);
      });
    }
  },
);
