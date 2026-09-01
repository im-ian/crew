import type { AgentInfo, ChannelInfo } from "../types";
import { WhoButton } from "./WhoButton";

type Props = {
  currentAgent: AgentInfo | null;
  currentChannel: ChannelInfo | null;
  onOpenInfo: () => void;
  onOpenRoutines: () => void;
  onStop?: () => void;
};

export function ChatHeader({
  currentAgent,
  currentChannel,
  onOpenInfo,
  onOpenRoutines,
  onStop,
}: Props) {
  let identity = <span className="head-empty">대화를 선택하세요</span>;
  if (currentChannel) {
    identity = (
      <WhoButton
        agent={null}
        who={currentChannel.name || currentChannel.id}
        letter="#"
        fallbackId={currentChannel.id}
        title="채널 정보"
        onClick={onOpenInfo}
      />
    );
  } else if (currentAgent) {
    identity = (
      <WhoButton
        agent={currentAgent}
        who={currentAgent.name || currentAgent.id}
        title="봇 정보"
        onClick={onOpenInfo}
      />
    );
  }

  return (
    <header>
      <div className="head-identity">{identity}</div>
      {currentAgent &&
      (currentAgent.status === "working" || currentAgent.status === "blocked") &&
      onStop ? (
        <button
          type="button"
          className="head-action"
          title="중지"
          aria-label="중지"
          onClick={onStop}
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
          title="채널 설정"
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
          title="봇 설정"
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
