import type { WorkLook } from "../workLook";

// Keys are laid out once. Each one presses at its own offset so the typing looks uneven.
const KEY_ROWS = [
  { y: 3, x0: 3, n: 9, w: 4 },
  { y: 8.2, x0: 4.6, n: 8, w: 4 },
  { y: 13.4, x0: 6.2, n: 7, w: 4 },
];
const KEYS = KEY_ROWS.flatMap((row, r) =>
  Array.from({ length: row.n }, (_, i) => ({
    x: row.x0 + i * (row.w + 1.1),
    y: row.y,
    w: row.w,
    delay: (((r * 7 + i * 5) % 11) / 11) * 2.2,
  })),
);

/**
 * What a working bot holds or sits behind. It is drawn over the avatar box, not
 * inside the face, so the face keeps its size. Sizes use the box's width, and
 * the props are left out when the box is too small to read them.
 */
export function WorkProps({ look }: { look: WorkLook }) {
  return (
    <span className={`work-props is-${look}`} aria-hidden>
      {look === "hustle" ? (
        <span className="work-lines">
          <i />
          <i />
          <i />
        </span>
      ) : null}
      {look === "magnifier" ? (
        <span className="work-mag">
          <svg viewBox="0 0 24 24">
            <circle cx="10" cy="10" r="6.4" fill="rgba(255,255,255,0.16)" stroke="var(--ink)" strokeWidth="2.2" />
            <path d="M14.8 14.8L21 21" stroke="var(--ink)" strokeWidth="3.4" strokeLinecap="round" />
            <path className="work-glint" d="M7 8.2A4 4 0 0 1 9.4 6.4" fill="none" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </span>
      ) : null}
      {look === "laptop" ? (
        <span className="work-laptop">
          <svg viewBox="0 0 40 26">
            <rect x="3" y="1" width="34" height="20" rx="3" fill="var(--btn-hover)" stroke="var(--line)" />
            <circle cx="20" cy="11" r="2.6" fill="var(--muted)" opacity="0.7" />
            <rect x="0.5" y="21.6" width="39" height="3.4" rx="1.7" fill="var(--btn)" stroke="var(--line)" />
          </svg>
        </span>
      ) : null}
      {look === "checklist" ? (
        <span className="work-list">
          {[0, 1, 2].map((n) => (
            <b key={n} className={`row r${n}`}>
              <svg viewBox="0 0 10 10">
                <rect x="0.8" y="0.8" width="8.4" height="8.4" rx="2" fill="none" stroke="#9a9aa2" strokeWidth="1.2" />
                <path className="tick" d="M2.4 5.2L4.4 7.1L7.8 2.9" fill="none" stroke="var(--idle)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <i />
            </b>
          ))}
        </span>
      ) : null}
      {look === "keyboard" ? (
        <span className="work-kb">
          <svg viewBox="0 0 48 21">
            <rect x="0.5" y="0.5" width="47" height="20" rx="3.4" fill="var(--btn)" stroke="var(--line)" />
            {KEYS.map((k, i) => (
              <rect
                key={i}
                className="key"
                x={k.x}
                y={k.y}
                width={k.w}
                height="3.6"
                rx="1"
                style={{ animationDelay: `${k.delay.toFixed(2)}s` }}
              />
            ))}
            <rect className="key" x="13" y="18" width="22" height="2.2" rx="1" style={{ animationDelay: "1s" }} />
          </svg>
        </span>
      ) : null}
    </span>
  );
}
