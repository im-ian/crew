import type { AgentInfo } from "../types";
import { useBotLabel } from "../BotLabelContext";
import { Avatar } from "./Avatar";

type Props = {
  agent?: AgentInfo;
  onClick?: (id: string) => void;
  /** For a chip drawn off the tree, where no group or open chat reaches it. */
  label?: string;
};

export function MentionChip({ agent, onClick, label: given }: Props) {
  const labelOf = useBotLabel();
  if (!agent) return null;
  const label = given ?? labelOf(agent);
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
