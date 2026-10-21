import { useT } from "../LocaleContext";
import type { AgentInfo } from "../types";
import { WhoButton } from "./WhoButton";
import { Info } from "../icons";

type Props = {
  currentAgent: AgentInfo | null;
  onOpenInfo: () => void;
  onOpenRoutines: () => void;
};

export function ChatHeader({
  currentAgent,
  onOpenInfo,
  onOpenRoutines,
}: Props) {
  const t = useT();
  const status = currentAgent?.status;
  const statusKey =
    status === "working"
      ? "header.statusWorking"
      : status === "blocked"
        ? "header.statusBlocked"
        : status === "exited"
          ? "header.statusExited"
          : null;

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
      <div className="head-identity">
        {identity}
        {statusKey ? (
          <span className={"head-status is-" + status}>{t(statusKey)}</span>
        ) : null}
      </div>
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
