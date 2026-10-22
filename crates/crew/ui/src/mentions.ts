import type { AgentInfo } from "./types";

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

export function mentionLabel(agent: AgentInfo): string {
  return agent.name || agent.id;
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
    agents.find((a) => a.name === token || mentionLabel(a).toLowerCase() === lower)
  );
}

export function trimMentionPunct(token: string): string {
  return token.replace(/[,.!?:;)\]}"']+$/, "");
}

function attr(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

/**
 * What the composer sends: a handle typed by name and never picked from the
 * menu (pasted, or the menu dismissed) goes out as `@id`, the only form the
 * rest of Crew reads.
 */
export function mentionIds(text: string, agents: readonly AgentInfo[]): string {
  // Code is left as written, as the chips leave it. Odd parts are the code.
  return text
    .split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/)
    .map((part, i) =>
      i % 2
        ? part
        : part.replace(/(^|\s)@(\S+)/g, (all, pre: string, raw: string) => {
            const token = trimMentionPunct(raw);
            const agent = token ? resolveMention(token, agents) : undefined;
            return agent ? pre + "@" + agent.id + raw.slice(token.length) : all;
          }),
    )
    .join("");
}

export type MentionRun = { text: string; mention: boolean; id?: string };

/**
 * The one place that decides where a handle starts and ends. `injectMentionChips`
 * and `mentionRuns` both scan for the same thing and would drift apart as two
 * copies; only what they build from a hit differs.
 *
 * A handle is `@` and an id; names are for the screen, and the composer sends
 * them as ids (`mentionIds`). Ids are ASCII, so one ends at the first other
 * character, as long as that ends the word too: a Korean particle
 * (`@bot-x에게`) or closing punctuation (`@bot-x,`) does, the `.ai` in
 * `@claude.ai` does not. `mention_tokens` in the daemon reads it the same way.
 *
 * Returns the resolved label and how many characters of `text` it consumed.
 */
export function handleAt(
  text: string,
  i: number,
  agents: readonly AgentInfo[],
): { sigil: string; id: string; label: string; length: number } | undefined {
  if (text[i] !== "@") return undefined;
  const raw = (text.slice(i + 1).match(/^[^\s<]+/) || [""])[0];
  const token = (raw.match(/^[A-Za-z0-9_-]+/) || [""])[0];
  const rest = raw.slice(token.length);
  const ends = !rest || /^[^\x00-\x7f]/.test(rest) || !trimMentionPunct(rest);
  if (!token || !ends) return undefined;
  const agent = resolveId(token, agents);
  if (!agent) return undefined;
  return {
    sigil: "@",
    id: agent.id,
    label: mentionLabel(agent),
    length: 1 + token.length,
  };
}

/**
 * Runs for a one-line preview. Previews carry the raw message text, so a
 * mention arrives as `@bot-3`; read it back as the name the roster shows.
 */
export function mentionRuns(
  text: string,
  agents: readonly AgentInfo[],
): MentionRun[] {
  if (!text) return [];
  if (!agents.length) {
    return [{ text, mention: false }];
  }
  const runs: MentionRun[] = [];
  let plain = "";
  let i = 0;
  let prevWs = true;
  while (i < text.length) {
    const hit = prevWs ? handleAt(text, i, agents) : undefined;
    if (hit) {
      if (plain) runs.push({ text: plain, mention: false });
      plain = "";
      runs.push({ text: hit.sigil + hit.label, mention: true, id: hit.id });
      i += hit.length;
      prevWs = false;
      continue;
    }
    plain += text[i];
    prevWs = /\s/.test(text[i]);
    i += 1;
  }
  if (plain) runs.push({ text: plain, mention: false });
  return runs;
}

/** The preview as it reads on screen, for matching a search query against it. */
export function mentionText(text: string, agents: readonly AgentInfo[]): string {
  return mentionRuns(text, agents)
    .map((r) => r.text)
    .join("");
}

export function injectMentionChips(html: string, agents: readonly AgentInfo[]): string {
  if (!agents.length) return html;
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
    const hit = prevWs ? handleAt(html, i, agents) : undefined;
    if (hit) {
      out += `<span class="mention-chip" data-mention="${attr(hit.id)}"></span>`;
      i += hit.length;
      prevWs = false;
      continue;
    }
    out += html[i];
    prevWs = /\s/.test(html[i]);
    i += 1;
  }
  return out;
}
