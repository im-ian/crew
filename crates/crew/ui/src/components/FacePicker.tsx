import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AVATAR_SHAPES,
  AVATAR_SWATCHES,
  normalizeHex,
  randomFace,
  resolveFace,
  type AvatarShape,
} from "../avatar";
import { Pencil } from "../icons";
import { useT } from "../LocaleContext";
import { usePopover } from "../usePopover";
import { BotFace } from "./BotFace";

type Props = {
  id?: string | null;
  shape?: string | null;
  color?: string | null;
  onShape: (shape: AvatarShape) => void;
  onColor: (color: string) => void;
  onFace?: (shape: AvatarShape, color: string) => void;
};

export function FacePicker({
  id,
  shape,
  color,
  onShape,
  onColor,
  onFace,
}: Props) {
  const t = useT();
  const resolved = resolveFace(id, shape, color);
  const [hex, setHex] = useState(resolved.color);
  const preview = normalizeHex(hex) ?? resolved.color;
  // Hold the edited color so a slower save cannot paint the previous one back.
  const pendingColor = useRef<string | null>(null);
  const sentColor = useRef<string | null>(null);
  const queuedColor = useRef<string | null>(null);
  const colorTimer = useRef<number | null>(null);
  const onColorRef = useRef(onColor);
  const resolvedColorRef = useRef(resolved.color);
  const seenId = useRef(id);
  onColorRef.current = onColor;
  resolvedColorRef.current = resolved.color;

  function publishColor(next: string) {
    const norm = next.toLowerCase();
    if (sentColor.current?.toLowerCase() === norm) {
      pendingColor.current = next;
      return;
    }
    const unchanged =
      sentColor.current == null && resolvedColorRef.current.toLowerCase() === norm;
    if (unchanged) {
      pendingColor.current = null;
      return;
    }
    pendingColor.current = next;
    sentColor.current = next;
    onColorRef.current(next);
  }

  const publishColorRef = useRef(publishColor);
  publishColorRef.current = publishColor;

  function clearColorTimer() {
    if (colorTimer.current == null) return;
    window.clearTimeout(colorTimer.current);
    colorTimer.current = null;
  }

  function scheduleColor(next: string) {
    pendingColor.current = next;
    queuedColor.current = next;
    clearColorTimer();
    colorTimer.current = window.setTimeout(() => {
      colorTimer.current = null;
      const queued = queuedColor.current;
      queuedColor.current = null;
      if (queued) publishColorRef.current(queued);
    }, 200);
  }

  function flushColor(next: string) {
    queuedColor.current = null;
    clearColorTimer();
    publishColor(next);
  }

  useEffect(() => {
    return () => {
      if (colorTimer.current != null) {
        window.clearTimeout(colorTimer.current);
        colorTimer.current = null;
      }
      const queued = queuedColor.current;
      queuedColor.current = null;
      if (queued) publishColorRef.current(queued);
    };
  }, []);

  useEffect(() => {
    if (seenId.current !== id) {
      seenId.current = id;
      pendingColor.current = null;
      sentColor.current = null;
      queuedColor.current = null;
      if (colorTimer.current != null) {
        window.clearTimeout(colorTimer.current);
        colorTimer.current = null;
      }
      setHex(resolved.color);
      return;
    }
    const pending = pendingColor.current;
    if (pending && resolved.color.toLowerCase() === pending.toLowerCase()) {
      pendingColor.current = null;
      sentColor.current = null;
    }
    if (pendingColor.current) return;
    setHex(resolved.color);
  }, [resolved.color, id]);

  function commitHex(raw: string) {
    const next = normalizeHex(raw);
    if (!next) return;
    setHex(next);
    flushColor(next);
  }

  const selectedSwatch = AVATAR_SWATCHES.find(
    (c) => c.toLowerCase() === preview.toLowerCase(),
  );
  const shapeRow = useRef<HTMLDivElement>(null);

  // Keep the chosen shape inside this column. scrollIntoView would also
  // scroll the sheet underneath the popover.
  useLayoutEffect(() => {
    const row = shapeRow.current;
    const el = row?.querySelector<HTMLElement>(".shape-pick.on");
    if (!row || !el) return;
    const rowBox = row.getBoundingClientRect();
    const elBox = el.getBoundingClientRect();
    if (elBox.top >= rowBox.top && elBox.bottom <= rowBox.bottom) return;
    const delta = elBox.top - rowBox.top - (row.clientHeight - elBox.height) / 2;
    row.scrollTop += delta;
  }, [resolved.shape]);

  function shuffle() {
    const next = randomFace(resolved);
    setHex(next.color);
    queuedColor.current = null;
    clearColorTimer();
    pendingColor.current = next.color;
    sentColor.current = next.color;
    if (onFace) onFace(next.shape, next.color);
    else {
      onShape(next.shape);
      onColorRef.current(next.color);
    }
  }

  return (
    <div className="face-pick-cols">
      <div className="field-head">
        <label className="field">{t("field.shape")}</label>
        <button
          type="button"
          className="field-action"
          aria-label={t("face.randomAria")}
          onClick={shuffle}
        >
          {t("face.random")}
        </button>
      </div>
      <label className="field">{t("field.color")}</label>
      <div
        className="shape-picker"
        role="listbox"
        aria-label={t("field.shape")}
        ref={shapeRow}
      >
          {AVATAR_SHAPES.map((s) => (
            <button
              key={s}
              type="button"
              role="option"
              aria-selected={resolved.shape === s}
              className={"shape-pick" + (resolved.shape === s ? " on" : "")}
              title={s}
              onClick={() => onShape(s)}
            >
              <BotFace shape={s} color={preview} />
            </button>
          ))}
      </div>
      <div className="color-pane">
        <div className="color-swatches">
          {AVATAR_SWATCHES.map((c) => (
            <button
              key={c}
              type="button"
              className={"color-swatch" + (selectedSwatch === c ? " on" : "")}
              style={{ background: c }}
              title={c}
              aria-label={c}
              onClick={() => {
                setHex(c);
                flushColor(c);
              }}
            />
          ))}
        </div>
        <div className="color-custom">
          <input
            className="color-native"
            type="color"
            value={preview}
            aria-label={t("face.colorPick")}
            onChange={(e) => {
              const next = normalizeHex(e.target.value);
              if (!next) return;
              setHex(next);
              scheduleColor(next);
            }}
            onBlur={(e) => {
              const next = normalizeHex(e.currentTarget.value);
              if (!next) return;
              setHex(next);
              flushColor(next);
            }}
          />
          <input
            className="textin color-hex"
            value={hex}
            spellCheck={false}
            autoComplete="off"
            placeholder="#ff6a00"
            aria-label={t("face.colorCode")}
            onChange={(e) => {
              const raw = e.target.value;
              setHex(raw);
              const next = normalizeHex(raw);
              if (next) publishColor(next);
            }}
            onBlur={() => {
              const next = normalizeHex(hex);
              if (!next) {
                pendingColor.current = null;
                setHex(resolved.color);
                return;
              }
              setHex(next);
              flushColor(next);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitHex(hex);
              }
            }}
          />
        </div>
      </div>
    </div>
  );
}

type FacePopProps = Props & {
  active?: boolean;
  children: ReactNode;
};

export function FacePop({
  active = true,
  children,
  ...picker
}: FacePopProps) {
  const t = useT();
  const { open, setOpen, rootRef } = usePopover(active);

  return (
    <div className={"face-pop" + (open ? " open" : "")} ref={rootRef}>
      <button
        type="button"
        className="face-pop-hit"
        aria-label={t("face.avatar")}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        {children}
        <span className="face-pop-badge" aria-hidden="true">
          <Pencil size={12} />
        </span>
      </button>
      {open ? (
        <div className="face-pop-card" role="dialog" aria-label={t("face.avatar")}>
          <FacePicker {...picker} />
        </div>
      ) : null}
    </div>
  );
}
