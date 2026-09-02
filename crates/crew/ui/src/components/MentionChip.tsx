import type { AgentInfo, ChannelInfo } from "../types";
import { channelLabel, mentionLabel } from "../mentions";
import { Avatar } from "./Avatar";

type Props = {
  agent?: AgentInfo;
  channel?: ChannelInfo;
  onClick?: (id: string) => void;
};

export function MentionChip({ agent, channel, onClick }: Props) {
  if (channel) {
    const label = channelLabel(channel);
    const inner = (
      <>
        <Avatar
          as="span"
          className="mention-chip-avatar"
          id={channel.id}
          name={label}
          letter="#"
        />
        <span className="mention-chip-name">{label}</span>
      </>
    );
    if (onClick) {
      return (
        <button
          type="button"
          className="mention-chip"
          contentEditable={false}
          data-channel={channel.id}
          title={"#" + label}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onClick(channel.id);
          }}
        >
          {inner}
        </button>
      );
    }
    return (
      <span className="mention-chip" contentEditable={false} data-channel={channel.id}>
        {inner}
      </span>
    );
  }
  if (!agent) return null;
  const label = mentionLabel(agent);
  const inner = (
    <>
      <Avatar
        as="span"
        className="mention-chip-avatar"
        id={agent.id}
        name={label}
        src={agent.avatar}
        shape={agent.avatar_shape}
        color={agent.avatar_color}
      />
      <span className="mention-chip-name">{label}</span>
    </>
  );
  if (onClick) {
    return (
      <button
        type="button"
        className="mention-chip"
        contentEditable={false}
        data-mention={agent.id}
        title={label}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onClick(agent.id);
        }}
      >
        {inner}
      </button>
    );
  }
  return (
    <span className="mention-chip" contentEditable={false} data-mention={agent.id}>
      {inner}
    </span>
  );
}
