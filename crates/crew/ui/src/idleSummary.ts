import type { Locale, TFn } from "./i18n";
import { translate } from "./i18n";
import type { IdleCard, IdleDetail, IdleFile, IdlePr, IdleSpan, IdleState, IdleStep } from "./idleTypes";
import { sentTarget } from "./peek";
import { rowTs, toolSummary, type ThreadRow } from "./tools";
import type { AgentInfo, ChatMessage } from "./types";

const MINUTE = 60_000;

/** The lines PR #293 leaves in the chat when a restart cut a turn off. */
const RESUMED = [
  "Crew가 다시 켜지면서 끊긴 작업을 이어서 하도록 다시 보냈어요",
  "Crew restarted during this turn. Sending it again to pick up where it stopped.",
];
const GAVE_UP = [
  "Crew가 다시 켜질 때마다 끊긴 작업이라 더는 다시 보내지 않아요",
  "Crew restarted during this turn several times in a row, so it is not sent again.",
];

export type IdleFacts = {
  messages: readonly ChatMessage[];
  now: number;
  /** `0` hides every card. */
  thresholdMin: number;
  status?: AgentInfo["status"];
  waitingOn?: readonly string[];
  agents: readonly AgentInfo[];
  /** `waits/<id>.json` still has a turn and no CLI is running it. */
  cutOff?: boolean;
  changed?: readonly string[];
  asking?: boolean;
  lang: Locale;
};

/**
 * One card per stall that lasted at least the threshold while a turn was
 * still open. The latest one is live until something happens again; earlier
 * ones stay where the silence was, folded.
 */
export function idleCards(facts: IdleFacts): IdleCard[] {
  const threshold = facts.thresholdMin * MINUTE;
  if (threshold <= 0) return [];
  const messages = facts.messages;
  const activity = messages
    .map((m, index) => ({ m, index }))
    .filter(({ m }) => isActivity(m));
  if (!activity.length) return [];

  const cards: IdleCard[] = [];
  for (let i = 0; i < activity.length - 1; i++) {
    const left = activity[i];
    const right = activity[i + 1];
    const gap = right.m.ts - left.m.ts;
    if (gap < threshold) continue;
    if (!stallAcross(messages, left.index, right.index)) continue;
    const card = buildCard(facts, left.index, gap, false);
    if (card) cards.push(card);
  }
  const last = activity[activity.length - 1];
  const age = facts.now - last.m.ts;
  if (age >= threshold && liveOpen(facts, messages, last.index)) {
    const card = buildCard(facts, last.index, age, true);
    if (card) cards.push(card);
  }
  return cards;
}

/** Whole minutes since `activityTs`. At least one once a card is shown. */
export function stalledMinutes(activityTs: number, now: number): number {
  return Math.max(1, Math.floor((now - activityTs) / MINUTE));
}

/** "14분째 활동 없음", or from an hour "1시간 12분째". Folded pills say "멈춤". */
export function formatAgo(minutes: number, live: boolean, t: TFn): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (live) {
    if (h && m) return t("idle.ago.hm", { h, m });
    if (h) return t("idle.ago.h", { h });
    return t("idle.ago.m", { m: minutes });
  }
  if (h && m) return t("idle.held.hm", { h, m });
  if (h) return t("idle.held.h", { h });
  return t("idle.held.m", { m: minutes });
}

/**
 * Put each card after the message it follows. A tool run is one row, so a
 * stall between two of its calls splits the run. A hidden tool (the tools
 * switch is off) still anchors by time, after the last visible row from
 * before the stall.
 */
export function withIdleRows(rows: readonly ThreadRow[], cards: readonly IdleCard[]): ThreadRow[] {
  if (!cards.length) return rows.slice();
  const waiting = new Map<string, IdleCard[]>();
  for (const card of cards) {
    const list = waiting.get(card.afterId) ?? [];
    list.push(card);
    waiting.set(card.afterId, list);
  }
  const placed = new Set<string>();
  const out: ThreadRow[] = [];
  const drop = (id: string) => {
    const list = waiting.get(id);
    if (!list) return;
    waiting.delete(id);
    for (const card of list) {
      out.push({ kind: "idle", card });
      placed.add(card.id);
    }
  };
  for (const row of rows) {
    if (row.kind === "idle") {
      out.push(row);
      continue;
    }
    if (row.kind === "msg") {
      out.push(row);
      drop(row.msg.id);
      continue;
    }
    let buf: ChatMessage[] = [];
    const flush = () => {
      if (!buf.length) return;
      out.push(copyGroup(row, buf));
      buf = [];
    };
    for (const m of row.msgs) {
      buf.push(m);
      if (waiting.has(m.id)) {
        flush();
        drop(m.id);
      }
    }
    flush();
  }
  for (const card of cards) {
    if (placed.has(card.id)) continue;
    let at = 0;
    for (let i = 0; i < out.length; i++) {
      if (rowTime(out[i]) <= card.activityTs) at = i + 1;
      else break;
    }
    out.splice(at, 0, { kind: "idle", card });
  }
  return out;
}

function rowTime(row: ThreadRow): number {
  return row.kind === "idle" ? row.card.activityTs : rowTs(row);
}

function copyGroup(row: ThreadRow, msgs: ChatMessage[]): ThreadRow {
  if (row.kind === "notes") return { kind: "notes", peerId: row.peerId, msgs };
  if (row.kind === "files") return { kind: "files", msgs };
  if (row.kind === "tools") return { kind: "tools", msgs };
  return row;
}

function buildCard(
  facts: IdleFacts,
  anchor: number,
  gapMs: number,
  live: boolean,
): IdleCard | null {
  const messages = facts.messages;
  const anchorMsg = messages[anchor];
  if (!anchorMsg?.id) return null;
  const start = turnStart(messages, anchor);
  const slice = messages.slice(start, anchor + 1);
  const lang = facts.lang;
  const t = (key: Parameters<TFn>[0], vars?: Parameters<TFn>[1]) =>
    translate(lang, key, vars);
  // The resume line means the turn was sent on again. It is a cut only while
  // the record is still on disk and nothing is running it, or when Crew gave up.
  const gave = noteUnresolved(slice, GAVE_UP);
  const cut = gave || (live && !!facts.cutOff);
  const waiting = waitList(slice, facts, live);
  const state: IdleState = cut ? "cut" : waiting.length ? "wait" : "quiet";
  const said = lastSaid(slice);
  const tools = slice.filter((m) => m.kind === "tool");
  const files = fileChips(facts.changed ?? []);
  const prs = pullRequests(slice);
  const task = taskOf(slice, facts.agents, lang);
  const stop = cut ? t(gave ? "idle.step.gaveup" : "idle.step.cut") : null;
  const steps = stepsFor(tools, said, stop);
  const short =
    state === "quiet" &&
    tools.length <= 1 &&
    !said &&
    files.length === 0 &&
    prs.length === 0;
  const names = waiting.map((w) => w.name);
  const paragraphs = short
    ? shortLines(tools, task?.what ?? "", lang)
    : bodyLines(
        state,
        said,
        names,
        files.length,
        gave,
        lang,
        tools.length ? stepLabel(tools[tools.length - 1]) : "",
      );
  const detail: IdleDetail | null = short
    ? null
    : {
        task,
        steps,
        files,
        prs,
        prEmpty: state === "cut" && prs.length === 0,
        waiting: state === "wait" ? waiting : [],
      };
  return {
    id: `idle-${anchorMsg.id}`,
    afterId: anchorMsg.id,
    activityTs: anchorMsg.ts,
    minutes: Math.max(1, Math.floor(gapMs / MINUTE)),
    live,
    state,
    short,
    hint: hintOf(state, gave, names, paragraphs, t),
    paragraphs,
    detail,
  };
}

function liveOpen(facts: IdleFacts, messages: readonly ChatMessage[], anchor: number): boolean {
  const slice = messages.slice(turnStart(messages, anchor), anchor + 1);
  // A restart that cut the turn off still owes a card, even once the bot is idle.
  if (facts.cutOff) return true;
  if (facts.asking || heldForUser(slice)) return false;
  if (noteUnresolved(slice, GAVE_UP)) return true;
  if ((facts.waitingOn ?? []).length > 0) return true;
  if (facts.status === "exited" || facts.status === "blocked") return false;
  if (facts.status === "working") return true;
  return facts.status === "idle" && unfinished(slice);
}

/** The bot read or edited and never said it was done. */
function unfinished(slice: readonly ChatMessage[]): boolean {
  let said = false;
  let worked = false;
  for (const m of slice) {
    if (m.kind === "tool" || m.kind === "file") {
      worked = true;
      said = false;
    } else if (m.role === "assistant" && strip(m.text || "")) {
      said = true;
    }
  }
  return worked && !said;
}

/**
 * A long gap counts when the bot still owed the turn. A finished answer
 * followed by the user coming back does not: that silence is the user's.
 */
function stallAcross(
  messages: readonly ChatMessage[],
  left: number,
  right: number,
): boolean {
  const a = messages[left];
  const b = messages[right];
  const slice = messages.slice(turnStart(messages, left), left + 1);
  if (heldForUser(slice)) return false;
  if (isAssistantText(a)) {
    if (b.role === "user" || isRequest(b)) return false;
    return true;
  }
  // Two asks in a row, with the bot never having started, are the user being
  // away. A tool or an answer after the ask means the silence was the bot's.
  if (a.role === "user" || isRequest(a)) {
    if (
      b.kind === "tool" ||
      b.kind === "file" ||
      b.kind === "sent" ||
      b.kind === "handoff" ||
      isAssistantText(b) ||
      isCutNote(b)
    ) {
      return true;
    }
    return (
      unfinished(slice) ||
      noteUnresolved(slice, GAVE_UP) ||
      noteUnresolved(slice, RESUMED)
    );
  }
  return a.kind === "tool" || a.kind === "file" || a.kind === "sent" || isCutNote(a);
}

function isActivity(m: ChatMessage): boolean {
  return m.kind !== "compact" && !!m.id && !!m.ts;
}

function isRequest(m: ChatMessage): boolean {
  if (m.role === "user" && !m.answer) return true;
  if (m.kind === "routine") return true;
  if (m.kind === "received" && m.from !== "crew" && !isCutNote(m)) return true;
  return false;
}

function isAssistantText(m: ChatMessage): boolean {
  return m.role === "assistant" && m.kind !== "tool" && m.kind !== "file" && !!strip(m.text || "");
}

function isCutNote(m: ChatMessage): boolean {
  const text = m.text || "";
  return [...RESUMED, ...GAVE_UP].some((line) => text.includes(line));
}

function turnStart(messages: readonly ChatMessage[], anchor: number): number {
  for (let i = anchor; i >= 0; i--) {
    if (isRequest(messages[i])) return i;
  }
  return anchor;
}

function heldForUser(slice: readonly ChatMessage[]): boolean {
  return slice.some((m) => m.approval === "pending" || m.choice?.state === "pending");
}

/** The note is still the last thing that happened. Work after it means it recovered. */
function noteUnresolved(slice: readonly ChatMessage[], lines: readonly string[]): boolean {
  let at = -1;
  slice.forEach((m, i) => {
    const text = m.text || "";
    if (lines.some((line) => text.includes(line))) at = i;
  });
  if (at < 0) return false;
  return !slice.slice(at + 1).some((m) => {
    if (m.kind === "tool" || m.kind === "file") return true;
    return m.role === "assistant" && !!strip(m.text || "");
  });
}

function waitList(
  slice: readonly ChatMessage[],
  facts: IdleFacts,
  live: boolean,
): { name: string; at: number }[] {
  const ids =
    live && (facts.waitingOn ?? []).length
      ? [...(facts.waitingOn ?? [])]
      : waitingTarget(slice);
  return ids.map((id) => ({
    name: agentName(id, facts.agents),
    at: sentAt(slice, id) ?? slice[slice.length - 1]?.ts ?? 0,
  }));
}

function waitingTarget(slice: readonly ChatMessage[]): string[] {
  let target: string | null = null;
  for (const m of slice) {
    const to = sentTarget(m.from || "");
    if (m.kind === "sent" && to && !m.mention) target = to;
    if (
      target &&
      (m.kind === "handoff" || m.kind === "received") &&
      m.from === target
    ) {
      target = null;
    }
  }
  return target ? [target] : [];
}

function sentAt(slice: readonly ChatMessage[], id: string): number | null {
  let at: number | null = null;
  for (const m of slice) {
    if (m.kind === "sent" && sentTarget(m.from || "") === id && m.ts) at = m.ts;
  }
  return at;
}

function agentName(id: string, agents: readonly AgentInfo[]): string {
  return agents.find((a) => a.id === id)?.name || id;
}

function taskOf(
  slice: readonly ChatMessage[],
  agents: readonly AgentInfo[],
  lang: Locale,
): { who: string; what: string } | null {
  const req = slice.find(isRequest);
  if (!req) return null;
  const what = clip(strip(req.text || ""), 140);
  if (!what) return null;
  const who =
    req.role === "user"
      ? translate(lang, "idle.who.user")
      : req.kind === "routine"
        ? req.from || translate(lang, "idle.who.user")
        : agentName(req.from, agents);
  return { who, what };
}

function lastSaid(slice: readonly ChatMessage[]): string {
  for (let i = slice.length - 1; i >= 0; i--) {
    const m = slice[i];
    if (!isAssistantText(m)) continue;
    return clip(strip(m.text || ""), 180);
  }
  return "";
}

function stepsFor(tools: readonly ChatMessage[], said: string, stop: string | null): IdleStep[] {
  const shown = tools.slice(0, 8);
  let steps: IdleStep[] = shown.map((m) => ({ text: stepLabel(m), stop: false }));
  if (tools.length > 8) {
    steps = [
      ...tools.slice(0, 7).map((m) => ({ text: stepLabel(m), stop: false })),
      { text: "…", stop: false },
    ];
  }
  if (!steps.length && said) steps = [{ text: clip(said, 140), stop: false }];
  if (stop) {
    if (!steps.length) steps = [{ text: stop, stop: true }];
    else {
      const last = steps[steps.length - 1];
      last.stop = true;
      last.text = `${last.text} · ${stop}`;
    }
  }
  return steps;
}

function stepLabel(m: ChatMessage): string {
  const name = (m.from || "tool").split("__").pop() || "tool";
  const arg = toolSummary(m.text || "");
  return arg ? `${name}  ${arg}` : name;
}

function readFile(m: ChatMessage): string | null {
  const name = ((m.from || "").split("__").pop() || "").toLowerCase();
  if (name !== "read" && name !== "read_file") return null;
  const arg = toolSummary(m.text || "");
  return arg ? baseName(arg) : null;
}

function shortLines(tools: readonly ChatMessage[], what: string, lang: Locale): IdleSpan[][] {
  const only = tools[0];
  const file = only ? readFile(only) : null;
  if (file) return [splitToken(translate(lang, "idle.sum.read", { file }), file, "code")];
  if (only) return [[{ t: translate(lang, "idle.sum.one", { what: clip(stepLabel(only), 80) }) }]];
  if (what) return [[{ t: translate(lang, "idle.sum.one", { what: clip(what, 80) }) }]];
  return [[{ t: translate(lang, "idle.sum.none") }]];
}

function bodyLines(
  state: IdleState,
  said: string,
  names: string[],
  fileCount: number,
  gave: boolean,
  lang: Locale,
  fallback: string,
): IdleSpan[][] {
  if (state === "wait") {
    const paras: IdleSpan[][] = [];
    if (said) paras.push(emphasize(said, names));
    const name = names.join(", ");
    if (name) paras.push(splitToken(translate(lang, "idle.sum.wait", { name }), name, "strong"));
    if (!fileCount) paras.push([{ t: translate(lang, "idle.sum.wait.untouched") }]);
    return paras.slice(0, 3);
  }
  if (state === "cut") {
    const paras: IdleSpan[][] = [];
    if (said) paras.push([{ t: said }]);
    paras.push([
      { t: translate(lang, gave ? "idle.sum.gaveup" : "idle.sum.cut"), strong: true },
    ]);
    if (fileCount) paras.push([{ t: translate(lang, "idle.sum.files", { n: fileCount }) }]);
    return paras.slice(0, 3);
  }
  if (said) return [[{ t: said }]];
  if (fallback) return [[{ t: fallback }]];
  return [[{ t: translate(lang, "idle.sum.none") }]];
}

function hintOf(
  state: IdleState,
  gave: boolean,
  names: string[],
  paragraphs: IdleSpan[][],
  t: TFn,
): string {
  if (state === "cut") return t(gave ? "idle.hint.gaveup" : "idle.hint.cut");
  if (state === "wait") return names.join(", ") || t("idle.state.wait");
  const plain = paragraphs
    .flat()
    .map((s) => s.t)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return clip(plain, 24);
}

function emphasize(text: string, names: string[]): IdleSpan[] {
  const name = names.find((n) => n && text.includes(n));
  if (!name) return [{ t: text }];
  return splitToken(text, name, "strong");
}

function splitToken(text: string, token: string, mark: "strong" | "code"): IdleSpan[] {
  const at = text.indexOf(token);
  if (at < 0) return [{ t: text }];
  const out: IdleSpan[] = [];
  if (at > 0) out.push({ t: text.slice(0, at) });
  out.push(mark === "code" ? { t: token, code: true } : { t: token, strong: true });
  const rest = text.slice(at + token.length);
  if (rest) out.push({ t: rest });
  return out;
}

function fileChips(paths: readonly string[]): IdleFile[] {
  const shown = paths.slice(0, 12);
  const names = shown.map(baseName);
  const dups = new Set(names.filter((n, i) => names.indexOf(n) !== i));
  return shown.map((path, i) => ({
    path,
    name: dups.has(names[i]) ? path : names[i],
  }));
}

function pullRequests(slice: readonly ChatMessage[]): IdlePr[] {
  const byN = new Map<string, string | undefined>();
  for (const m of slice) {
    const text = m.text || "";
    const urlRe = /https?:\/\/github\.com\/[^\s)"']+\/pull\/(\d+)/g;
    let match: RegExpExecArray | null;
    while ((match = urlRe.exec(text))) {
      byN.set(match[1], match[0].replace(/[.,)]$/, ""));
    }
    const word = /\bPR\s*#(\d+)\b/gi;
    while ((match = word.exec(text))) {
      if (!byN.has(match[1])) byN.set(match[1], undefined);
    }
  }
  return [...byN.entries()].map(([n, href]) => ({ label: `#${n}`, href }));
}

function baseName(path: string): string {
  const clean = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const i = clean.lastIndexOf("/");
  return (i >= 0 ? clean.slice(i + 1) : clean) || clean;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, Math.max(1, max - 1)).trimEnd() + "…";
}

function strip(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\[crew (from:[^\]]+|routine:[^\]]+|channel:[^\]]+|system)\]$/.test(line.trim()))
    .join("\n")
    .trim();
}
