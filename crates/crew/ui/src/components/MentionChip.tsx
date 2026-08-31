import type { AgentInfo } from "../types";
import { mentionLabel } from "../mentions";
import { Avatar } from "./Avatar";

export function MentionChip({ agent }: { agent: AgentInfo }) {
  const label = mentionLabel(agent);
  return (
    <span className="mention-chip" contentEditable={false} data-mention={agent.id}>
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
    </span>
  );
}
