import type { AgentInfo, ChannelInfo } from "./types";

const SKIP_TAGS = new Set(["CODE", "PRE", "A"]);
const BLOCK_TAGS = new Set([
  "P",
  "DIV",
  "LI",
  "H1",
  "H2",
  "H3",
  "PRE",
  "UL",
  "OL",
  "BR",
]);

export function mentionLabel(agent: AgentInfo): string {
  return agent.name || agent.id;
}

export function channelLabel(channel: ChannelInfo): string {
  return channel.name || channel.id;
}

export function resolveMention(
  token: string,
  agents: readonly AgentInfo[],
): AgentInfo | undefined {
  const lower = token.toLowerCase();
  return agents.find(
    (a) =>
      a.id === token ||
      a.name === token ||
      a.id.toLowerCase() === lower ||
      mentionLabel(a).toLowerCase() === lower,
  );
}

export function resolveChannel(
  token: string,
  channels: readonly ChannelInfo[],
): ChannelInfo | undefined {
  const raw = token.replace(/^#/, "");
  const lower = raw.toLowerCase();
  return channels.find(
    (c) =>
      c.id === raw ||
      c.name === raw ||
      c.id.toLowerCase() === lower ||
      channelLabel(c).toLowerCase() === lower,
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

export function injectMentionChips(
  html: string,
  agents: readonly AgentInfo[],
  channels: readonly ChannelInfo[] = [],
): string {
  if (!agents.length && !channels.length) return html;
  let out = "";
  let i = 0;
  let prevWs = true;
  const stack: string[] = [];
  const inSkip = () => stack.some((t) => SKIP_TAGS.has(t));

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
        if (idx >= 0) stack.length = idx;
      } else if (!raw.endsWith("/") && name && name !== "BR") {
        stack.push(name);
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
    if (html[i] === "@" && prevWs) {
      const raw = (html.slice(i + 1).match(/^[^\s<]+/) || [""])[0];
      const token = trimMentionPunct(raw);
      const agent = token ? resolveMention(token, agents) : undefined;
      if (agent) {
        out += `<span class="mention-chip" data-mention="${attr(agent.id)}"></span>`;
        i += 1 + token.length;
        prevWs = false;
        continue;
      }
    }
    if (html[i] === "#" && prevWs) {
      const raw = (html.slice(i + 1).match(/^[^\s<]+/) || [""])[0];
      const token = trimMentionPunct(raw);
      const channel = token ? resolveChannel(token, channels) : undefined;
      if (channel) {
        out += `<span class="mention-chip" data-channel="${attr(channel.id)}"></span>`;
        i += 1 + token.length;
        prevWs = false;
        continue;
      }
    }
    out += html[i];
    prevWs = /\s/.test(html[i]);
    i += 1;
  }
  return out;
}
