import {
  useEffect,
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
import { useT } from "../LocaleContext";
import { BotFace } from "./BotFace";
import { Field } from "./Field";

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

  useEffect(() => {
    setHex(resolved.color);
  }, [resolved.color, id]);

  function commitHex(raw: string) {
    const next = normalizeHex(raw);
    if (!next) return;
    setHex(next);
    onColor(next);
  }

  const selectedSwatch = AVATAR_SWATCHES.find(
    (c) => c.toLowerCase() === resolved.color.toLowerCase(),
  );

  function shuffle() {
    const next = randomFace(resolved);
    setHex(next.color);
    if (onFace) onFace(next.shape, next.color);
    else {
      onShape(next.shape);
      onColor(next.color);
    }
  }

  return (
    <>
      <div className="field-block">
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
        <div className="shape-picker" role="listbox" aria-label={t("field.shape")}>
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
              <BotFace shape={s} color={resolved.color} />
            </button>
          ))}
        </div>
      </div>
      <Field label={t("field.color")}>
        <div className="color-row">
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
                  onColor(c);
                }}
              />
            ))}
          </div>
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
              if (next) onColor(next);
            }}
            onBlur={() => {
              const next = normalizeHex(hex);
              setHex(next || resolved.color);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitHex(hex);
              }
            }}
          />
        </div>
      </Field>
    </>
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

  return (
    <div className={"face-pop" + (open ? " open" : "")} ref={rootRef}>
      <button
        type="button"
        className="face-pop-hit"
        aria-label={t("face.avatar")}
        aria-expanded={open}
        aria-haspopup="dialog"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        {children}
      </button>
      {open ? (
        <div className="face-pop-card" role="dialog" aria-label={t("face.avatar")}>
          <FacePicker {...picker} />
        </div>
      ) : null}
    </div>
  );
}
