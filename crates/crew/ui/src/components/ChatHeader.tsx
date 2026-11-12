import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useT } from "../LocaleContext";
import { cliFromCmd, modelLine, pinnedDefault } from "../options";
import { isOnline, remoteLabel } from "../remote";
import type { AgentInfo, CliKind } from "../types";
import { WhoButton } from "./WhoButton";
import { Info } from "../icons";
import { isWatching, watchLabel } from "../watchView";

type Props = {
  currentAgent: AgentInfo | null;
  onOpenInfo: () => void;
  onRenameAgent: (id: string, name: string) => void;
};

export function ChatHeader({
  currentAgent,
  onOpenInfo,
  onRenameAgent,
}: Props) {
  const t = useT();
  const cli = currentAgent ? cliFromCmd(currentAgent.cmd, currentAgent.headless) : null;
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

  // A teammate's bot runs on their PC: its AI is theirs to know, and what
  // this window can say is whether that PC is on the router.
  const remote = !!currentAgent?.remote;
  const line = !currentAgent
    ? null
    : remote
      ? isOnline(currentAgent)
        ? t("header.remoteOnline")
        : t("header.remoteOffline")
      : modelLine(currentAgent, cli ? defaults[cli] : null, t);
  const status = currentAgent?.status;
  // The list shows while the bot is idle or working. Blocked and exited keep
  // their own word: those are what the user has to act on.
  const watching =
    !remote &&
    isWatching(currentAgent) &&
    status !== "blocked" &&
    status !== "exited";
  const statusKey =
    remote && currentAgent?.asking
      ? "header.statusOwner"
      : status === "working"
        ? "header.statusWorking"
        : status === "blocked"
          ? "header.statusBlocked"
          : status === "exited"
            ? "header.statusExited"
            : null;
  const statusClass = watching
    ? "watching"
    : remote && currentAgent?.asking
      ? "blocked"
      : status;
  const statusText =
    watching && currentAgent
      ? watchLabel(currentAgent, Date.now(), t)
      : statusKey
        ? t(statusKey)
        : null;

  const identity = currentAgent ? (
    <WhoButton
      agent={currentAgent}
      who={remote ? remoteLabel(currentAgent) : currentAgent.name || currentAgent.id}
      title={t("header.botInfo")}
      onClick={remote ? undefined : onOpenInfo}
      onRename={
        currentAgent && !remote
          ? (name) => onRenameAgent(currentAgent.id, name)
          : undefined
      }
    />
  ) : (
    <span className="head-empty">{t("header.pickChat")}</span>
  );

  return (
    // `deep` moves the window from the empty header. Buttons stay clicks.
    <header data-tauri-drag-region="deep">
      <div className="head-identity">
        {identity}
        {line ? (
          <span
            className={"head-run" + (remote && isOnline(currentAgent) ? " is-online" : "")}
            title={line}
          >
            {line}
          </span>
        ) : null}
        {statusText ? (
          <span
            className={"head-status is-" + statusClass}
            title={watching ? statusText : undefined}
          >
            <span className="head-status-text">{statusText}</span>
          </span>
        ) : null}
      </div>
      {currentAgent && !remote ? (
        <button
          type="button"
          className="head-action"
          title={t("header.botInfo")}
          aria-label={t("header.botInfo")}
          onClick={onOpenInfo}
        >
          <Info />
        </button>
      ) : null}
    </header>
  );
}
