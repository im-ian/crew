import type { MentionRun } from "../mentions";
import type { AgentInfo } from "../types";
import { useBotLabel } from "../BotLabelContext";
import { Hash } from "../icons";
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

/**
 * A `#group` the way a bot's chip reads, with a hash where the face goes.
 * Naming a group wakes none of its bots, so there is nothing to click.
 */
export function GroupChip({ id, name }: { id: string; name: string }) {
  return (
    <span className="mention-chip" contentEditable={false} data-group={id} title={name}>
      <span className="mention-chip-avatar group-face" aria-hidden>
        <Hash size={11} strokeWidth={2.5} />
      </span>
      <span className="mention-chip-name">{name}</span>
    </span>
  );
}

/** Preview text with its handles drawn as chips. */
export function MentionRunsView({ runs }: { runs: readonly MentionRun[] }) {
  return (
    <>
      {runs.map((run, i) =>
        run.agent ? (
          <MentionChip key={i} agent={run.agent} />
        ) : run.group ? (
          <GroupChip key={i} id={run.group.id} name={run.group.name} />
        ) : (
          <span key={i}>{run.text}</span>
        ),
      )}
    </>
  );
}
