import type { AgentInfo } from "../types";
import { mentionLabel } from "../mentions";
import { Avatar } from "./Avatar";

type Props = {
  agent: AgentInfo;
  onClick?: (id: string) => void;
};

export function MentionChip({ agent, onClick }: Props) {
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
