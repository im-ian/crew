import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { resolveFace } from "../avatar";
import { useT } from "../LocaleContext";
import type { AgentInfo } from "../types";
import {
  CHIP_LEAVE_MS,
  chipRhythm,
  initialChips,
  liveIds,
  nextChips,
  SIDE_CHIPS,
  settleChips,
  type WaitChip,
} from "../waitChips";
import { askingAmong, waitingUserPhrase } from "../statusView";
import { Avatar } from "./Avatar";

type Props = {
  /** The bots waited on, in the order they were asked (`waitingOn`). */
  ids: readonly string[];
  agents: readonly AgentInfo[];
};

type StatusProps = Props & {
  /** Opens a waited-on bot's chat: the header's chips are buttons. */
  onOpen?: (id: string) => void;
};

function find(agents: readonly AgentInfo[], id: string): AgentInfo | undefined {
  return agents.find((a) => a.id === id);
}

function nameOf(agents: readonly AgentInfo[], id: string): string {
  const a = find(agents, id);
  return a?.name || a?.id || id;
}

/** The colour a chip glows in as its bot answers: that bot's face colour. */
function colorOf(agents: readonly AgentInfo[], id: string): string {
  const a = find(agents, id);
  return resolveFace(id, a?.avatar_shape, a?.avatar_color).color;
}

function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * The chips for `ids` as they come and go (`nextChips`). A chip whose bot
 * answered stays, leaving, until its fold is over. `refFor` measures a chip
 * so it folds from the width it had.
 */
function useWaitChips(ids: readonly string[]) {
  const els = useRef(new Map<string, HTMLElement>());
  const [chips, setChips] = useState<WaitChip[]>(() => initialChips(ids));
  const key = ids.join("\n");
  useEffect(() => {
    setChips((cur) =>
      nextChips(cur, ids, reducedMotion(), (id) => els.current.get(id)?.getBoundingClientRect().width),
    );
    // `key` stands for `ids`.
  }, [key]);
  const leaving = chips.filter((c) => c.leaving).map((c) => c.id).join("\n");
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => setChips(settleChips), CHIP_LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [leaving]);
  const refFor = (id: string) => (el: HTMLElement | null) => {
    if (el) els.current.set(id, el);
    else els.current.delete(id);
  };
  return { chips, refFor };
}

/**
 * Three dots before the chips, lit one after another towards them, so the
 * last lights as the first chip breathes. Same `--cycle` as the chips.
 */
function Relay() {
  return (
    <span className="wait-relay" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

/**
 * The chips of one line, header or sidebar: each with its bot's colour
 * (`--c`), the width it folds from (`--w`), and its place in the breathing
 * wave (`--d`). `withName` puts the name beside the face. With `onOpen` a
 * chip is a button that opens its bot's chat; the sidebar's stay marks,
 * since the whole row there is the button.
 */
function ChipList({
  chips,
  agents,
  refFor,
  withName,
  onOpen,
}: {
  chips: readonly WaitChip[];
  agents: readonly AgentInfo[];
  refFor: (id: string) => (el: HTMLElement | null) => void;
  withName: boolean;
  onOpen?: (id: string) => void;
}) {
  const t = useT();
  const live = liveIds(chips);
  const { delay } = chipRhythm(live.length);
  return (
    <span className="wait-chips">
      {chips.map((chip) => {
        const name = nameOf(agents, chip.id);
        const agent = find(agents, chip.id);
        const asking = !!agent?.asking && !agent.remote;
        const at = live.indexOf(chip.id);
        const style = {
          ["--c" as string]: colorOf(agents, chip.id),
          ...(chip.width ? { ["--w" as string]: `${chip.width}px` } : null),
          ...(at >= 0 ? { ["--d" as string]: `${delay(at)}s` } : null),
        };
        const className =
          "wait-chip" +
          (chip.entering ? " is-entering" : "") +
          (chip.leaving ? " is-leaving" : "") +
          (asking ? " is-asking" : "");
        const userLine = asking ? t("header.waitingUser", { name }) : "";
        const body = (
          <>
            <ChipFace agents={agents} id={chip.id} />
            {withName ? <span className="wait-chip-name">{name}</span> : null}
          </>
        );
        // A bot this window does not know has no chat to open.
        if (onOpen && agent) {
          return (
            <button
              key={chip.id}
              ref={refFor(chip.id)}
              type="button"
              className={className}
              data-id={chip.id}
              style={style}
              title={asking ? userLine : name}
              aria-label={asking ? userLine : t("header.waitingOnOpen", { name })}
              tabIndex={chip.leaving ? -1 : undefined}
              onClick={() => onOpen(chip.id)}
            >
              {body}
            </button>
          );
        }
        return (
          <span
            key={chip.id}
            ref={refFor(chip.id)}
            className={className}
            data-id={chip.id}
            style={style}
            role="img"
            title={asking ? userLine : name}
            aria-label={asking ? userLine : t("header.waitingOn", { name })}
          >
            {body}
          </span>
        );
      })}
    </span>
  );
}

/** The breathing cycle for a line of these chips, as a style. */
function cycleStyle(chips: readonly WaitChip[]) {
  return { ["--cycle" as string]: `${chipRhythm(liveIds(chips).length).cycle}s` };
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
 * out; the last one fades the line, even once the answer has the bot at
 * work again. Keyed by the bot whose header it is, so opening another chat
 * draws its line at once. Three dots between the count and the chips run
 * towards them. A chip opens its bot's chat (`onOpen`).
 */
export function WaitStatus({ ids, agents, onOpen }: StatusProps) {
  const t = useT();
  const scroll = useRef<HTMLSpanElement>(null);
  const { chips, refFor } = useWaitChips(ids);

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
  const count = liveIds(chips).length;
  const userLine = waitingUserPhrase(askingAmong(ids, agents), t);
  return (
    <span
      className={"head-status is-waiting" + (ids.length ? "" : " is-ending")}
      style={cycleStyle(chips)}
    >
      <span className="head-status-text">
        {userLine ?? t("header.statusWaiting")}
        {!userLine && count > 1 ? <b>{count}</b> : null}
      </span>
      <Relay />
      <span className="wait-scroll" ref={scroll}>
        <ChipList chips={chips} agents={agents} refFor={refFor} withName onOpen={onOpen} />
      </span>
    </span>
  );
}

/**
 * The sidebar's mark beside a bot's name: the bots it waits on as face
 * chips, two at most, then "+N" for the rest. Each face names its bot on
 * hover, and "+N" names the rest. A chip whose bot answers glows and folds
 * out as in the header, and with the last one the dots before the chips
 * fade. The last-message line under it stays as it was.
 */
export function WaitTag({ ids, agents }: Props) {
  const t = useT();
  const { chips, refFor } = useWaitChips(ids);
  if (!chips.length) return null;
  const live = liveIds(chips);
  const hidden = live.slice(SIDE_CHIPS);
  const rest = hidden.map((id) => nameOf(agents, id)).join(", ");
  const hiddenLine = waitingUserPhrase(askingAmong(hidden, agents), t);
  const more = live.length > SIDE_CHIPS;
  return (
    <span
      className={"wait-cluster is-side" + (more ? " has-more" : "") + (ids.length ? "" : " is-ending")}
      style={cycleStyle(chips)}
    >
      <Relay />
      <ChipList chips={chips} agents={agents} refFor={refFor} withName={false} />
      {more ? (
        <span
          className="wait-more"
          role="img"
          title={hiddenLine ?? rest}
          aria-label={hiddenLine ?? t("header.waitingOn", { name: rest })}
        >
          +{live.length - SIDE_CHIPS}
        </span>
      ) : null}
    </span>
  );
}
