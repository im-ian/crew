import type { Locale, TFn } from "./i18n";
import { translate } from "./i18n";
import type { IdleCard, IdleState } from "./idleTypes";
import { sentTarget } from "./peek";
import { rowTs, toolSummary, type ThreadRow } from "./tools";
import type { AgentInfo, ChatMessage } from "./types";

type IdleFile = { name: string; path: string };
type IdlePr = { label: string; href?: string };

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
 * One bubble per stall that lasted at least the threshold while a turn was
 * still open. The latest one is live until something happens again; earlier
 * ones stay where the silence was, as the same bubble.
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

/** "14분째 활동 없음", or from an hour "1시간 12분째". */
export function formatAgo(minutes: number, t: TFn): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h && m) return t("idle.ago.hm", { h, m });
  if (h) return t("idle.ago.h", { h });
  return t("idle.ago.m", { m: minutes });
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
  const short =
    state === "quiet" &&
    tools.length <= 1 &&
    !said &&
    files.length === 0 &&
    prs.length === 0;
  const names = waiting.map((w) => w.name);
  const minutes = Math.max(1, Math.floor(gapMs / MINUTE));
  const body = spokenBody({
    t,
    state,
    gave,
    names,
    said,
    tools,
    files,
    prs,
    task,
    stop,
    minutes,
    short,
  });
  return {
    id: `idle-${anchorMsg.id}`,
    afterId: anchorMsg.id,
    activityTs: anchorMsg.ts,
    minutes,
    live,
    state,
    body,
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

function spokenBody(input: {
  t: TFn;
  state: IdleState;
  gave: boolean;
  names: string[];
  said: string;
  tools: readonly ChatMessage[];
  files: readonly IdleFile[];
  prs: readonly IdlePr[];
  task: { who: string; what: string } | null;
  stop: string | null;
  minutes: number;
  short: boolean;
}): string {
  const { t, state, gave, names, said, tools, files, prs, task, stop, minutes, short } = input;
  const ago = formatAgo(minutes, t);
  if (short) return shortLine(tools, task?.what ?? "", ago, t);

  const sentences: string[] = [];
  if (said) sentences.push(t("idle.say.last", { said: mdPlain(said) }));
  if (state === "wait") {
    const name = names.join(", ");
    sentences.push(
      name ? t("idle.say.wait", { name: mdPlain(name), ago }) : t("idle.say.quiet", { ago }),
    );
    if (!files.length) sentences.push(t("idle.say.wait.untouched"));
  } else if (state === "cut") {
    sentences.push(t(gave ? "idle.say.gaveup" : "idle.say.cut", { ago }));
    if (files.length) sentences.push(t("idle.say.files", { n: files.length }));
  } else if (!said) {
    const what = tools.length ? stepLabel(tools[tools.length - 1]) : (task?.what ?? "");
    sentences.push(
      what
        ? t("idle.say.one", { what: mdPlain(clip(what, 80)), ago })
        : t("idle.say.none", { ago }),
    );
    if (files.length) sentences.push(t("idle.say.files", { n: files.length }));
  } else {
    sentences.push(t("idle.say.quiet", { ago }));
    if (files.length) sentences.push(t("idle.say.files", { n: files.length }));
  }

  const blocks = [sentences.slice(0, 3).join(" ")];
  if (task) {
    blocks.push(section(t("idle.task"), [`${mdPlain(task.who)} · ${mdPlain(task.what)}`]));
  }
  const steps = stepLines(tools, stop);
  if (steps.length) blocks.push(section(t("idle.did"), steps.map(mdPlain)));
  if (files.length) {
    blocks.push(section(t("idle.files"), files.map((file) => codeSpan(file.name))));
  }
  if (prs.length) blocks.push(section(t("idle.pr"), prs.map(prItem)));
  return blocks.filter(Boolean).join("\n\n");
}

function shortLine(
  tools: readonly ChatMessage[],
  what: string,
  ago: string,
  t: TFn,
): string {
  const only = tools[0];
  const file = only ? readFile(only) : null;
  if (file) return t("idle.say.read", { file: file.replace(/`/g, ""), ago });
  if (only) return t("idle.say.one", { what: mdPlain(clip(stepLabel(only), 80)), ago });
  if (what) return t("idle.say.one", { what: mdPlain(clip(what, 80)), ago });
  return t("idle.say.none", { ago });
}

/** Every tool, in order. A cut is named on the last line, in words. */
function stepLines(tools: readonly ChatMessage[], stop: string | null): string[] {
  const steps = tools.map(stepLabel);
  if (!steps.length || !stop) return steps;
  const last = steps.length - 1;
  steps[last] = `${steps[last]} · ${stop}`;
  return steps;
}

function section(title: string, items: string[]): string {
  return `**${title}**\n\n${items.map((item) => `- ${item}`).join("\n")}`;
}

function prItem(pr: IdlePr): string {
  if (pr.href && /^https?:\/\//.test(pr.href) && !/[\s()]/.test(pr.href)) {
    return `[${pr.label}](${pr.href})`;
  }
  return pr.label;
}

function mdPlain(text: string): string {
  return text.replace(/[\\`*_[\]<>]/g, (ch) => `\\${ch}`);
}

function codeSpan(text: string): string {
  return "`" + text.replace(/`/g, "'") + "`";
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

function fileChips(paths: readonly string[]): IdleFile[] {
  const shown = paths.slice();
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
