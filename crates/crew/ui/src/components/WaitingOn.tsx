import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { resolveFace } from "../avatar";
import { useT } from "../LocaleContext";
import type { AgentInfo } from "../types";
import {
  CHIP_LEAVE_MS,
  chipCount,
  initialChips,
  nextChips,
  settleChips,
  type WaitChip,
} from "../waitChips";
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

function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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

/** Fades the side of the chip line that has more to scroll to. */
function syncFade(el: HTMLElement | null) {
  if (!el) return;
  const over = el.scrollWidth > el.clientWidth + 1;
  el.classList.toggle("fade-r", over && el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
  el.classList.toggle("fade-l", over && el.scrollLeft > 2);
}

/**
 * The chat header's "waiting" status: every bot waited on, a small face and
 * name each, none folded away. One line whatever their number: past the
 * header's width the chips scroll sideways, the edge with more fades, and
 * the count stays put. A bot that answers glows in its colour and folds
 * out; the last one fades the line. Keyed by the bot whose header it is, so
 * opening another chat draws its line at once.
 */
export function WaitStatus({ ids, agents }: Props) {
  const t = useT();
  const scroll = useRef<HTMLSpanElement>(null);
  const chipEls = useRef(new Map<string, HTMLSpanElement>());
  const [chips, setChips] = useState<WaitChip[]>(() => initialChips(ids));
  const key = ids.join("\n");

  useEffect(() => {
    setChips((cur) =>
      nextChips(cur, ids, reducedMotion(), (id) => chipEls.current.get(id)?.getBoundingClientRect().width),
    );
    // `key` stands for `ids`.
  }, [key]);

  const leaving = chips.filter((c) => c.leaving).map((c) => c.id).join("\n");
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => setChips(settleChips), CHIP_LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [leaving]);

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
    const fade = () => syncFade(el);
    const ro = new ResizeObserver(fade);
    ro.observe(el);
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("scroll", fade, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("scroll", fade);
    };
  }, [chips.length > 0]);

  useLayoutEffect(() => {
    syncFade(scroll.current);
  });

  if (!chips.length) return null;
  const count = chipCount(chips);
  return (
    <span className={"head-status is-waiting" + (ids.length ? "" : " is-ending")}>
      <span className="head-status-text">
        {t("header.statusWaiting")}
        {count > 1 ? <b>{count}</b> : null}
      </span>
      <span className="wait-scroll" ref={scroll}>
        <span className="wait-chips">
          {chips.map((chip) => {
            const a = find(agents, chip.id);
            const color = resolveFace(chip.id, a?.avatar_shape, a?.avatar_color).color;
            const label = t("header.waitingOn", { name: nameOf(agents, chip.id) });
            const style = {
              ["--c" as string]: color,
              ...(chip.width ? { ["--w" as string]: `${chip.width}px` } : null),
            };
            return (
              <span
                key={chip.id}
                ref={(el) => {
                  if (el) chipEls.current.set(chip.id, el);
                  else chipEls.current.delete(chip.id);
                }}
                className={
                  "wait-chip" +
                  (chip.entering ? " is-entering" : "") +
                  (chip.leaving ? " is-leaving" : "")
                }
                data-id={chip.id}
                style={style}
                title={label}
                aria-label={label}
              >
                <ChipFace agents={agents} id={chip.id} />
                <span className="wait-chip-name">{nameOf(agents, chip.id)}</span>
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
