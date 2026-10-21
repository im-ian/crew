import { useEffect, useRef, useState } from "react";

// Open state for a card that closes on Escape or a press outside `rootRef`.
export function usePopover(active: boolean) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!active) setOpen(false);
  }, [active]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    function onPointer(e: PointerEvent) {
      const el = rootRef.current;
      if (el && !el.contains(e.target as Node)) setOpen(false);
    }
    const id = window.setTimeout(() => {
      document.addEventListener("keydown", onKey);
      document.addEventListener("pointerdown", onPointer);
    }, 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  return { open, setOpen, rootRef };
}
