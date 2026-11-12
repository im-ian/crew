import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useT } from "../LocaleContext";
import { clampPeek, PEEK_MIN, peekMax } from "../peekWidth";

/**
 * The panel beside the chat: a side chat between two bots, or a file. It
 * sits on the right of `main`, which keeps room for it through `--peek-w`,
 * and its left edge drags to widen it.
 */
export function SidePane({
  labelledBy,
  focusKey,
  className,
  children,
}: {
  labelledBy: string;
  /** Takes the focus when this changes, so Escape and the keys reach the panel. */
  focusKey: string;
  className?: string;
  children: ReactNode;
}) {
  const t = useT();
  const roomRef = useRef<HTMLDivElement>(null);
  const [preferred, setPreferred] = useState<number | null>(null);
  const [mainW, setMainW] = useState(0);
  const [boxW, setBoxW] = useState(PEEK_MIN);
  const drag = useRef<{ startX: number; startW: number } | null>(null);
  const shown = preferred == null || mainW <= 0 ? null : clampPeek(preferred, mainW);

  function peekMain(): HTMLElement | null {
    const main = roomRef.current?.closest("main");
    return main instanceof HTMLElement ? main : null;
  }

  useLayoutEffect(() => {
    const room = roomRef.current;
    const main = peekMain();
    if (!room || !main) return;
    const apply = () => {
      setMainW(main.clientWidth);
      const w = Math.round(room.getBoundingClientRect().width);
      if (w > 0) setBoxW(w);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(main);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const main = peekMain();
    if (!main) return;
    if (shown == null) main.style.removeProperty("--peek-w");
    else main.style.setProperty("--peek-w", `${shown}px`);
    return () => {
      main.style.removeProperty("--peek-w");
    };
  }, [shown]);

  useEffect(() => {
    return () => document.documentElement.classList.remove("peek-resizing");
  }, []);

  useEffect(() => {
    roomRef.current?.focus();
  }, [focusKey]);

  function setWidth(next: number | null) {
    if (next == null) {
      setPreferred(null);
      return;
    }
    const main = peekMain()?.clientWidth ?? mainW;
    setPreferred(clampPeek(next, main));
  }

  function onResizePointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const startW = shown ?? roomRef.current?.getBoundingClientRect().width ?? PEEK_MIN;
    drag.current = { startX: e.clientX, startW };
    document.documentElement.classList.add("peek-resizing");
  }

  function onResizePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (!current) return;
    // The panel sits on the right, so dragging left widens it.
    setWidth(current.startW - (e.clientX - current.startX));
  }

  function onResizePointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    drag.current = null;
    document.documentElement.classList.remove("peek-resizing");
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  }

  function onResizeKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    const step = e.shiftKey ? 32 : 16;
    const base = shown ?? roomRef.current?.getBoundingClientRect().width ?? boxW;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      setWidth(base + step);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      setWidth(base - step);
    } else if (e.key === "Home") {
      e.preventDefault();
      setWidth(PEEK_MIN);
    } else if (e.key === "End") {
      e.preventDefault();
      const main = peekMain()?.clientWidth ?? mainW;
      setWidth(peekMax(main));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setWidth(null);
    }
  }

  return (
    <div
      ref={roomRef}
      className={"peek-room" + (className ? " " + className : "")}
      role="complementary"
      aria-labelledby={labelledBy}
      tabIndex={-1}
    >
      {children}
      <div
        className="peek-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label={t("thread.peekResize")}
        aria-valuemin={PEEK_MIN}
        aria-valuemax={peekMax(mainW)}
        aria-valuenow={Math.round(shown ?? boxW)}
        tabIndex={0}
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerUp}
        onPointerCancel={onResizePointerUp}
        onDoubleClick={() => setWidth(null)}
        onKeyDown={onResizeKeyDown}
      />
    </div>
  );
}
