import type { AgentInfo, ChannelInfo, Kind } from "../types";
import { Avatar } from "./Avatar";

type Props = {
  selectedKind: Kind;
  currentAgent: AgentInfo | null;
  currentChannel: ChannelInfo | null;
  agents: AgentInfo[];
  onOpenInfo: () => void;
  onPickAvatar: () => void;
};

export function ChatHeader({
  selectedKind,
  currentAgent,
  currentChannel,
  agents,
  onOpenInfo,
  onPickAvatar,
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
      {showAvatar ? (
        <Avatar
          as="button"
          className="head-avatar"
          id={avatarId}
          name={avatarName}
          src={avatarSrc}
          shape={avatarShape}
          color={avatarColor}
          letter={avatarLetter}
          status={avatarStatus}
          title={selectedKind === "agent" ? "사진 변경" : undefined}
          onClick={(e) => {
            e.stopPropagation();
            if (selectedKind === "agent") onPickAvatar();
          }}
        />
      ) : null}
      <div className="head">
        <button
          type="button"
          className={"head-title" + (clickable ? "" : " static")}
          title={clickable ? "에이전트 정보" : undefined}
          onClick={() => {
            if (clickable) onOpenInfo();
          }}
        >
          {title}
        </button>
        {meta ? <div className="head-meta">{meta}</div> : null}
      </div>
    </header>
  );
}
