import { Star } from "../icons";
import type { Template } from "../templates";
import { Avatar } from "./Avatar";

/** White: a template keeps a shape, and each bot gets its color when it is made. */
export const TEMPLATE_FACE = "#ffffff";

type Size = "xs" | "sm" | "md";

export function TemplateFace({
  seed,
  shape,
  lead = false,
  size,
}: {
  /** Steadies the face's idle motion. */
  seed: string;
  shape?: string | null;
  lead?: boolean;
  size: Size;
}) {
  const star = size === "md" ? 12 : size === "sm" ? 10 : 9;
  return (
    <Avatar
      as="span"
      id={seed}
      shape={shape}
      color={TEMPLATE_FACE}
      className={`tpl-face ${size}`}
      overlay={
        lead ? (
          <span className="lead-star">
            <Star size={star} />
          </span>
        ) : null
      }
    />
  );
}

/** Each bot's face, the lead with its star. `stack` overlaps them a little. */
export function TemplateFaces({
  template,
  size,
  stack = false,
}: {
  template: Template;
  size: Size;
  stack?: boolean;
}) {
  return (
    <span className={stack ? "tpl-stack" : `tpl-faces ${size}`}>
      {template.bots.map((bot, i) => (
        <TemplateFace
          key={i}
          seed={`${template.id || "new"}-${i}`}
          shape={bot.shape}
          lead={template.lead === i}
          size={size}
        />
      ))}
    </span>
  );
}
