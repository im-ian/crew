import type { ReactNode } from "react";
import { handleBackdropPointerDown, rememberSelectClose } from "../dialogLayer";

type Props = {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
};

export function Modal({ open, title, onClose, children, className }: Props) {
  return (
    <div
      className={"modal" + (open ? " open" : "")}
      onPointerDown={(e) => handleBackdropPointerDown(e, onClose)}
      onBlur={(e) => rememberSelectClose(e.currentTarget, e.target)}
    >
      <div className={"dialog" + (className ? " " + className : "")}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}
