import { forwardRef, type ButtonHTMLAttributes } from "react";
import { X } from "../icons";

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "title" | "aria-label"> & {
  /** What the button says: its tooltip and its name to a screen reader. */
  label: string;
};

/**
 * The close control of every panel, sheet, dialog and picture overlay: the
 * same icon, the same size and the same press area (`.close-btn`). On a phone
 * it is drawn at 36px with a clear edge around it, which takes the press to 44.
 */
export const CloseButton = forwardRef<HTMLButtonElement, Props>(function CloseButton(
  { label, className, ...rest },
  ref,
) {
  return (
    <button
      {...rest}
      ref={ref}
      type="button"
      className={"close-btn" + (className ? " " + className : "")}
      title={label}
      aria-label={label}
    >
      <X />
    </button>
  );
});
