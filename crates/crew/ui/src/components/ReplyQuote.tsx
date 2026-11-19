import { useT } from "../LocaleContext";
import { sentTarget } from "../peek";
import { plainText } from "../reply";
import type { AgentInfo } from "../types";
import { Avatar } from "./Avatar";

/** The bot a quoted message came from or went to. The user's own has none. */
export function quoteFrom(from: string): string | null {
  if (from === "user") return null;
  return sentTarget(from) ?? from;
}

/**
 * The message a reply answers: the face of the bot it was with, "이름에게
 * 답장" with the name in bold, and up to two lines of its words. A sent
 * reply's balloon and a reply being written draw the same thing.
 */
export function ReplyQuote({
  agent,
  who,
  snippet,
  title,
  onClick,
  alone = false,
}: {
  agent: AgentInfo | null;
  who: string;
  snippet: string;
  title: string;
  onClick?: () => void;
  alone?: boolean;
}) {
  const t = useT();
  // The name is set in bold inside the sentence, in either word order.
  const [before, after = ""] = t("thread.replyTo").split("{who}");
  return (
    <button
      type="button"
      className={"reply-quote" + (alone ? " is-alone" : "")}
      title={title}
      onClick={onClick}
    >
      <span className="reply-quote-head">
        {agent ? (
          <Avatar
            as="span"
            className="reply-quote-face"
            id={agent.id}
            name={who}
            src={agent.avatar}
            shape={agent.avatar_shape}
            color={agent.avatar_color}
          />
        ) : null}
        <span className="reply-quote-to">
          {before}
          <b>{who}</b>
          {after}
        </span>
      </span>
      <span className="reply-quote-text">{plainText(snippet)}</span>
    </button>
  );
}
