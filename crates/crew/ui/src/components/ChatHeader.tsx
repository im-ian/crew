import { isBusyStatus } from "../busy";
import { useT } from "../LocaleContext";
import type { AgentInfo } from "../types";
import { WhoButton } from "./WhoButton";
import { Info, StopSquare } from "../icons";

type Props = {
  currentAgent: AgentInfo | null;
  onOpenInfo: () => void;
  onOpenRoutines: () => void;
  onStop?: (agentId?: string) => void;
};

export function ChatHeader({
  currentAgent,
  onOpenInfo,
  onOpenRoutines,
  onStop,
}: Props) {
  const t = useT();
  const stopId =
    currentAgent && isBusyStatus(currentAgent.status) ? currentAgent.id : null;

  const identity = currentAgent ? (
    <WhoButton
      agent={currentAgent}
      who={currentAgent.name || currentAgent.id}
      title={t("header.botInfo")}
      onClick={onOpenInfo}
    />
  ) : (
    <span className="head-empty">{t("header.pickChat")}</span>
  );

  return (
    <header>
      <div className="head-identity">{identity}</div>
      {stopId && onStop ? (
        <button
          type="button"
          className="head-action is-stop"
          title={t("header.stopTitle")}
          aria-label={t("header.stop")}
          onClick={() => onStop(stopId)}
        >
          <StopSquare />
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
