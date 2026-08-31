import { useEffect, useState } from "react";
import {
  AVATAR_SHAPES,
  AVATAR_SWATCHES,
  normalizeHex,
  randomFace,
  resolveFace,
  type AvatarShape,
} from "../avatar";
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
          <label className="field">모양</label>
          <button
            type="button"
            className="field-action"
            aria-label="랜덤 조합"
            onClick={shuffle}
          >
            랜덤
          </button>
        </div>
        <div className="shape-picker" role="listbox" aria-label="모양">
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
      <Field label="색상">
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
            aria-label="색상 코드"
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
