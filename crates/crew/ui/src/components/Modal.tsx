import type { MouseEvent, ReactNode } from "react";

type Props = {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
};

export function Modal({ open, title, onClose, children }: Props) {
  return (
    <div
      className={"modal" + (open ? " open" : "")}
      onClick={(e: MouseEvent) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog">
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}
