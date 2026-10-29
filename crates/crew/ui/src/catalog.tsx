// Dev-only page: `npm run dev`, then open /catalog.html. Production builds only
// bundle index.html, so this never ships.
import { StrictMode, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { AVATAR_SHAPES, AVATAR_SWATCHES, type AvatarShape } from "./avatar";
import { BotFace, type FaceMood } from "./components/BotFace";
import { applyTheme, type ThemePref } from "./theme";
import type { AgentStatus } from "./types";
import "./styles.css";
import "./catalog.css";

type Entry = {
  key: string;
  label: string;
  note: string;
  status?: AgentStatus;
  mood?: FaceMood;
  /** The motion is a single beat in the app, so the card can play it once. */
  once?: boolean;
  fresh?: boolean;
};

const ENTRIES: Entry[] = [
  { key: "idle", label: "Idle · 대기", note: "눈이 천천히 두리번거리고 가끔 깜빡여요. 입력창에 글을 쓰면 커서를 따라가요.", status: "idle" },
  { key: "working", label: "Working · 작업 중", note: "위아래로 둥실거리고 눈이 생각하듯 움직여요.", status: "working" },
  { key: "blocked", label: "Blocked · 승인 대기", note: "떨면서 눈썹이 처진 걱정스러운 눈이에요.", status: "blocked" },
  { key: "exited", label: "Exited · 종료 (잠)", note: "눈을 감고 몸을 천천히 부풀렸다 줄이며 자요. 머리 위로 Z가 떠올라요.", status: "exited" },
  { key: "happy", label: "Happy · 작업을 마침", note: "작업이 끝나면 1.6초 동안 ^ ^ 눈이 돼요. 지금 앱에 있는 표정이에요.", mood: "happy" },
  { key: "success", label: "Success · 성공", note: "왼쪽으로 폴짝 뛰었다가 좌우로 흔들며 춤을 춰요. 눈은 ^ ^ 이에요.", mood: "success", once: true, fresh: true },
  { key: "failure", label: "Failure · 실패", note: "고개를 푹 숙이고 눈이 - - 가 돼요. 숙인 채 느리게 숨을 쉬어요.", mood: "failure", once: true, fresh: true },
  { key: "question", label: "Question · 궁금", note: "오른쪽으로 갸우뚱하며 위를 보고, 머리 위에 물음표가 톡 튀어나와요.", mood: "question", once: true, fresh: true },
];

function Face({
  entry,
  shape,
  color,
  size,
  play,
}: {
  entry: Entry;
  shape: AvatarShape;
  color: string;
  size: number;
  play: number;
}) {
  const style = { width: size, height: size, ["--mood-count" as string]: entry.once && play > 0 ? 1 : undefined };
  return (
    <div className="cat-face" style={style as CSSProperties}>
      <BotFace
        key={play}
        shape={shape}
        color={color}
        id={entry.key}
        status={entry.status ?? "idle"}
        mood={entry.mood ?? null}
      />
    </div>
  );
}

function Card({ entry, shape, color }: { entry: Entry; shape: AvatarShape; color: string }) {
  const [play, setPlay] = useState(0);
  return (
    <article className={"cat-card" + (entry.fresh ? " is-new" : "")}>
      <div className="cat-head">
        <h3>{entry.label}</h3>
        {entry.fresh ? <span className="cat-tag">새 표정</span> : null}
      </div>
      <div className="cat-stage">
        <Face entry={entry} shape={shape} color={color} size={112} play={play} />
      </div>
      <div className="cat-sizes">
        <Face entry={entry} shape={shape} color={color} size={36} play={play} />
        <Face entry={entry} shape={shape} color={color} size={24} play={play} />
      </div>
      <p>{entry.note}</p>
      {entry.once ? (
        <div className="cat-actions">
          <button type="button" onClick={() => setPlay((n) => n + 1)}>한 번만 재생</button>
          {play > 0 ? (
            <button type="button" onClick={() => setPlay(0)}>반복으로</button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function Catalog() {
  const [shape, setShape] = useState<AvatarShape>("circle");
  const [color, setColor] = useState(AVATAR_SWATCHES[1]);
  const [theme, setTheme] = useState<ThemePref>("dark");
  const [pick, setPick] = useState("success");
  const [gridPlay, setGridPlay] = useState(0);
  const picked = ENTRIES.find((e) => e.key === pick) ?? ENTRIES[0];

  return (
    <main className="cat">
      <div className="cat-bar">
        <h1>봇 표정 카탈로그</h1>
        <label>
          모양
          <select value={shape} onChange={(e) => setShape(e.target.value as AvatarShape)}>
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
        <h2>표정</h2>
        <div className="cat-grid">
          {ENTRIES.map((e) => (
            <Card key={e.key} entry={e} shape={shape} color={color} />
          ))}
        </div>
      </section>

      <section>
        <h2>모든 모양에서 보기</h2>
        <div className="cat-tabs">
          {ENTRIES.map((e) => (
            <button
              key={e.key}
              type="button"
              className={e.key === pick ? "on" : ""}
              onClick={() => setPick(e.key)}
            >
              {e.key}
            </button>
          ))}
          <button type="button" onClick={() => setGridPlay((n) => n + 1)}>
            모두 다시 재생
          </button>
        </div>
        <div className="cat-shapes">
          {AVATAR_SHAPES.map((s) => (
            <figure key={s + gridPlay}>
              <Face entry={{ ...picked, once: false }} shape={s} color={color} size={72} play={gridPlay} />
              <figcaption>{s}</figcaption>
            </figure>
          ))}
        </div>
      </section>
    </main>
  );
}

applyTheme("dark");
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Catalog />
  </StrictMode>,
);
