import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useT } from "../LocaleContext";
import { cliFromCmd, modelLine, pinnedDefault } from "../options";
import type { AgentInfo, CliKind } from "../types";
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
  const cli = currentAgent ? cliFromCmd(currentAgent.cmd) : null;
  const savedModel = currentAgent?.model?.trim() || "";
  // Keyed by CLI so a slow list cannot paint the previous bot's default.
  // Null is a real answer (installed, no default id). A missing key is not.
  const [defaults, setDefaults] = useState<Partial<Record<CliKind, string | null>>>({});
  const defaultsRef = useRef(defaults);
  defaultsRef.current = defaults;
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!cli || savedModel || cli in defaultsRef.current) return;
    let cancelled = false;
    api
      .listModels(cli)
      .then((list) => {
        if (cancelled) return;
        const pinned = pinnedDefault(list);
        if (pinned === undefined) return;
        setDefaults((prev) => (cli in prev ? prev : { ...prev, [cli]: pinned }));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [cli, savedModel, attempt]);

  useEffect(() => {
    const retry = () => setAttempt((n) => n + 1);
    window.addEventListener("focus", retry);
    return () => window.removeEventListener("focus", retry);
  }, []);

  const line = currentAgent
    ? modelLine(currentAgent, cli ? defaults[cli] : null, t)
    : null;
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
        {line ? (
          <span className="head-run" title={line}>
            {line}
          </span>
        ) : null}
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
