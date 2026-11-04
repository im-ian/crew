import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { resolveFace } from "../avatar";
import { Check, X } from "../icons";
import { koSubject, noticeStays, type IslandNotice } from "../island";
import { useLocale } from "../LocaleContext";
import { useBotLabel } from "../BotLabelContext";
import type { AgentInfo } from "../types";
import { BotFace } from "./BotFace";

type Props = {
  notice: IslandNotice | null;
  visible: boolean;
  agents: AgentInfo[];
  onOpenBot: (id: string) => void;
  onClose: () => void;
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

// Keep these in step with the transitions on .island in styles.css.
const OPEN_DELAY_MS = 180;
const CLOSE_MS = 450;
const SWAP_MS = 130;

type Phase = "off" | "show" | "open" | "leave";

/**
 * A pill at the top center of the window that grows out of a dot to say one
 * thing. About a bot, it wears that bot's face with the matching expression;
 * otherwise a status dot. A new notice while it is open changes the words in
 * place instead of closing and opening again.
 */
export function Island({ notice, visible, agents, onOpenBot, onClose }: Props) {
  const { locale, t } = useLocale();
  const labelOf = useBotLabel();
  const [phase, setPhase] = useState<Phase>("off");
  const [shown, setShown] = useState<IslandNotice | null>(null);
  const [swap, setSwap] = useState(false);
  const [width, setWidth] = useState(0);
  const phaseRef = useRef<Phase>("off");
  phaseRef.current = phase;
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!visible || !notice) {
      if (phaseRef.current === "off") return;
      setPhase("leave");
      const off = window.setTimeout(() => setPhase("off"), CLOSE_MS);
      return () => window.clearTimeout(off);
    }
    if (phaseRef.current === "open") {
      // The words fade out, the width moves, the new words fade in. The new
      // content goes in now, so a cancelled timer cannot leave them faded out.
      setSwap(true);
      setShown(notice);
      const back = window.setTimeout(() => setSwap(false), SWAP_MS);
      return () => {
        window.clearTimeout(back);
        setSwap(false);
      };
    }
    setShown(notice);
    setSwap(false);
    setPhase("show");
    const grow = window.setTimeout(() => setPhase("open"), OPEN_DELAY_MS);
    return () => window.clearTimeout(grow);
  }, [visible, notice?.seq]);

  const bot =
    shown && "botId" in shown ? (agents.find((a) => a.id === shown.botId) ?? null) : null;
  const name = bot ? labelOf(bot) : "";

  // Open exactly as wide as what it says.
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (row) setWidth(row.offsetWidth);
  }, [shown, name, locale, bot?.avatar]);

  if (phase === "off" || !shown) return null;
  if ("botId" in shown && !bot) return null;

  const kind = shown.kind;
  const stays = noticeStays(kind);
  let lead;
  let words;
  let full: string;
  let action: string | null = null;
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
    action = kind === "question" ? t("island.answer") : kind === "success" ? null : t("island.open");
  } else {
    lead = <span className="island-dot" />;
    words = "text" in shown ? shown.text : "";
    full = words;
  }

  return (
    <div
      className={
        "island" +
        (phase === "open" ? " is-open" : "") +
        (phase === "leave" ? " is-leaving" : "") +
        (swap ? " is-swap" : "")
      }
      style={{ "--k": TINT[kind], "--w": `${width}px` } as CSSProperties}
      role={kind === "error" ? "alert" : "status"}
      title={full}
    >
      <div className="island-row" ref={rowRef}>
        <span className="island-lead">{lead}</span>
        <span className="island-words">{words}</span>
        <span className="island-acts">
          {kind === "success" || kind === "ok" ? (
            <span className="island-check">
              <Check size={13} />
            </span>
          ) : null}
          {action && bot ? (
            <button type="button" className="island-go" onClick={() => onOpenBot(bot.id)}>
              {action}
            </button>
          ) : null}
          {stays ? (
            <button
              type="button"
              className="island-x"
              title={t("common.close")}
              aria-label={t("common.close")}
              onClick={onClose}
            >
              <X size={12} />
            </button>
          ) : null}
        </span>
      </div>
    </div>
  );
}
