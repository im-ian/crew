import { useEffect, useRef, useState } from "react";
import { commitName } from "../rename";

type Props = {
  value: string;
  className: string;
  label: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
};

/** In-place name field. Enter and blur save; Escape drops the edit. */
export function RenameField({ value, className, label, onCommit, onCancel }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const skip = useRef(false);
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    skip.current = false;
    setDraft(value);
    const timer = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [value]);

  function finish(save: boolean) {
    if (skip.current) return;
    skip.current = true;
    if (!save) {
      onCancel();
      return;
    }
    const next = commitName(draft, value);
    if (!next) onCancel();
    else onCommit(next);
  }

  return (
    <input
      ref={inputRef}
      className={className}
      aria-label={label}
      value={draft}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => finish(true)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          finish(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(false);
        }
      }}
    />
  );
}
