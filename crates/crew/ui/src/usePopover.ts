import { useEffect, useRef, useState } from "react";

// Open state for a card that closes on Escape or a press outside `rootRef`.
export function usePopover(active: boolean) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!active) setOpen(false);
  }, [active]);

  useEffect(() => {
    const el = rootRef.current;
    if (!open || !el) return;
    el.setAttribute("data-popover-open", "");
    return () => el.removeAttribute("data-popover-open");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // Capture, so Escape closes this card before a dialog behind it.
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
    function onPointer(e: PointerEvent) {
      const el = rootRef.current;
      if (el && !el.contains(e.target as Node)) setOpen(false);
    }
    const id = window.setTimeout(() => {
      document.addEventListener("keydown", onKey, true);
      document.addEventListener("pointerdown", onPointer);
    }, 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  return { open, setOpen, rootRef };
}

export function popoverIsOpen(): boolean {
  return document.querySelector("[data-popover-open]") != null;
}
