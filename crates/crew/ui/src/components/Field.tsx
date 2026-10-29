import type { ReactNode } from "react";

type Props = {
  label: ReactNode;
  htmlFor?: string;
  /** Note on this one field, kept tight under its input. */
  hint?: ReactNode;
  children: ReactNode;
};

export function Field({ label, htmlFor, hint, children }: Props) {
  return (
    <div className="field-block">
      <label className="field" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint ? <p className="field-hint">{hint}</p> : null}
    </div>
  );
}
