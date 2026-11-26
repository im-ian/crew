import type { ReactNode } from "react";
import { handleBackdropPointerDown, rememberSelectClose } from "../dialogLayer";
import { useT } from "../LocaleContext";
import { CloseButton } from "./CloseButton";

type Props = {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  /** Beside the title, at the right: a small control such as a help link. */
  aside?: ReactNode;
  /**
   * The close control a phone shows in the title bar (a desktop dialog has
   * none: its buttons and Escape close it). Off for a dialog whose own
   * buttons are the choice, where closing is one of them.
   */
  closeButton?: boolean;
};

export function Modal({ open, title, onClose, children, className, aside, closeButton = true }: Props) {
  const t = useT();
  return (
    <div
      className={"modal" + (open ? " open" : "")}
      onPointerDown={(e) => handleBackdropPointerDown(e, onClose)}
      onBlur={(e) => rememberSelectClose(e.currentTarget, e.target)}
    >
      <div className={"dialog" + (className ? " " + className : "")}>
        <div className="dialog-head">
          <h3>{title}</h3>
          {/* One group at the right, so a control beside the title sits against
              the close button, not between the title and it. */}
          <div className="dialog-head-end">
            {aside}
            {closeButton ? (
              <CloseButton className="dialog-close" label={t("common.close")} onClick={onClose} />
            ) : null}
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}
