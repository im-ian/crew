import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useT } from "../LocaleContext";
import { cliFromCmd, headerModelLine, pinnedDefault } from "../options";
import { isOnline, remoteLabel } from "../remote";
import type { AgentInfo, CliKind, Group } from "../types";
import { WhoButton } from "./WhoButton";
import { Info, Menu, Users, X } from "../icons";
import { statusView, waitingFailed, waitingOn } from "../statusView";
import { WaitStatus } from "./WaitingOn";

type Props = {
  currentAgent: AgentInfo | null;
  /** Every bot, to name the ones this bot waits on. */
  agents?: readonly AgentInfo[];
  groups: readonly Group[];
  onOpenInfo: () => void;
  /** Set when this bot leads its sidebar group: opens the group's bots beside the chat. */
  onOpenGroup?: () => void;
  /** That panel is open now. */
  groupOpen?: boolean;
  onRenameAgent: (id: string, name: string) => void;
  /** Opens another bot's chat: a chip of a bot this one waits on. */
  onSelectAgent?: (id: string) => void;
  /** Set on a split half: closes it, and the other half takes the room. */
  onClose?: () => void;
  /** Set on a phone, where the rail is a drawer: opens it. */
  onOpenRail?: () => void;
};

export function ChatHeader({
  currentAgent,
  agents = [],
  groups,
  onOpenInfo,
  onOpenGroup,
  groupOpen = false,
  onRenameAgent,
  onSelectAgent,
  onClose,
  onOpenRail,
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
      : headerModelLine(currentAgent, groups, cli ? defaults[cli] : null, t);
  const status = statusView(currentAgent, Date.now(), t);

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
      {onOpenRail ? (
        <button
          type="button"
          className="head-action head-rail"
          title={t("header.openRail")}
          aria-label={t("header.openRail")}
          onClick={onOpenRail}
        >
          <Menu />
        </button>
      ) : null}
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
        {status && status.tone !== "waiting" ? (
          <span
            className={"head-status is-" + status.tone}
            title={status.tone === "watching" ? status.text : undefined}
          >
            <span className="head-status-text">{status.text}</span>
          </span>
        ) : null}
        {currentAgent ? (
          // Mounted whatever the status, so the chip of the bot that answered
          // still glows and folds out once that answer has this bot at work.
          <WaitStatus
            key={currentAgent.id}
            ids={waitingOn(currentAgent)}
            failed={waitingFailed(currentAgent)}
            agents={agents}
            onOpen={onSelectAgent}
          />
        ) : null}
      </div>
      {currentAgent && onOpenGroup ? (
        <button
          type="button"
          className={"head-action" + (groupOpen ? " is-on" : "")}
          title={t("header.groupBots")}
          aria-label={t("header.groupBots")}
          aria-pressed={groupOpen}
          onClick={onOpenGroup}
        >
          <Users />
        </button>
      ) : null}
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
      {onClose ? (
        <button
          type="button"
          className="head-action"
          title={t("split.close")}
          aria-label={t("split.close")}
          onClick={onClose}
        >
          <X />
        </button>
      ) : null}
    </header>
  );
}
