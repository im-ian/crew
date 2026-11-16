import { useEffect, useRef } from "react";
import { useT } from "../LocaleContext";
import type { AgentInfo } from "../types";
import { Avatar } from "./Avatar";

type Props = {
  /** The bots waited on, in the order they were asked (`waitingOn`). */
  ids: readonly string[];
  agents: readonly AgentInfo[];
};

function find(agents: readonly AgentInfo[], id: string): AgentInfo | undefined {
  return agents.find((a) => a.id === id);
}

function nameOf(agents: readonly AgentInfo[], id: string): string {
  const a = find(agents, id);
  return a?.name || a?.id || id;
}

/** A still face for a chip: the face, without its status motion. */
function ChipFace({ agents, id }: { agents: readonly AgentInfo[]; id: string }) {
  const a = find(agents, id);
  return (
    <Avatar
      as="span"
      id={id}
      name={nameOf(agents, id)}
      src={a?.avatar}
      shape={a?.avatar_shape}
      color={a?.avatar_color}
    />
  );
}

/**
 * The chat header's "waiting" status: every bot waited on, a small face and
 * name each, none folded away. One line whatever their number: past the
 * header's width the chips scroll sideways, and the count stays put.
 */
export function WaitStatus({ ids, agents }: Props) {
  const t = useT();
  const scroll = useRef<HTMLSpanElement>(null);
  // A wheel or trackpad moves down; the chips run sideways.
  useEffect(() => {
    const el = scroll.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth + 1) return;
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      el.scrollLeft += e.deltaY;
      e.preventDefault();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);
  if (!ids.length) return null;
  return (
    <span className="head-status is-waiting">
      <span className="head-status-text">
        {t("header.statusWaiting")}
        {ids.length > 1 ? <b>{ids.length}</b> : null}
      </span>
      <span className="wait-scroll" ref={scroll}>
        <span className="wait-chips">
          {ids.map((id) => {
            const label = t("header.waitingOn", { name: nameOf(agents, id) });
            return (
              <span key={id} className="wait-chip" data-id={id} title={label} aria-label={label}>
                <ChipFace agents={agents} id={id} />
                <span className="wait-chip-name">{nameOf(agents, id)}</span>
              </span>
            );
          })}
        </span>
      </span>
    </span>
  );
}

/**
 * The sidebar's small mark beside a bot's name: the first bot it waits on,
 * and how many more. The last-message line under it stays as it was.
 */
export function WaitTag({ ids, agents }: Props) {
  const t = useT();
  if (!ids.length) return null;
  const first = nameOf(agents, ids[0]);
  const label = t("header.waitingOn", {
    name: ids.length > 1 ? `${first} +${ids.length - 1}` : first,
  });
  return (
    <span
      className={"wait-tag" + (ids.length === 1 ? " is-single" : "")}
      title={label}
      aria-label={label}
    >
      <ChipFace agents={agents} id={ids[0]} />
      <span className="wait-tag-name">{first}</span>
      {ids.length > 1 ? <span className="wait-tag-more">+{ids.length - 1}</span> : null}
    </span>
  );
}
