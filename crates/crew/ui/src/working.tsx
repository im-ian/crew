// Dev-only page: `npm run dev`, then open /working.html. It draws the real Avatar,
// so what shows here is what the app draws. Production builds only bundle index.html.
import { StrictMode, useEffect, useRef, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { AVATAR_SHAPES, AVATAR_SWATCHES } from "./avatar";
import { Avatar } from "./components/Avatar";
import { applyTheme, type ThemePref } from "./theme";
import { WORK_LOOKS, type WorkLook } from "./workLook";
import "./styles.css";
import "./catalog.css";
import "./working.css";

const LOOKS: { key: WorkLook; label: string; note: string }[] = [
  { key: "hustle", label: "열일 (종종걸음)", note: "좌우로 기울며 종종걸음을 치고, 왼쪽에 속도선이 스쳐 가요. 눈은 앞을 봐요." },
  { key: "magnifier", label: "돋보기로 살펴보기", note: "돋보기를 들고 타원을 그리며 훑어요. 눈이 돋보기를 따라가요." },
  { key: "laptop", label: "노트북 두드리기", note: "노트북 뒤에서 얼굴만 빼꼼 보여요. 눈은 화면 쪽을 보고 노트북이 타닥타닥 들썩여요." },
  { key: "checklist", label: "체크리스트", note: "옆의 할 일 목록에 체크가 한 줄씩 그려져요. 눈이 위에서 아래로 훑어요." },
  { key: "keyboard", label: "키보드 치기", note: "얼굴 앞에서 키가 제각각 눌렸다 올라와요. 눈은 키보드를 내려다봐요." },
];

function Face({
  size,
  shape,
  color,
  look,
}: {
  size: number;
  shape: string;
  color: string;
  look: WorkLook;
}) {
  const style = { ["--avatar" as string]: `${size}px` } as CSSProperties;
  return (
    <div className="pg-face" style={style}>
      <Avatar id={look} shape={shape} color={color} status="working" workLook={look} />
    </div>
  );
}

function Card({ look, shape, color }: { look: (typeof LOOKS)[number]; shape: string; color: string }) {
  return (
    <article className="cat-card">
      <div className="cat-head">
        <h3>{look.label}</h3>
      </div>
      <div className="cat-stage">
        <Face size={112} shape={shape} color={color} look={look.key} />
      </div>
      <div className="cat-sizes">
        <Face size={56} shape={shape} color={color} look={look.key} />
        <Face size={32} shape={shape} color={color} look={look.key} />
        <Face size={24} shape={shape} color={color} look={look.key} />
      </div>
      <p>{look.note}</p>
    </article>
  );
}

/** Runs the real start-of-work draw: each time status turns working, the Avatar picks again. */
function StartDraw({ shape, color }: { shape: string; color: string }) {
  const [working, setWorking] = useState(true);
  const [auto, setAuto] = useState(true);
  const [seen, setSeen] = useState<WorkLook[]>([]);
  const stage = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!auto) return;
    const t = window.setTimeout(() => setWorking((w) => !w), working ? 5000 : 1800);
    return () => window.clearTimeout(t);
  }, [auto, working]);
  useEffect(() => {
    if (!working) return;
    const face = stage.current?.querySelector('[class*="look-"]');
    const m = face?.getAttribute("class")?.match(/look-(\w+)/);
    const look = m?.[1] as WorkLook | undefined;
    // Two runs in a row never draw the same look, so a repeat is only the dev double-run.
    if (look && WORK_LOOKS.includes(look)) {
      setSeen((s) => (s[s.length - 1] === look ? s : [...s, look].slice(-10)));
    }
  }, [working]);
  const style = { ["--avatar" as string]: "112px" } as CSSProperties;
  return (
    <div className="cat-card is-new pg-draw">
      <div className="cat-head">
        <h3>작업을 시작할 때마다 하나씩 뽑기</h3>
        <span className="cat-tag">{working ? "작업 중" : "대기"}</span>
      </div>
      <div className="pg-draw-row">
        <div className="cat-stage" ref={stage}>
          <div className="pg-face" style={style}>
            <Avatar id="draw" shape={shape} color={color} status={working ? "working" : "idle"} />
          </div>
        </div>
        <div className="pg-draw-info">
          <p>
            작업이 시작되면 다섯 가지 중 하나를 뽑고, 끝날 때까지 그대로 유지해요. 직전과 같은 건 뽑지
            않아요. 대기로 돌아오면 지워져요.
          </p>
          <div className="cat-actions">
            <button type="button" onClick={() => setWorking((w) => !w)}>
              {working ? "작업 끝내기" : "작업 시작"}
            </button>
            <button type="button" onClick={() => setAuto((a) => !a)}>
              {auto ? "자동 반복 끄기" : "자동 반복 켜기"}
            </button>
          </div>
          <div className="pg-seen">
            <span>최근 뽑힌 순서</span>
            {seen.map((k, i) => (
              <b key={i}>{LOOKS.find((l) => l.key === k)?.label.split(" ")[0]}</b>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Page() {
  const [shape, setShape] = useState("circle");
  const [color, setColor] = useState(AVATAR_SWATCHES[1]);
  const [theme, setTheme] = useState<ThemePref>("dark");
  return (
    <main className="cat">
      <div className="cat-bar">
        <h1>작업 중 모습</h1>
        <label>
          모양
          <select value={shape} onChange={(e) => setShape(e.target.value)}>
            {AVATAR_SHAPES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <div className="cat-swatches" role="group" aria-label="색">
          {AVATAR_SWATCHES.map((c) => (
            <button
              key={c}
              type="button"
              className={c === color ? "on" : ""}
              style={{ background: c }}
              aria-label={c}
              onClick={() => setColor(c)}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={() => {
            const next = theme === "dark" ? "light" : "dark";
            setTheme(next);
            applyTheme(next);
          }}
        >
          {theme === "dark" ? "라이트로" : "다크로"}
        </button>
      </div>
      <section>
        <h2>시작할 때 뽑기</h2>
        <StartDraw shape={shape} color={color} />
      </section>
      <section>
        <h2>다섯 가지 모습</h2>
        <div className="cat-grid">
          {LOOKS.map((l) => (
            <Card key={l.key} look={l} shape={shape} color={color} />
          ))}
        </div>
        <p className="pg-note">28px보다 작은 얼굴에서는 소품을 빼고 몸과 눈만 움직여요.</p>
      </section>
    </main>
  );
}

applyTheme("dark");
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);
