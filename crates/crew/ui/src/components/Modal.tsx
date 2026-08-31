import type { MouseEvent, ReactNode } from "react";

type Props = {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
};

export function Modal({ open, title, onClose, children, wide }: Props) {
  return (
    <div
      className={"modal" + (open ? " open" : "")}
      onClick={(e: MouseEvent) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={"dialog" + (wide ? " wide" : "")}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}
