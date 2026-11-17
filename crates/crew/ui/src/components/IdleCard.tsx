import { useT } from "../LocaleContext";
import { clockLabel } from "../clock";
import { formatAgo, stalledMinutes } from "../idleSummary";
import type { IdleCard as IdleCardData, IdleState } from "../idleTypes";
import type { TFn } from "../i18n";
import { ChevronDown } from "../icons";

type Props = {
  card: IdleCardData;
  locale: string;
  now: number;
  /** A folded pill opened back into the card. A live card is always open. */
  expanded: boolean;
  details: boolean;
  onExpand: () => void;
  onDetails: () => void;
};

export function IdleCard({
  card,
  locale,
  now,
  expanded,
  details,
  onExpand,
  onDetails,
}: Props) {
  const t = useT();
  const minutes = card.live ? stalledMinutes(card.activityTs, now) : card.minutes;
  if (!card.live && !expanded) {
    return (
      <div className="idle-slot">
        <button
          type="button"
          className={"idle-folded s-" + card.state}
          aria-expanded={false}
          onClick={onExpand}
        >
          <span className="dot" />
          <b>{stateLabel(card.state, t)}</b>
          <span className="sep">·</span>
          <span>{formatAgo(minutes, false, t)}</span>
          <span className="sep">·</span>
          <span className="idle-hint">{card.hint}</span>
          <ChevronDown size={14} />
        </button>
      </div>
    );
  }
  const when = clockLabel(card.activityTs, locale);
  return (
    <div className="idle-slot">
      <div className={"idle-card s-" + card.state + (details ? " open" : "")}>
        <div className="idle-head">
          <span className="state">
            <span className="dot" />
            {stateLabel(card.state, t)}
          </span>
          <span className="sep">·</span>
          <span className="ago">{formatAgo(minutes, true, t)}</span>
          {when ? (
            <span className="when">{t("idle.when", { time: when })}</span>
          ) : null}
        </div>
        {card.paragraphs.map((line, i) => (
          <p className="idle-sum" key={i}>
            {line.map((span, j) =>
              span.code ? (
                <code key={j}>{span.t}</code>
              ) : span.strong ? (
                <b key={j}>{span.t}</b>
              ) : (
                <span key={j}>{span.t}</span>
              ),
            )}
          </p>
        ))}
        {card.detail ? (
          <button
            type="button"
            className="idle-more"
            aria-expanded={details}
            onClick={onDetails}
          >
            {t("idle.more")}
            <ChevronDown size={14} />
          </button>
        ) : null}
        {card.detail && details ? (
          <dl className="idle-detail">
            {card.detail.task ? (
              <>
                <dt>{t("idle.task")}</dt>
                <dd>
                  {card.detail.task.who} · {card.detail.task.what}
                </dd>
              </>
            ) : null}
            {card.detail.steps.length ? (
              <>
                <dt>{t("idle.did")}</dt>
                <dd>
                  <ol>
                    {card.detail.steps.map((step, i) => (
                      <li key={i} className={step.stop ? "stop" : undefined}>
                        {step.text}
                      </li>
                    ))}
                  </ol>
                </dd>
              </>
            ) : null}
            {card.detail.files.length ? (
              <>
                <dt>{t("idle.files")}</dt>
                <dd>
                  <div className="files">
                    {card.detail.files.map((file) => (
                      <code key={file.path} title={file.path}>
                        {file.name}
                      </code>
                    ))}
                  </div>
                </dd>
              </>
            ) : null}
            {card.detail.prs.length ? (
              <>
                <dt>{t("idle.pr")}</dt>
                <dd>
                  {card.detail.prs.map((pr) =>
                    pr.href ? (
                      <a key={pr.label} href={pr.href} target="_blank" rel="noreferrer">
                        {pr.label}
                      </a>
                    ) : (
                      <span key={pr.label}>{pr.label}</span>
                    ),
                  )}
                </dd>
              </>
            ) : card.detail.prEmpty ? (
              <>
                <dt>{t("idle.pr")}</dt>
                <dd className="idle-empty">{t("idle.pr.none")}</dd>
              </>
            ) : null}
            {card.detail.waiting.length ? (
              <>
                <dt>{t("idle.waiting")}</dt>
                <dd>
                  {card.detail.waiting.map((w) => (
                    <div key={w.name}>
                      {t("idle.waiting.line", {
                        name: w.name,
                        time: clockLabel(w.at, locale),
                      })}
                    </div>
                  ))}
                </dd>
              </>
            ) : null}
          </dl>
        ) : null}
      </div>
    </div>
  );
}

function stateLabel(state: IdleState, t: TFn): string {
  if (state === "cut") return t("idle.state.cut");
  if (state === "wait") return t("idle.state.wait");
  return t("idle.state.quiet");
}
