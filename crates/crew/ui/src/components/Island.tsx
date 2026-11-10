import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { resolveFace } from "../avatar";
import { Check, X } from "../icons";
import { koSubject, type IslandNotice } from "../island";
import { useLocale } from "../LocaleContext";
import { useBotLabel } from "../BotLabelContext";
import type { AgentInfo } from "../types";
import { BotFace } from "./BotFace";

type Props = {
  /** Newest first: the top of the stack, right under the titlebar. */
  notices: IslandNotice[];
  agents: AgentInfo[];
  onOpenBot: (id: string) => void;
  onClose: (seq: number) => void;
  /** The pointer came onto a notice or left it: every clock stops meanwhile. */
  onHold: () => void;
  onRelease: () => void;
};

/** The island is always dark, so its colors do not follow the theme. */
const TINT: Record<IslandNotice["kind"], string> = {
  question: "#0a84ff",
  blocked: "#ffb340",
  failure: "#ff453a",
  success: "#30d158",
  ok: "#30d158",
  warn: "#ffb340",
  error: "#ff453a",
};

// Keep these in step with the transitions on .island and .island-slot in styles.css.
const OPEN_DELAY_MS = 180;
const CLOSE_MS = 650;

type Phase = "show" | "open" | "leave";

type Shown = { notice: IslandNotice; leaving: boolean };

/**
 * The notices stacked under the titlebar, newest on top. One that goes keeps
 * its place while it folds away, then the ones under it move up.
 */
export function Island({ notices, agents, onOpenBot, onClose, onHold, onRelease }: Props) {
  const [shown, setShown] = useState<Shown[]>([]);

  useEffect(() => {
    setShown((prev) => {
      const live = new Set(notices.map((n) => n.seq));
      const had = new Set(prev.map((s) => s.notice.seq));
      const fresh = notices.filter((n) => !had.has(n.seq)).map((notice) => ({ notice, leaving: false }));
      const kept = prev.map((s) => (live.has(s.notice.seq) ? s : { ...s, leaving: true }));
      return [...fresh, ...kept];
    });
  }, [notices]);

  const gone = (seq: number) => setShown((prev) => prev.filter((s) => s.notice.seq !== seq));

  if (!shown.length) return null;
  return (
    <div className="island-stack">
      {shown.map((s) => (
        <IslandPill
          key={s.notice.seq}
          notice={s.notice}
          leaving={s.leaving}
          agents={agents}
          onOpenBot={onOpenBot}
          onClose={() => onClose(s.notice.seq)}
          onGone={() => gone(s.notice.seq)}
          onHold={onHold}
          onRelease={onRelease}
        />
      ))}
    </div>
  );
}

/**
 * One notice: a pill that grows out of a dot to say one thing. About a bot,
 * it wears that bot's face with the matching expression, and a click anywhere
 * on it opens that bot's chat; otherwise a status dot.
 */
function IslandPill({
  notice,
  leaving,
  agents,
  onOpenBot,
  onClose,
  onGone,
  onHold,
  onRelease,
}: {
  notice: IslandNotice;
  leaving: boolean;
  agents: AgentInfo[];
  onOpenBot: (id: string) => void;
  onClose: () => void;
  onGone: () => void;
  onHold: () => void;
  onRelease: () => void;
}) {
  const { locale, t } = useLocale();
  const labelOf = useBotLabel();
  const [phase, setPhase] = useState<Phase>("show");
  const [width, setWidth] = useState(0);
  const rowRef = useRef<HTMLDivElement>(null);
  const hovered = useRef(false);
  const releaseRef = useRef(onRelease);
  releaseRef.current = onRelease;
  const goneRef = useRef(onGone);
  goneRef.current = onGone;
  const shown = notice;

  useEffect(() => {
    if (leaving) {
      setPhase("leave");
      const off = window.setTimeout(() => goneRef.current(), CLOSE_MS);
      return () => window.clearTimeout(off);
    }
    const grow = window.setTimeout(() => setPhase("open"), OPEN_DELAY_MS);
    return () => window.clearTimeout(grow);
  }, [leaving]);

  const bot =
    "botId" in shown ? (agents.find((a) => a.id === shown.botId) ?? null) : null;
  const name = bot ? labelOf(bot) : "";

  // Open exactly as wide as what it says.
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (row) setWidth(row.offsetWidth);
  }, [shown, name, locale, bot?.avatar]);

  // The pointer only holds the island while it can be pointed at. Folding
  // away, gone, or the window put aside sends no mouseleave, so let go here.
  const live = phase !== "leave" && !("botId" in shown && !bot);
  useEffect(() => {
    const letGo = () => {
      if (!hovered.current) return;
      hovered.current = false;
      releaseRef.current();
    };
    if (!live) {
      letGo();
      return;
    }
    window.addEventListener("blur", letGo);
    return () => {
      window.removeEventListener("blur", letGo);
      letGo();
    };
  }, [live]);

  // A bot removed meanwhile has nothing left to say; its notice goes.
  useEffect(() => {
    if ("botId" in shown && !bot && !leaving) onClose();
  }, [!!bot]);
  if ("botId" in shown && !bot) return null;

  const kind = shown.kind;
  const stays = shown.stays;
  let lead;
  let words;
  let full: string;
  if (bot && "botId" in shown) {
    const said = t(`island.${shown.kind}`);
    const face = resolveFace(bot.id, bot.avatar_shape, bot.avatar_color);
    lead = bot.avatar ? (
      <img className="island-img" src={bot.avatar} alt="" />
    ) : (
      <BotFace
        id={bot.id}
        shape={face.shape}
        color={face.color}
        className="island-face"
        status={kind === "blocked" ? "blocked" : "idle"}
        mood={shown.kind === "blocked" ? null : shown.kind}
      />
    );
    const who = locale === "ko" ? koSubject(name) : name;
    words = (
      <>
        <b>{who}</b> <span>{said}</span>
      </>
    );
    full = `${who} ${said}`;
  } else {
    lead = <span className="island-dot" />;
    words = "text" in shown ? shown.text : "";
    full = words;
  }

  return (
    <div className={"island-slot" + (phase === "leave" ? " is-leaving" : "")}>
    <div
      className={
        "island" +
        (phase === "open" ? " is-open" : "") +
        (phase === "leave" ? " is-leaving" : "") +
        (bot ? " is-link" : "")
      }
      style={{ "--k": TINT[kind], "--w": `${width}px` } as CSSProperties}
      role={kind === "error" ? "alert" : "status"}
      title={full}
      onClick={bot ? () => onOpenBot(bot.id) : undefined}
      onMouseEnter={() => {
        if (!live || hovered.current) return;
        hovered.current = true;
        onHold();
      }}
      onMouseLeave={() => {
        if (!hovered.current) return;
        hovered.current = false;
        onRelease();
      }}
    >
      <div className="island-row" ref={rowRef}>
        <span className="island-lead">{lead}</span>
        <span className="island-words">{words}</span>
        <span className="island-acts">
          {kind === "success" || kind === "ok" ? (
            <span className="island-check">
              <Check size={15} />
            </span>
          ) : null}
          {bot ? (
            // Its click goes up to the pill, which opens the chat.
            <button type="button" className="island-go">
              {t("island.go")}
            </button>
          ) : null}
          {stays ? (
            <button
              type="button"
              className="island-x"
              title={t("common.close")}
              aria-label={t("common.close")}
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
            >
              <X size={14} />
            </button>
          ) : null}
        </span>
      </div>
    </div>
    </div>
  );
}
