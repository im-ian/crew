import type { MouseEvent, ReactNode } from "react";

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
      onClick={(e: MouseEvent) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={"dialog" + (className ? " " + className : "")}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}
