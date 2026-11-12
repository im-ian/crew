import { UNGROUPED_ID } from "./groups";
import { remoteLabel } from "./remote";
import type { AgentInfo, Group } from "./types";

/**
 * The id part of a handle. A local id is ASCII; a remote bot's is
 * `alias/account`, two of those joined by one slash. `@alpha/cli` reads as
 * the whole `alpha/cli`, so it is not `@alpha` with a path after it.
 */
const HANDLE_ID = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)?/;

/** A group's id, after `#`. Group ids are `g` and hex, ASCII like a bot's. */
const GROUP_ID = /^[A-Za-z0-9_-]+/;

/**
 * What may stand right before a handle: a space, the start, or an opening
 * bracket or quote, as in `개발자(@bot-3)`. A letter may not, so `mail@alpha`
 * is not one. `opens_handle` in the daemon reads it the same way.
 */
const HANDLE_OPENERS = "([{\"'“‘「『〈《（［";

export function opensHandle(ch: string): boolean {
  return /\s/.test(ch) || HANDLE_OPENERS.includes(ch);
}

/**
 * A regex piece for what may stand before `@` or `#`: the start, a space, or
 * an opener. Every scan that looks for a handle builds on it.
 */
export const HANDLE_START = `(^|[\\s${HANDLE_OPENERS.replace(/[\]\\^-]/g, "\\$&")}])`;

/** Markdown escapes `"` before the page sees it, and that is the only one. */
const QUOT = "&quot;";

/** One entity, matched where it starts without copying the rest of the html. */
const ENTITY = /&#?[A-Za-z0-9]+;/y;

/**
 * Whether what follows an id ends the handle: nothing, a non-ASCII letter
 * such as a Korean particle, an opening `(` as in `@bot-3(기획자)`, or closing
 * punctuation followed by nothing or by one (`@bot-3)끼리`). `@bot-3.ai` and
 * `@bot-3's` go on. In rendered markdown a closing `"` is `&quot;`; raw text
 * keeps it as is, as the daemon reads it.
 */
function handleEnds(rest: string, html = false): boolean {
  if (rest.startsWith("(")) return true;
  const close = html ? /^(?:[,.!?:;)\]}"']|&quot;)+/ : /^[,.!?:;)\]}"']+/;
  const after = rest.replace(close, "");
  return !after || /^[^\x00-\x7f]/.test(after);
}

const SKIP_TAGS = new Set(["CODE", "PRE", "A"]);
const BLOCK_TAGS = new Set([
  "P",
  "DIV",
  "LI",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "BLOCKQUOTE",
  "PRE",
  "UL",
  "OL",
  "BR",
  "TH",
  "TD",
]);

/**
 * Whether two bot lists draw the same mention chips. A chip reads only these
 * fields, so a bot's status or preview changing does not parse a bubble again.
 */
export function sameMentionAgents(a: readonly AgentInfo[], b: readonly AgentInfo[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.id !== y.id ||
      x.name !== y.name ||
      x.remote !== y.remote ||
      x.avatar !== y.avatar ||
      x.avatar_shape !== y.avatar_shape ||
      x.avatar_color !== y.avatar_color
    ) {
      return false;
    }
  }
  return true;
}

/** A teammate's bot reads as `server · name`, the server its rail section is. */
export function mentionLabel(agent: AgentInfo): string {
  const name = agent.name || agent.id;
  return agent.remote ? `${agent.remote} · ${name}` : name;
}

/**
 * Whether the mention menu offers `agent` for what was typed after `@`.
 * A teammate's bot is found by its server or its own name.
 */
export function mentionMatches(agent: AgentInfo, query: string): boolean {
  const q = query.toLowerCase();
  if (!q) return true;
  return [
    agent.id,
    agent.name || "",
    agent.remote || "",
    agent.remote ? remoteLabel(agent) : "",
    mentionLabel(agent),
  ].some((s) => s.toLowerCase().includes(q));
}

function resolveId(token: string, agents: readonly AgentInfo[]): AgentInfo | undefined {
  const lower = token.toLowerCase();
  return agents.find((a) => a.id.toLowerCase() === lower);
}

/**
 * An id wins over a name that spells it, across the whole roster, so the
 * `@id` a picked chip sends stays the bot it was picked as.
 */
export function resolveMention(
  token: string,
  agents: readonly AgentInfo[],
): AgentInfo | undefined {
  const lower = token.toLowerCase();
  return (
    resolveId(token, agents) ??
    agents.find(
      (a) =>
        a.name === token ||
        (a.name || a.id).toLowerCase() === lower ||
        // A teammate's bot typed as `alias/name`, the way the rail shows it.
        (!!a.remote && remoteLabel(a).toLowerCase() === lower),
    )
  );
}

export function trimMentionPunct(token: string): string {
  return token.replace(/[,.!?:;)\]}"']+$/, "");
}

/** The groups `#` can name: the folders on the rail, not the loose bots. */
function namedGroups(groups: readonly Group[]): readonly Group[] {
  return groups.some((g) => g.id === UNGROUPED_ID)
    ? groups.filter((g) => g.id !== UNGROUPED_ID)
    : groups;
}

/** Whether the `#` menu offers `group` for what was typed after `#`. */
export function groupMatches(group: Group, query: string): boolean {
  const q = query.toLowerCase();
  if (!q) return true;
  return group.name.toLowerCase().includes(q) || group.id.toLowerCase().includes(q);
}

/** The groups the `#` menu offers for `query`. */
export function groupCandidates(groups: readonly Group[], query: string): Group[] {
  return namedGroups(groups)
    .filter((g) => groupMatches(g, query))
    .slice(0, 8);
}

/** A `#` token as a group: its id first, then the name it goes by. */
export function resolveGroup(token: string, groups: readonly Group[]): Group | undefined {
  const lower = token.toLowerCase();
  const named = namedGroups(groups);
  return (
    named.find((g) => g.id.toLowerCase() === lower) ??
    named.find((g) => g.name === token || g.name.toLowerCase() === lower)
  );
}

/** `@id` where `handleAt` would end the handle. A longer token is not it. */
export function mentionsId(text: string, id: string): boolean {
  if (!text || !id) return false;
  let prevWs = true;
  for (let i = 0; i < text.length; i++) {
    if (prevWs && text[i] === "@") {
      const raw = (text.slice(i + 1).match(/^[^\s<]+/) || [""])[0];
      const token = (raw.match(HANDLE_ID) || [""])[0];
      const rest = raw.slice(token.length);
      if (token === id && handleEnds(rest)) return true;
    }
    prevWs = opensHandle(text[i]);
  }
  return false;
}

/**
 * The copy a user's @mention leaves in the named bot's chat.
 * The sentence stays where it was typed, so this copy is not drawn.
 */
export function isSelfMentionDelivery(
  m: { role: string; from: string; kind?: string | null; text?: string | null },
  selfId: string | null | undefined,
): boolean {
  if (!selfId) return false;
  if (m.role !== "system" || m.from !== "user" || m.kind !== "received") return false;
  return mentionsId(m.text || "", selfId);
}

function attr(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

const SENT_HANDLE = new RegExp(`${HANDLE_START}([@#])(\\S+)`, "g");

/**
 * What the composer sends: a handle typed by name and never picked from the
 * menu (pasted, or the menu dismissed) goes out as `@id`, or `#id` for a
 * group, the only form the rest of Crew reads.
 */
export function mentionIds(
  text: string,
  agents: readonly AgentInfo[],
  groups: readonly Group[] = [],
): string {
  // Code is left as written, as the chips leave it. Odd parts are the code.
  return text
    .split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/)
    .map((part, i) =>
      i % 2
        ? part
        : part.replace(SENT_HANDLE, (all, pre: string, sigil: string, raw: string) => {
            const find = (token: string) =>
              sigil === "@" ? resolveMention(token, agents)?.id : resolveGroup(token, groups)?.id;
            const whole = trimMentionPunct(raw);
            let token = whole;
            let id = whole ? find(whole) : undefined;
            // A name closed by a bracket and then a particle: `(@춘식이)끼리`.
            const cut = raw.search(/[,.!?:;)\]}"']/);
            if (!id && cut > 0 && handleEnds(raw.slice(cut))) {
              token = raw.slice(0, cut);
              id = find(token);
            }
            return id ? pre + sigil + id + raw.slice(token.length) : all;
          }),
    )
    .join("");
}

/**
 * A run of preview text, or a handle when `agent` is the bot it names or
 * `group` the group.
 */
export type MentionRun = { text: string; agent?: AgentInfo; group?: Group };

/** A handle `handleAt` found: a bot after `@`, or a group after `#`. */
export type Handle = { label: string; length: number } & (
  | { sigil: "@"; agent: AgentInfo; group?: undefined }
  | { sigil: "#"; group: Group; agent?: undefined }
);

/** Where a handle's token ends, or nothing when the word goes on past it. */
function handleToken(text: string, i: number, shape: RegExp, html: boolean): string {
  const raw = (text.slice(i + 1).match(/^[^\s<]+/) || [""])[0];
  const token = (raw.match(shape) || [""])[0];
  return handleEnds(raw.slice(token.length), html) ? token : "";
}

/**
 * The one place that decides where a handle starts and ends. `injectMentionChips`
 * and `mentionRuns` both scan for the same thing and would drift apart as two
 * copies; only what they build from a hit differs.
 *
 * A handle is `@` and an id; names are for the screen, and the composer sends
 * them as ids (`mentionIds`). A remote bot's id is `alias/account`. Ids are
 * ASCII, so one ends at the first other character, as long as that ends the
 * word too: a Korean particle (`@bot-x에게`) or closing punctuation
 * (`@bot-x,`) does, the `.ai` in `@claude.ai` does not. `mention_tokens` in
 * the daemon reads it the same way.
 *
 * A group is `#` and its id, read the same way. Only an id that is a group
 * counts, so `#233` or a heading stays text.
 *
 * Returns the resolved bot or group and how many characters of `text` it consumed.
 */
export function handleAt(
  text: string,
  i: number,
  agents: readonly AgentInfo[],
  groups: readonly Group[] = [],
  html = false,
): Handle | undefined {
  if (text[i] === "#") {
    const token = handleToken(text, i, GROUP_ID, html);
    const lower = token.toLowerCase();
    const group = token
      ? namedGroups(groups).find((g) => g.id.toLowerCase() === lower)
      : undefined;
    if (!group) return undefined;
    return { sigil: "#", group, label: group.name, length: 1 + token.length };
  }
  if (text[i] !== "@") return undefined;
  const token = handleToken(text, i, HANDLE_ID, html);
  if (!token) return undefined;
  const agent = resolveId(token, agents);
  if (!agent) return undefined;
  return {
    sigil: "@",
    agent,
    label: mentionLabel(agent),
    length: 1 + token.length + nameAfter(text.slice(i + 1 + token.length), agent),
  };
}

/**
 * How much of `rest` is the bot's own name in parentheses, `(Moon)` after
 * `@bot-x`, which the chip already shows. Zero for anything else, such as
 * `(이거 봐줘)`, which stays as text after the chip.
 */
function nameAfter(rest: string, agent: AgentInfo): number {
  const m = rest.match(/^\(([^()\n<]{1,40})\)/);
  const said = m?.[1].trim().toLowerCase();
  if (!m || !said) return 0;
  // The whole name, or one word of it: `(Moon)` for "개발자 Moon".
  const names = [agent.name || agent.id, mentionLabel(agent)].map((n) => n.toLowerCase());
  const fits = names.some((n) => n === said || n.split(/[\s·]+/).includes(said));
  return fits ? m[0].length : 0;
}

/**
 * Runs for a one-line preview. Previews carry the raw message text, so a
 * mention arrives as `@bot-3`; read it back as the name the roster shows.
 */
export function mentionRuns(
  text: string,
  agents: readonly AgentInfo[],
  groups: readonly Group[] = [],
): MentionRun[] {
  if (!text) return [];
  if (!agents.length && !groups.length) {
    return [{ text }];
  }
  const runs: MentionRun[] = [];
  let plain = "";
  let i = 0;
  let prevWs = true;
  while (i < text.length) {
    const hit = prevWs ? handleAt(text, i, agents, groups) : undefined;
    if (hit) {
      if (plain) runs.push({ text: plain });
      plain = "";
      runs.push(
        hit.sigil === "@"
          ? { text: hit.sigil + hit.label, agent: hit.agent }
          : { text: hit.sigil + hit.label, group: hit.group },
      );
      i += hit.length;
      prevWs = false;
      continue;
    }
    plain += text[i];
    prevWs = opensHandle(text[i]);
    i += 1;
  }
  if (plain) runs.push({ text: plain });
  return runs;
}

/** The preview with each handle as `@name` or `#group`, for matching a search query. */
export function mentionText(
  text: string,
  agents: readonly AgentInfo[],
  groups: readonly Group[] = [],
): string {
  return mentionRuns(text, agents, groups)
    .map((r) => r.text)
    .join("");
}

/**
 * Each handle in rendered markdown as an empty chip the page fills in. A
 * group chip carries its name, so drawing it needs no group list.
 */
export function injectMentionChips(
  html: string,
  agents: readonly AgentInfo[],
  groups: readonly Group[] = [],
): string {
  if (!agents.length && !groups.length) return html;
  let out = "";
  let i = 0;
  let prevWs = true;
  const stack: string[] = [];
  // Whether each open tag shuts chips out. KaTeX's markup goes to the page
  // as it is, so a chip inside a formula would never become a chip.
  const skips: boolean[] = [];
  const inSkip = () => skips.includes(true);

  while (i < html.length) {
    if (html[i] === "<") {
      const gt = html.indexOf(">", i);
      if (gt < 0) {
        out += html.slice(i);
        break;
      }
      const raw = html.slice(i + 1, gt);
      const close = raw.startsWith("/");
      const name = (close ? raw.slice(1) : raw)
        .replace(/[\s/].*$/, "")
        .toUpperCase();
      if (close) {
        const idx = stack.lastIndexOf(name);
        if (idx >= 0) stack.length = skips.length = idx;
      } else if (!raw.endsWith("/") && name && name !== "BR") {
        stack.push(name);
        skips.push(SKIP_TAGS.has(name) || raw.includes('class="md-math'));
      }
      if (BLOCK_TAGS.has(name)) prevWs = true;
      out += html.slice(i, gt + 1);
      i = gt + 1;
      continue;
    }
    if (inSkip()) {
      const next = html.indexOf("<", i);
      const end = next < 0 ? html.length : next;
      out += html.slice(i, end);
      prevWs = false;
      i = end;
      continue;
    }
    const hit = prevWs ? handleAt(html, i, agents, groups, true) : undefined;
    if (hit) {
      out +=
        hit.sigil === "@"
          ? `<span class="mention-chip" data-mention="${attr(hit.agent.id)}"></span>`
          : `<span class="mention-chip" data-group="${attr(hit.group.id)}" data-label="${attr(hit.group.name)}"></span>`;
      i += hit.length;
      prevWs = false;
      continue;
    }
    // Markdown escapes a quote, so `"@bot-3"` arrives as `&quot;@bot-3&quot;`.
    // Any other entity glues an `@` after it to a word.
    if (html[i] === "&") {
      ENTITY.lastIndex = i;
      const entity = ENTITY.exec(html)?.[0];
      if (entity) {
        out += entity;
        prevWs = entity === QUOT;
        i += entity.length;
        continue;
      }
    }
    out += html[i];
    prevWs = opensHandle(html[i]);
    i += 1;
  }
  return out;
}
