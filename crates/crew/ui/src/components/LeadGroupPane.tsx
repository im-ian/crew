import { useMemo } from "react";
import { BotLabelProvider, useLabelGroups } from "../BotLabelContext";
import { listStamp } from "../clock";
import { Star, Users, X } from "../icons";
import { useLocale, useT } from "../LocaleContext";
import { mentionRuns } from "../mentions";
import { askingAmong, briefStatus, waitingOn, waitingUserPhrase } from "../statusView";
import type { AgentInfo, Group } from "../types";
import { Avatar } from "./Avatar";
import { MentionRunsView } from "./MentionChip";
import { SidePane } from "./SidePane";

/**
 * The bots of the group the open chat leads, beside the chat: each with its
 * face, what it is doing, and its last line. A row opens that bot's chat.
 */
export function LeadGroupPane({
  group,
  bots,
  agents,
  leadId,
  onPick,
  onClose,
}: {
  group: Group;
  /** The group's bots in sidebar order (`groupBots`). */
  bots: AgentInfo[];
  /** Every bot, so a mention in a preview reads as a name. */
  agents: AgentInfo[];
  leadId: string;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <SidePane labelledBy="lead-pane-title" focusKey={group.id} className="lead-pane">
      <div className="titlebar-align" data-tauri-drag-region />
      <header className="peek-head file-head" data-tauri-drag-region="deep">
        <Users className="file-head-icon" size={16} />
        <div className="file-head-text">
          <h2 id="lead-pane-title" className="file-name">
            {t("leadPane.title", { group: group.name })}
          </h2>
          <p className="file-dir">{t("leadPane.count", { count: bots.length })}</p>
        </div>
        <button
          type="button"
          className="head-action"
          title={t("leadPane.close")}
          aria-label={t("leadPane.close")}
          onClick={onClose}
        >
          <X />
        </button>
      </header>
      <div className="lead-pane-body">
        {bots.length ? (
          bots.map((bot) => (
            <GroupBotRow
              key={bot.id}
              bot={bot}
              agents={agents}
              lead={bot.id === leadId}
              onPick={() => onPick(bot.id)}
            />
          ))
        ) : (
          <p className="file-state">{t("leadPane.empty")}</p>
        )}
      </div>
    </SidePane>
  );
}

function GroupBotRow({
  bot,
  agents,
  lead,
  onPick,
}: {
  bot: AgentInfo;
  agents: AgentInfo[];
  /** The open chat: it leads the group, so it carries the star. */
  lead: boolean;
  onPick: () => void;
}) {
  const t = useT();
  const { locale } = useLocale();
  const labelGroups = useLabelGroups();
  const name = bot.name || bot.id;
  const status = briefStatus(bot, t);
  const statusText =
    status.tone === "waiting"
      ? (waitingUserPhrase(askingAmong(waitingOn(bot), agents), t) ?? status.text)
      : status.text;
  const ts = bot.last_ts || 0;
  const stamp = listStamp(ts, locale);
  const runs = useMemo(
    () => mentionRuns(bot.preview || "", agents, labelGroups),
    [bot.preview, agents, labelGroups],
  );
  return (
    <button
      type="button"
      className={"rail-row lead-row" + (lead ? " active" : "")}
      aria-current={lead ? "page" : undefined}
      onClick={onPick}
    >
      <Avatar
        id={bot.id}
        name={name}
        src={bot.avatar}
        shape={bot.avatar_shape}
        color={bot.avatar_color}
        badge={bot.status}
        status={bot.status}
        waiting={waitingOn(bot).length > 0}
      />
      <div className="rail-row-text">
        <div className="agent-name">
          <span className="agent-name-label">
            {lead ? (
              <span className="lead-mark" title={t("sidebar.groupLead")}>
                <Star size={14} />
              </span>
            ) : null}
            <span className="agent-name-text">{name}</span>
          </span>
          {stamp ? (
            <time className="rail-stamp" dateTime={new Date(ts).toISOString()}>
              {stamp}
            </time>
          ) : null}
        </div>
        <div className="lead-row-line">
          <span
            className={"head-status is-" + status.tone}
            title={statusText !== status.text ? statusText : undefined}
          >
            <span className="head-status-text">{statusText}</span>
          </span>
          {bot.preview ? (
            <span className="agent-preview lead-row-preview">
              {/* The preview is this bot's chat, so its group is the one left off. */}
              <BotLabelProvider viewer={bot.id}>
                <MentionRunsView runs={runs} />
              </BotLabelProvider>
            </span>
          ) : null}
        </div>
      </div>
    </button>
  );
}
