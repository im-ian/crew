import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { resolveFace } from "../avatar";
import { Check, ChevronDown, ChevronUp, X } from "../icons";
import { koSubject, mostPressing, type IslandNotice } from "../island";
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
  /** Closes everything in the pile at once. */
  onClearPile: () => void;
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
 * The notices under the titlebar. A new one gets a row of its own; one that
 * stays folds after a while into the pile at the top, so a long day of
 * notices takes one row. New rows open under the pile, newest first. One that
 * goes keeps its place while it folds away, then the ones under it move up.
 */
export function Island({
  notices,
  agents,
  onOpenBot,
  onClose,
  onClearPile,
  onHold,
  onRelease,
}: Props) {
  const [shown, setShown] = useState<Shown[]>([]);
  const [pileOpen, setPileOpen] = useState(false);
  const piled = notices.filter((n) => n.piled);

  useEffect(() => {
    const rows = notices.filter((n) => !n.piled);
    setShown((prev) => {
      const live = new Set(rows.map((n) => n.seq));
      const had = new Set(prev.map((s) => s.notice.seq));
      const fresh = rows.filter((n) => !had.has(n.seq)).map((notice) => ({ notice, leaving: false }));
      const kept = prev.map((s) => (live.has(s.notice.seq) ? s : { ...s, leaving: true }));
      return [...fresh, ...kept];
    });
  }, [notices]);

  useEffect(() => {
    if (!piled.length) setPileOpen(false);
  }, [piled.length]);

  const rowSeqs = new Set(shown.map((s) => s.notice.seq));
  const gone = (seq: number) => setShown((prev) => prev.filter((s) => s.notice.seq !== seq));
  const pill = (notice: IslandNotice, leaving: boolean) => (
    <IslandPill
      key={notice.seq}
      notice={notice}
      leaving={leaving}
      agents={agents}
      onOpenBot={onOpenBot}
      onClose={() => onClose(notice.seq)}
      onGone={() => gone(notice.seq)}
      onHold={onHold}
      onRelease={onRelease}
    />
  );

  if (!shown.length && !piled.length) return null;
  return (
    <div className="island-stack">
      {piled.length ? (
        <IslandPile
          notices={piled}
          agents={agents}
          open={pileOpen}
          onToggle={() => setPileOpen((o) => !o)}
          onClear={onClearPile}
        />
      ) : null}
      {pileOpen ? (
        <div className="island-pile-list">
          {/* One still folding out of its row joins the list once it is gone. */}
          {piled.filter((n) => !rowSeqs.has(n.seq)).map((n) => pill(n, false))}
        </div>
      ) : null}
      {shown.map((s) => pill(s.notice, s.leaving))}
    </div>
  );
}

/**
 * The pile: one pill that says how many notices folded into it, with the
 * faces of the bots they are about and two edges under it, like a stack of
 * cards. A click lays them out under it, and the ✕ clears them all.
 */
function IslandPile({
  notices,
  agents,
  open,
  onToggle,
  onClear,
}: {
  notices: IslandNotice[];
  agents: AgentInfo[];
  open: boolean;
  onToggle: () => void;
  onClear: () => void;
}) {
  const { locale, t } = useLocale();
  const [width, setWidth] = useState(0);
  const rowRef = useRef<HTMLDivElement>(null);
  const bots: AgentInfo[] = [];
  for (const n of notices) {
    if (!("botId" in n) || bots.some((b) => b.id === n.botId)) continue;
    const bot = agents.find((a) => a.id === n.botId);
    if (bot) bots.push(bot);
    if (bots.length === 3) break;
  }
  // The most pressing kind in it tints the pile, so a waiting question shows through.
  const tint = TINT[mostPressing(notices)];
  const label = t("island.pile", { n: notices.length });

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (row) setWidth(row.offsetWidth);
  }, [notices.length, bots.map((b) => b.id).join(), locale, open]);

  return (
    <div
      className={"island-slot island-pile-slot" + (open ? " is-open" : "")}
      style={{ "--k": tint, "--w": `${width}px` } as CSSProperties}
    >
      <span className="island-ghost island-ghost-2" aria-hidden />
      <span className="island-ghost island-ghost-1" aria-hidden />
      <div
        className="island is-open is-link island-pile"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        title={open ? t("island.pileClose") : t("island.pileOpen")}
        onClick={onToggle}
        onKeyDown={(e) => {
          // The ✕ inside handles its own keys.
          if (e.target !== e.currentTarget) return;
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          onToggle();
        }}
      >
        <div className="island-row" ref={rowRef}>
          <span className="island-lead island-faces">
            {bots.length ? (
              bots.map((bot) => {
                const face = resolveFace(bot.id, bot.avatar_shape, bot.avatar_color);
                return bot.avatar ? (
                  <img key={bot.id} className="island-img" src={bot.avatar} alt="" />
                ) : (
                  <BotFace
                    key={bot.id}
                    id={bot.id}
                    shape={face.shape}
                    color={face.color}
                    className="island-face"
                    status="idle"
                  />
                );
              })
            ) : (
              <span className="island-dot" />
            )}
          </span>
          <span className="island-words">
            <b>{label}</b>
          </span>
          <span className="island-acts">
            <span className="island-chev">{open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}</span>
            <button
              type="button"
              className="island-x"
              title={t("island.clearAll")}
              aria-label={t("island.clearAll")}
              onClick={(e) => {
                e.stopPropagation();
                onClear();
              }}
            >
              <X size={14} />
            </button>
          </span>
        </div>
      </div>
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
    "botId" in notice ? (agents.find((a) => a.id === notice.botId) ?? null) : null;
  const name = bot ? labelOf(bot) : "";

  // Open exactly as wide as what it says.
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (row) setWidth(row.offsetWidth);
  }, [notice, name, locale, bot?.avatar]);

  // The pointer only holds the island while it can be pointed at. Folding
  // away, gone, or the window put aside sends no mouseleave, so let go here.
  const live = phase !== "leave" && !("botId" in notice && !bot);
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

  // A bot missing from the list draws nothing. Gone for good, the island
  // closes its notices (useCrew's noticeBots); a list that blinks empty does not.
  if ("botId" in notice && !bot) return null;

  const kind = notice.kind;
  const stays = notice.stays;
  let lead;
  let words;
  let full: string;
  if (bot && "botId" in notice) {
    const said = t(`island.${notice.kind}`);
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
        mood={notice.kind === "blocked" ? null : notice.kind}
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
    words = "text" in notice ? notice.text : "";
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
        <span className={"island-lead" + (bot ? "" : " is-dot")}>{lead}</span>
        <span className="island-words">{words}</span>
        <span className="island-acts">
          {kind === "success" || kind === "ok" ? (
            <span className="island-check">
              <Check size={15} />
            </span>
          ) : null}
          {bot ? (
            // Its click goes up to the pill, which opens the chat.
            <button
              type="button"
              className="island-go"
              onMouseDown={(e) => {
                if (e.button === 0) e.preventDefault();
              }}
            >
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
