import type { AgentInfo, ChannelInfo } from "../types";
import { channelLabel, isBroadcast, mentionLabel } from "../mentions";
import { Avatar } from "./Avatar";

type Props = {
  agent?: AgentInfo;
  channel?: ChannelInfo;
  onClick?: (id: string) => void;
};

export function MentionChip({ agent, channel, onClick }: Props) {
  if (channel) {
    const label = channelLabel(channel);
    // A room reads as "#name"; a face for it would just be its members again.
    const inner = <span className="mention-chip-name">#{label}</span>;
    if (onClick) {
      return (
        <button
          type="button"
          className="mention-chip is-plain"
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
      <span
        className="mention-chip is-plain"
        contentEditable={false}
        data-channel={channel.id}
      >
        {inner}
      </span>
    );
  }
  if (!agent) return null;
  const label = mentionLabel(agent);
  const plain = isBroadcast(agent.id);
  const inner = plain ? (
    <span className="mention-chip-name">@{label}</span>
  ) : (
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
  const cls = "mention-chip" + (plain ? " is-plain" : "");
  if (onClick) {
    return (
      <button
        type="button"
        className={cls}
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
    <span className={cls} contentEditable={false} data-mention={agent.id}>
      {inner}
    </span>
  );
}
