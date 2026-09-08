import { busyInChannel, isBusyStatus } from "../busy";
import { useT } from "../LocaleContext";
import type { AgentInfo, ChannelInfo } from "../types";
import { WhoButton } from "./WhoButton";
import { Info, StopSquare } from "../icons";

type Props = {
  currentAgent: AgentInfo | null;
  currentChannel: ChannelInfo | null;
  agents?: AgentInfo[];
  onOpenInfo: () => void;
  onOpenRoutines: () => void;
  onStop?: (agentId?: string) => void;
};

export function ChatHeader({
  currentAgent,
  currentChannel,
  agents = [],
  onOpenInfo,
  onOpenRoutines,
  onStop,
}: Props) {
  const t = useT();
  const busy = busyInChannel(agents, currentChannel?.id);
  const stopIds = currentChannel
    ? busy.filter((a) => a.status === "working").map((a) => a.id)
    : currentAgent && isBusyStatus(currentAgent.status)
      ? [currentAgent.id]
      : [];

  let identity = <span className="head-empty">{t("header.pickChat")}</span>;
  if (currentChannel) {
    identity = (
      <WhoButton
        agent={null}
        who={currentChannel.name || currentChannel.id}
        letter="#"
        fallbackId={currentChannel.id}
        title={t("header.channelInfo")}
        onClick={onOpenInfo}
      />
    );
  } else if (currentAgent) {
    identity = (
      <WhoButton
        agent={currentAgent}
        who={currentAgent.name || currentAgent.id}
        title={t("header.botInfo")}
        onClick={onOpenInfo}
      />
    );
  }

  return (
    <header>
      <div className="head-identity">{identity}</div>
      {busy.length ? (
        <div className="head-busy" aria-label={t("header.busyMembers")}>
          {busy.slice(0, 6).map((a) => (
            <WhoButton
              key={a.id}
              agent={a}
              who={a.name || a.id}
              title={
                a.status === "blocked"
                  ? t("header.needsReview", { name: a.name || a.id })
                  : t("header.working", { name: a.name || a.id })
              }
            />
          ))}
        </div>
      ) : null}
      {stopIds.length && onStop ? (
        <button
          type="button"
          className="head-action is-stop"
          title={t("header.stopTitle")}
          aria-label={t("header.stop")}
          onClick={() => {
            for (const id of stopIds) onStop(id);
          }}
        >
          <StopSquare />
        </button>
      ) : null}
      {currentChannel ? (
        <button
          type="button"
          className="head-action"
          title={t("header.channelSettingsTitle")}
          aria-label={t("header.channelSettings")}
          onClick={onOpenInfo}
        >
          <Info />
        </button>
      ) : null}
      {currentAgent ? (
        <button
          type="button"
          className="head-action"
          title={t("header.botSettingsTitle")}
          aria-label={t("header.botSettings")}
          onClick={onOpenRoutines}
        >
          <Info />
        </button>
      ) : null}
    </header>
  );
}
