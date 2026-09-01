import { busyInChannel, isBusyStatus } from "../busy";
import type { AgentInfo, ChannelInfo } from "../types";
import { WhoButton } from "./WhoButton";

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
  const busy = busyInChannel(agents, currentChannel?.id);
  const stopIds = currentChannel
    ? busy.filter((a) => a.status === "working").map((a) => a.id)
    : currentAgent && isBusyStatus(currentAgent.status)
      ? [currentAgent.id]
      : [];

  let identity = <span className="head-empty">대화를 선택하세요</span>;
  if (currentChannel) {
    identity = (
      <WhoButton
        agent={null}
        who={currentChannel.name || currentChannel.id}
        letter="#"
        fallbackId={currentChannel.id}
        title="채널 정보 ⌘I"
        onClick={onOpenInfo}
      />
    );
  } else if (currentAgent) {
    identity = (
      <WhoButton
        agent={currentAgent}
        who={currentAgent.name || currentAgent.id}
        title="봇 정보 ⌘I"
        onClick={onOpenInfo}
      />
    );
  }

  return (
    <header>
      <div className="head-identity">{identity}</div>
      {busy.length ? (
        <div className="head-busy" aria-label="작업 중인 멤버">
          {busy.slice(0, 6).map((a) => (
            <WhoButton
              key={a.id}
              agent={a}
              who={a.name || a.id}
              title={
                a.status === "blocked"
                  ? `${a.name || a.id} 확인이 필요합니다`
                  : `${a.name || a.id} 작업 중`
              }
            />
          ))}
        </div>
      ) : null}
      {stopIds.length && onStop ? (
        <button
          type="button"
          className="head-action is-stop"
          title="중지 ⌘."
          aria-label="중지"
          onClick={() => {
            for (const id of stopIds) onStop(id);
          }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="4" y="4" width="8" height="8" rx="1.2" fill="currentColor" />
          </svg>
        </button>
      ) : null}
      {currentChannel ? (
        <button
          type="button"
          className="head-action"
          title="채널 설정 ⌘I"
          aria-label="채널 설정"
          onClick={onOpenInfo}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.4" />
            <path
              d="M8 7.15v4.1"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
            <circle cx="8" cy="5.2" r="0.85" fill="currentColor" />
          </svg>
        </button>
      ) : null}
      {currentAgent ? (
        <button
          type="button"
          className="head-action"
          title="봇 설정 ⌘⇧R"
          aria-label="봇 설정"
          onClick={onOpenRoutines}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.4" />
            <path
              d="M8 7.15v4.1"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
            <circle cx="8" cy="5.2" r="0.85" fill="currentColor" />
          </svg>
        </button>
      ) : null}
    </header>
  );
}
