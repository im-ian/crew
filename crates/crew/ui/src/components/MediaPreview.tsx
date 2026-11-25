import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import { imageStep } from "../imageAlbum";
import {
  clampView,
  DOUBLE_CLICK_SCALE,
  FIT,
  MIN_SCALE,
  MAX_SCALE,
  wheelFactor,
  zoomAt,
  zoomKey,
  ZOOM_STEP,
  type ZoomView,
} from "../imageZoom";
import type { MediaKind } from "../markdown";
import { useT } from "../LocaleContext";
import { ZoomIn, ZoomOut } from "../icons";
import { CloseButton } from "./CloseButton";

export type Shot = {
  src: string;
  alt: string;
  kind: "image" | MediaKind;
  path?: string;
};

export function MediaPreview({
  shots,
  start,
  onClose,
}: {
  shots: Shot[];
  start: number;
  onClose: () => void;
}) {
  const t = useT();
  const closeRef = useRef<HTMLButtonElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [index, setIndex] = useState(start);
  const [failed, setFailed] = useState(false);
  const shot = shots[index] ?? shots[0];
  const zoom = useImageZoom(shot?.kind === "image" ? shot.src : null, stageRef, imgRef);
  useEffect(() => {
    closeRef.current?.focus();
  }, []);
  useEffect(() => {
    setFailed(false);
  }, [shot?.src, shot?.kind]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.fullscreenElement) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      // Arrows step every shot, a clip included. Zoom keys stay on a picture.
      if (shot && !e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey) {
        const next = imageStep(e.key, index, shots.length);
        if (next != null) {
          e.preventDefault();
          e.stopPropagation();
          if (next !== index) setIndex(next);
          return;
        }
      }
      if (!shot || shot.kind !== "image") return;
      // appZoom.ts listens first and leaves these keys alone while this
      // picture is mounted, so + − 0 stay on the picture, with or without ⌘.
      const z = zoomKey(e);
      if (!z) return;
      e.preventDefault();
      e.stopPropagation();
      if (z === "fit") zoom.fit();
      else zoom.step(z === "in" ? ZOOM_STEP : 1 / ZOOM_STEP);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, shot, index, shots.length, zoom]);
  if (!shot) return null;
  const label =
    shot.alt ||
    (shot.kind === "video" ? t("media.video") : shot.kind === "audio" ? t("media.audio") : t("image.preview"));
  const keep = (e: { stopPropagation: () => void }) => e.stopPropagation();
  return createPortal(
    <div
      ref={stageRef}
      className={
        "img-preview" +
        (zoom.live ? " is-live" : "") +
        (zoom.space ? " is-space" : "") +
        (zoom.view.scale > MIN_SCALE ? " is-zoomed" : "")
      }
      role="dialog"
      aria-modal="true"
      aria-label={label}
      onPointerDown={zoom.onPointerDown}
      onClick={(e) => {
        // A drag that ends off the picture still clicks the backdrop, and
        // a click with Space held is a hand on the picture, not a dismissal.
        if (zoom.takeDrag() || zoom.space) return;
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <CloseButton
        ref={closeRef}
        className="img-preview-close"
        label={t("common.close")}
        onMouseDown={keep}
        onClick={onClose}
      />
      {shot.kind === "image" ? (
        <img
          ref={imgRef}
          src={shot.src}
          alt={shot.alt}
          draggable={false}
          className={zoom.view.scale > MIN_SCALE ? "is-zoomed" : undefined}
          style={{
            transform: `translate(${zoom.view.x}px, ${zoom.view.y}px) scale(${zoom.view.scale})`,
          }}
          onMouseDown={keep}
          onDoubleClick={zoom.onDoubleClick}
        />
      ) : null}
      {shot.kind === "video" && !failed ? (
        <video src={shot.src} controls autoPlay playsInline onError={() => setFailed(true)} onMouseDown={keep} />
      ) : null}
      {shot.kind === "audio" && !failed ? (
        <audio src={shot.src} controls autoPlay onError={() => setFailed(true)} onMouseDown={keep} />
      ) : null}
      {shot.kind === "image" ? (
        <div className="img-preview-bar" onMouseDown={keep} onClick={keep}>
          <button
            type="button"
            aria-label={t("image.zoomOut")}
            title={t("image.zoomOut") + " (−)"}
            disabled={zoom.view.scale <= MIN_SCALE}
            onClick={() => zoom.step(1 / ZOOM_STEP)}
          >
            <ZoomOut size={16} />
          </button>
          <button
            type="button"
            className="img-preview-scale"
            aria-label={t("image.zoomFit")}
            title={t("image.zoomFit") + " (0)"}
            disabled={zoom.view.scale <= MIN_SCALE}
            onClick={zoom.fit}
          >
            {Math.round(zoom.view.scale * 100)}%
          </button>
          <button
            type="button"
            aria-label={t("image.zoomIn")}
            title={t("image.zoomIn") + " (+)"}
            disabled={zoom.view.scale >= MAX_SCALE}
            onClick={() => zoom.step(ZOOM_STEP)}
          >
            <ZoomIn size={16} />
          </button>
          {shots.length > 1 ? (
            <span className="img-preview-count">{index + 1} / {shots.length}</span>
          ) : null}
        </div>
      ) : shots.length > 1 ? (
        <div className="img-preview-bar is-count" onMouseDown={keep} onClick={keep}>
          <span className="img-preview-count">{index + 1} / {shots.length}</span>
        </div>
      ) : null}
      {failed ? (
        <div className="img-preview-fail" onMouseDown={keep}>
          <p>{t("media.cantPlay")}</p>
          {shot.path ? (
            <button type="button" onClick={() => void api.openPath(shot.path!)}>
              {t("media.openApp")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>,
    // #root follows the phone's visible screen. Fixed inside it fills that
    // screen; on the desktop it has no transform, so fixed still covers the window.
    document.getElementById("root") ?? document.body,
  );
}

/**
 * Zoom for the picture in the preview: a trackpad pinch, ⌘-scroll, the bar's
 * buttons, a double click, or + − 0. A zoomed picture moves with a drag, a
 * Space drag from anywhere, or a plain scroll. A new picture starts fitted.
 */
function useImageZoom(
  src: string | null,
  stageRef: RefObject<HTMLDivElement | null>,
  imgRef: RefObject<HTMLImageElement | null>,
) {
  const [view, setView] = useState<ZoomView>(FIT);
  // A pinch or a drag follows the hand; a press of a button eases.
  const [live, setLive] = useState(false);
  const viewRef = useRef(view);
  viewRef.current = view;
  const drag = useRef<{ id: number; x: number; y: number; from: ZoomView; moved: boolean } | null>(null);
  const dragged = useRef(false);
  // Space held: a hand that moves the picture from anywhere in the window.
  const [space, setSpace] = useState(false);
  const spaceRef = useRef(false);
  spaceRef.current = space;

  useEffect(() => {
    if (!src) return;
    const isSpace = (e: KeyboardEvent) => e.key === " " || e.code === "Space";
    // Both halves are taken: the focused close button would otherwise take
    // the press as a click and close the preview.
    const onDown = (e: KeyboardEvent) => {
      if (!isSpace(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      setSpace(true);
    };
    const onUp = (e: KeyboardEvent) => {
      if (!isSpace(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setSpace(false);
    };
    const onBlur = () => setSpace(false);
    window.addEventListener("keydown", onDown, true);
    window.addEventListener("keyup", onUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onDown, true);
      window.removeEventListener("keyup", onUp, true);
      window.removeEventListener("blur", onBlur);
      setSpace(false);
    };
  }, [src]);

  useEffect(() => {
    setView(FIT);
  }, [src]);

  const sizes = useCallback(() => {
    const img = imgRef.current;
    const stage = stageRef.current;
    if (!img || !stage) return null;
    return {
      picture: { width: img.offsetWidth, height: img.offsetHeight },
      room: { width: stage.clientWidth, height: stage.clientHeight },
    };
  }, [imgRef, stageRef]);

  /**
   * A point on screen, from the picture's fitted centre. Read from layout,
   * which a transform (or one still easing) does not move.
   */
  const pointAt = useCallback(
    (clientX: number, clientY: number) => {
      const img = imgRef.current;
      const stage = stageRef.current;
      if (!img || !stage) return { x: 0, y: 0 };
      const r = stage.getBoundingClientRect();
      return {
        x: clientX - (r.left + img.offsetLeft + img.offsetWidth / 2),
        y: clientY - (r.top + img.offsetTop + img.offsetHeight / 2),
      };
    },
    [imgRef, stageRef],
  );

  const zoomBy = useCallback(
    (factor: number, at: { x: number; y: number }) => {
      const s = sizes();
      if (!s) return;
      setView((v) => zoomAt(v, factor, at, s.picture, s.room));
    },
    [sizes],
  );

  /** To a scale, from whatever the last update left: pinch steps can outrun renders. */
  const zoomTo = useCallback(
    (scale: number, at: { x: number; y: number }) => {
      const s = sizes();
      if (!s) return;
      setView((v) => zoomAt(v, scale / v.scale, at, s.picture, s.room));
    },
    [sizes],
  );

  /** A button or key: about the middle of the window. */
  const step = useCallback(
    (factor: number) => {
      const stage = stageRef.current;
      if (!stage) return;
      const r = stage.getBoundingClientRect();
      setLive(false);
      zoomBy(factor, pointAt(r.left + r.width / 2, r.top + r.height / 2));
    },
    [stageRef, zoomBy, pointAt],
  );

  const fit = useCallback(() => {
    setLive(false);
    setView(FIT);
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !src) return;
    let settle = 0;
    const calm = () => {
      window.clearTimeout(settle);
      settle = window.setTimeout(() => setLive(false), 120);
    };
    // Not React's onWheel: that listener is passive and cannot keep the
    // window from scrolling or zooming itself.
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        setLive(true);
        calm();
        zoomBy(wheelFactor(e.deltaY), pointAt(e.clientX, e.clientY));
        return;
      }
      if (viewRef.current.scale <= MIN_SCALE) return;
      e.preventDefault();
      const s = sizes();
      if (!s) return;
      setLive(true);
      calm();
      setView((v) => clampView({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }, s.picture, s.room));
    };
    // WebKit reports a trackpad pinch as gesture events, not wheel steps.
    let pinchFrom = 1;
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      pinchFrom = viewRef.current.scale;
      setLive(true);
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as Event & { scale: number; clientX: number; clientY: number };
      zoomTo(pinchFrom * g.scale, pointAt(g.clientX, g.clientY));
    };
    const onGestureEnd = (e: Event) => {
      e.preventDefault();
      setLive(false);
    };
    // A smaller window shrinks the room a zoomed picture may move in.
    const onResize = () => {
      const s = sizes();
      if (s) setView((v) => clampView(v, s.picture, s.room));
    };
    window.addEventListener("resize", onResize);
    stage.addEventListener("wheel", onWheel, { passive: false });
    stage.addEventListener("gesturestart", onGestureStart);
    stage.addEventListener("gesturechange", onGestureChange);
    stage.addEventListener("gestureend", onGestureEnd);
    return () => {
      window.clearTimeout(settle);
      window.removeEventListener("resize", onResize);
      stage.removeEventListener("wheel", onWheel);
      stage.removeEventListener("gesturestart", onGestureStart);
      stage.removeEventListener("gesturechange", onGestureChange);
      stage.removeEventListener("gestureend", onGestureEnd);
    };
  }, [stageRef, src, sizes, zoomBy, zoomTo, pointAt]);

  /**
   * A drag on the zoomed picture, or anywhere with Space held, moves it.
   * The stage listens, so a Space drag can start on the backdrop.
   */
  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      dragged.current = false;
      if (e.button !== 0 || viewRef.current.scale <= MIN_SCALE) return;
      const target = e.target as HTMLElement;
      if (target.closest("button")) return;
      if (!spaceRef.current && target !== imgRef.current) return;
      const el = e.currentTarget;
      el.setPointerCapture(e.pointerId);
      drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, from: viewRef.current, moved: false };
      setLive(true);
      const onMove = (ev: PointerEvent) => {
        const d = drag.current;
        if (!d || ev.pointerId !== d.id) return;
        const dx = ev.clientX - d.x;
        const dy = ev.clientY - d.y;
        if (!d.moved && Math.hypot(dx, dy) < 3) return;
        d.moved = true;
        const s = sizes();
        if (!s) return;
        setView(clampView({ ...d.from, x: d.from.x + dx, y: d.from.y + dy }, s.picture, s.room));
      };
      const onUp = (ev: PointerEvent) => {
        const d = drag.current;
        if (!d || ev.pointerId !== d.id) return;
        dragged.current = d.moved;
        drag.current = null;
        setLive(false);
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", onUp);
        el.removeEventListener("pointercancel", onUp);
      };
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp);
      el.addEventListener("pointercancel", onUp);
    },
    [sizes, imgRef],
  );

  const onDoubleClick = useCallback(
    (e: ReactMouseEvent<HTMLImageElement>) => {
      setLive(false);
      if (viewRef.current.scale > MIN_SCALE) {
        setView(FIT);
        return;
      }
      zoomBy(DOUBLE_CLICK_SCALE, pointAt(e.clientX, e.clientY));
    },
    [zoomBy, pointAt],
  );

  /** True once after a drag, so the click that ends it does not close. */
  const takeDrag = useCallback(() => {
    const was = dragged.current;
    dragged.current = false;
    return was;
  }, []);

  return useMemo(
    () => ({ view, live, space, step, fit, onPointerDown, onDoubleClick, takeDrag }),
    [view, live, space, step, fit, onPointerDown, onDoubleClick, takeDrag],
  );
}
