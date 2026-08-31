import type { AgentInfo, ChannelInfo } from "../types";
import { Avatar } from "./Avatar";

type Props = {
  currentAgent: AgentInfo | null;
  currentChannel: ChannelInfo | null;
  agents: AgentInfo[];
  onOpenInfo: () => void;
  onOpenRoutines: () => void;
};

export function ChatHeader({
  currentAgent,
  currentChannel,
  agents,
  onOpenInfo,
  onOpenRoutines,
}: Props) {
  let title = "대화를 선택하세요";
  let meta = "";
  let clickable = false;
  let showAvatar = false;
  let avatarId: string | undefined;
  let avatarName: string | undefined;
  let avatarSrc: string | null | undefined;
  let avatarShape: string | null | undefined;
  let avatarColor: string | null | undefined;
  let avatarLetter: string | undefined;
  let avatarStatus: AgentInfo["status"] | undefined;

  if (currentChannel) {
    title = currentChannel.name || currentChannel.id;
    meta =
      (currentChannel.members || [])
        .map((id) => {
          const a = agents.find((x) => x.id === id);
          return a ? a.name || a.id : id;
        })
        .join(", ") || "멤버 없음";
    showAvatar = true;
    avatarId = currentChannel.id;
    avatarName = currentChannel.name || currentChannel.id;
    avatarLetter = "#";
  } else if (currentAgent) {
    title = currentAgent.name || currentAgent.id;
    meta = [currentAgent.title, currentAgent.role].filter(Boolean).join(" · ");
    clickable = true;
    showAvatar = true;
    avatarId = currentAgent.id;
    avatarName = currentAgent.name || currentAgent.id;
    avatarSrc = currentAgent.avatar;
    avatarShape = currentAgent.avatar_shape;
    avatarColor = currentAgent.avatar_color;
    avatarStatus = currentAgent.status;
  }

  return (
    <header>
      <div className="head-identity">
        {showAvatar ? (
          <Avatar
            className="head-avatar"
            id={avatarId}
            name={avatarName}
            src={avatarSrc}
            shape={avatarShape}
            color={avatarColor}
            letter={avatarLetter}
            status={avatarStatus}
          />
        ) : null}
        <div className="head">
          <button
            type="button"
            className={"head-title" + (clickable ? "" : " static")}
            title={clickable ? "봇 정보" : undefined}
            onClick={() => {
              if (clickable) onOpenInfo();
            }}
          >
            {title}
          </button>
          {meta ? <div className="head-meta">{meta}</div> : null}
        </div>
      </div>
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
