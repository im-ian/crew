import { useEffect, useRef, useState } from "react";
import {
  REPEAT_OPTIONS,
  WEEKDAYS,
  formatSchedule,
  parseTimeValue,
  toCron,
  type Repeat,
} from "../schedule";
import type { AgentInfo, Routine, RoutineRun } from "../types";
import { Field } from "./Field";
import { Seg } from "./Seg";

type Props = {
  open: boolean;
  agent: AgentInfo | null;
  onAdd: (name: string, schedule: string, prompt: string) => Promise<void>;
  onToggle: (r: Routine) => Promise<void>;
  onDelete: (r: Routine) => Promise<void>;
  onRun: (r: Routine) => Promise<void>;
  onEdit: (
    r: Routine,
    fields: { name?: string; schedule?: string; prompt?: string },
  ) => Promise<void>;
  onLoadRuns: (r: Routine) => Promise<RoutineRun[]>;
};

export function RoutinesModal({
  open,
  agent,
  onAdd,
  onToggle,
  onDelete,
  onRun,
  onEdit,
  onLoadRuns,
}: Props) {
  const [name, setName] = useState("");
  const [repeat, setRepeat] = useState<Repeat>("daily");
  const [days, setDays] = useState<number[]>([1]);
  const [time, setTime] = useState("09:00");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [nl, setNl] = useState("");
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editPrompt, setEditPrompt] = useState("");
  const [editSchedule, setEditSchedule] = useState("");
  const [runsFor, setRunsFor] = useState<string | null>(null);
  const [runs, setRuns] = useState<RoutineRun[]>([]);
  const nameRef = useRef<HTMLInputElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const routines = (agent && agent.routines) || [];

  useEffect(() => {
    if (!open) return;
    setName("");
    setRepeat("daily");
    setDays([1]);
    setTime("09:00");
    setPrompt("");
    setBusy(false);
    setNl("");
    setEditId(null);
    setRunsFor(null);
    setRuns([]);
  }, [open, agent?.id]);

  function toggleDay(day: number) {
    setDays((cur) => {
      if (cur.includes(day)) {
        const next = cur.filter((d) => d !== day);
        return next.length ? next : cur;
      }
      return [...cur, day].sort((a, b) => a - b);
    });
  }

  async function submit() {
    const n = name.trim();
    const p = prompt.trim();
    if (!n) {
      nameRef.current?.focus();
      return;
    }
    if (!p) {
      promptRef.current?.focus();
      return;
    }
    let schedule: string;
    if (repeat === "hourly") {
      schedule = toCron("hourly", days, 0, 0);
    } else {
      const clock = parseTimeValue(time);
      if (!clock) return;
      schedule = toCron(repeat, days, clock.hour, clock.minute);
    }
    setBusy(true);
    try {
      await onAdd(n, schedule, p);
      setName("");
      setPrompt("");
      nameRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  async function submitNl() {
    const text = nl.trim();
    if (!text) return;
    setBusy(true);
    try {
      await onAdd("", text, "");
      setNl("");
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit(r: Routine) {
    setBusy(true);
    try {
      await onEdit(r, {
        name: editName.trim(),
        schedule: editSchedule.trim(),
        prompt: editPrompt.trim(),
      });
      setEditId(null);
    } finally {
      setBusy(false);
    }
  }

  async function toggleRuns(r: Routine) {
    const key = r.id || r.name;
    if (runsFor === key) {
      setRunsFor(null);
      setRuns([]);
      return;
    }
    setRunsFor(key);
    setRuns(await onLoadRuns(r));
  }

  return (
    <div className="form-stack">
          <div className="pane-block">
            <div className="pane-label">등록된 루틴</div>
            <div className="routine-list">
              {!routines.length ? (
                <div className="empty-routines">아직 예약된 일이 없습니다</div>
              ) : (
                routines.map((r) => (
                  <div className="routine" key={r.id || r.name}>
                    <div>
                      <div className="routine-name">{r.name || r.id}</div>
                      <div className="routine-meta">
                        {formatSchedule(r.schedule || "")} ·{" "}
                        {r.enabled === false ? "꺼짐" : "켜짐"}
                      </div>
                    </div>
                    <div className="routine-actions">
                      <button type="button" onClick={() => void onRun(r)}>
                        지금 실행
                      </button>
                      <button type="button" onClick={() => void onToggle(r)}>
                        {r.enabled === false ? "켜기" : "끄기"}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEditId(r.id || r.name);
                          setEditName(r.name || "");
                          setEditPrompt(r.prompt || "");
                          setEditSchedule(r.schedule || "");
                        }}
                      >
                        수정
                      </button>
                      <button type="button" onClick={() => void toggleRuns(r)}>
                        기록
                      </button>
                      <button type="button" onClick={() => void onDelete(r)}>
                        삭제
                      </button>
                    </div>
                    {editId === (r.id || r.name) ? (
                      <div className="routine-edit">
                        <input
                          className="textin"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          placeholder="이름"
                        />
                        <input
                          className="textin"
                          value={editSchedule}
                          onChange={(e) => setEditSchedule(e.target.value)}
                          placeholder="cron 또는 평일 8시에 브리핑"
                        />
                        <textarea
                          className="textin"
                          value={editPrompt}
                          onChange={(e) => setEditPrompt(e.target.value)}
                          placeholder="시킬 일"
                        />
                        <div className="actions">
                          <button
                            type="button"
                            className="primary"
                            disabled={busy}
                            onClick={() => void saveEdit(r)}
                          >
                            저장
                          </button>
                          <button type="button" onClick={() => setEditId(null)}>
                            취소
                          </button>
                        </div>
                      </div>
                    ) : null}
                    {runsFor === (r.id || r.name) ? (
                      <div className="routine-runs">
                        {!runs.length ? (
                          <div className="empty-routines">아직 실행 기록이 없습니다</div>
                        ) : (
                          runs
                            .slice()
                            .reverse()
                            .map((run) => (
                              <div
                                key={run.ts}
                                className={"routine-run" + (run.ok ? "" : " is-fail")}
                              >
                                {run.ok ? "성공" : "실패"} ·{" "}
                                {new Date(run.ts).toLocaleString()}
                                {run.detail && run.detail !== "ok"
                                  ? ` · ${run.detail}`
                                  : ""}
                              </div>
                            ))
                        )}
                      </div>
                    ) : null}
                  </div>
                ))
              )}
            </div>
          </div>
          <div className="pane-block">
            <div className="pane-label">말로 추가</div>
            <Field label="예: 평일 8시에 브리핑" htmlFor="routine-nl">
              <textarea
                id="routine-nl"
                className="textin"
                placeholder="Every weekday at 8:00 AM, post a briefing"
                value={nl}
                onChange={(e) => setNl(e.target.value)}
              />
            </Field>
            <div className="actions">
              <button
                type="button"
                className="primary"
                disabled={busy || !nl.trim()}
                onClick={() => void submitNl()}
              >
                만들기
              </button>
            </div>
          </div>
          <div className="pane-block">
            <div className="pane-label">새로 추가</div>
        <Field label="이름" htmlFor="routine-name">
          <input
            id="routine-name"
            ref={nameRef}
            className="textin"
            placeholder="아침 브리핑"
            autoComplete="off"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submit();
              }
            }}
          />
        </Field>
        <Field label="언제">
          <Seg value={repeat} options={REPEAT_OPTIONS} onChange={setRepeat} />
        </Field>
        {repeat === "weekly" ? (
          <Field label="요일">
            <div className="dow-row">
              {WEEKDAYS.map((d) => (
                <button
                  key={d.value}
                  type="button"
                  className={"dow-pick" + (days.includes(d.value) ? " on" : "")}
                  aria-pressed={days.includes(d.value)}
                  aria-label={d.label}
                  onClick={() => toggleDay(d.value)}
                >
                  {d.short}
                </button>
              ))}
            </div>
          </Field>
        ) : null}
        {repeat === "hourly" ? (
          <p className="apply-note">한 시간마다 정각에 실행합니다.</p>
        ) : (
          <Field label="시각" htmlFor="routine-time">
            <input
              id="routine-time"
              className="textin timein"
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          </Field>
        )}
        <Field label="시킬 일" htmlFor="routine-prompt">
          <textarea
            id="routine-prompt"
            ref={promptRef}
            className="textin"
            placeholder="오늘 할 일을 정리해서 알려줘"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </Field>
            <div className="actions">
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => void submit()}
              >
                추가
              </button>
            </div>
          </div>
    </div>
  );
}
