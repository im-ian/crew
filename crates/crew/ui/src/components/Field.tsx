import type { ReactNode } from "react";

type Props = {
  label: ReactNode;
  htmlFor?: string;
  children: ReactNode;
};

export function Field({ label, htmlFor, children }: Props) {
  return (
    <div className="field-block">
      <label className="field" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
    </div>
  );
}
