// Dev-only page for the README screens: `npm run dev`, then open
// /readme.html. The real App runs on made-up bots, so a screenshot shows the
// app as it is. Production builds only bundle index.html, so this never ships.
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { AgentInfo, ChatMessage, Group, PlanUsage } from "./types";

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

const shot = new URLSearchParams(location.search).get("shot") ?? "window";
// The App opens the first bot in the list.
const first = shot === "routines" ? "brief" : "impl";
agents.sort((a, b) => (a.id === first ? -1 : b.id === first ? 1 : 0));

localStorage.clear();
localStorage.setItem("crew.theme", "dark");
// Only the reviewer and the server bot wait to be read.
localStorage.setItem("crew.read", JSON.stringify({ "agent:design": now, "agent:brief": now, "agent:impl": now }));
localStorage.setItem("crew.locale", "ko");

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
  },
);
