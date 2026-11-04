import type { ReactNode } from "react";
import { handleBackdropPointerDown, rememberSelectClose } from "../dialogLayer";

type Props = {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  /** Beside the title, at the right: a small control such as a help link. */
  aside?: ReactNode;
};

export function Modal({ open, title, onClose, children, className, aside }: Props) {
  return (
    <div
      className={"modal" + (open ? " open" : "")}
      onPointerDown={(e) => handleBackdropPointerDown(e, onClose)}
      onBlur={(e) => rememberSelectClose(e.currentTarget, e.target)}
    >
      <div className={"dialog" + (className ? " " + className : "")}>
        {aside ? (
          <div className="dialog-head">
            <h3>{title}</h3>
            {aside}
          </div>
        ) : (
          <h3>{title}</h3>
        )}
        {children}
      </div>
    </div>
  );
}
