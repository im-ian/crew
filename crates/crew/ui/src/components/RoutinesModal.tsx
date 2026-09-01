import { useEffect, useRef, useState } from "react";
import { useT } from "../LocaleContext";
import type { MessageKey } from "../locales";
import {
  WEEKDAYS,
  formatSchedule,
  parseTimeValue,
  repeatOptions,
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
  const t = useT();
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
            <div className="pane-label">{t("routine.list")}</div>
            <div className="routine-list">
              {!routines.length ? (
                <div className="empty-routines">{t("routine.empty")}</div>
              ) : (
                routines.map((r) => (
                  <div className="routine" key={r.id || r.name}>
                    <div>
                      <div className="routine-name">{r.name || r.id}</div>
                      <div className="routine-meta">
                        {formatSchedule(r.schedule || "", t)} ·{" "}
                        {r.enabled === false ? t("common.off") : t("common.on")}
                      </div>
                    </div>
                    <div className="routine-actions">
                      <button type="button" onClick={() => void onRun(r)}>
                        {t("common.runNow")}
                      </button>
                      <button type="button" onClick={() => void onToggle(r)}>
                        {r.enabled === false ? t("common.turnOn") : t("common.turnOff")}
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
                        {t("common.edit")}
                      </button>
                      <button type="button" onClick={() => void toggleRuns(r)}>
                        {t("routine.history")}
                      </button>
                      <button type="button" onClick={() => void onDelete(r)}>
                        {t("common.delete")}
                      </button>
                    </div>
                    {editId === (r.id || r.name) ? (
                      <div className="routine-edit">
                        <input
                          className="textin"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          placeholder={t("field.name")}
                        />
                        <input
                          className="textin"
                          value={editSchedule}
                          onChange={(e) => setEditSchedule(e.target.value)}
                          placeholder={t("routine.schedulePh")}
                        />
                        <textarea
                          className="textin"
                          value={editPrompt}
                          onChange={(e) => setEditPrompt(e.target.value)}
                          placeholder={t("routine.prompt")}
                        />
                        <div className="actions">
                          <button
                            type="button"
                            className="primary"
                            disabled={busy}
                            onClick={() => void saveEdit(r)}
                          >
                            {t("common.save")}
                          </button>
                          <button type="button" onClick={() => setEditId(null)}>
                            {t("common.cancel")}
                          </button>
                        </div>
                      </div>
                    ) : null}
                    {runsFor === (r.id || r.name) ? (
                      <div className="routine-runs">
                        {!runs.length ? (
                          <div className="empty-routines">{t("routine.runsEmpty")}</div>
                        ) : (
                          runs
                            .slice()
                            .reverse()
                            .map((run) => (
                              <div
                                key={run.ts}
                                className={"routine-run" + (run.ok ? "" : " is-fail")}
                              >
                                {run.ok ? t("common.ok") : t("common.fail")} ·{" "}
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
            <div className="pane-label">{t("routine.nl")}</div>
            <Field label={t("routine.nlLabel")} htmlFor="routine-nl">
              <textarea
                id="routine-nl"
                className="textin"
                placeholder={t("routine.nlPh")}
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
                {t("common.create")}
              </button>
            </div>
          </div>
          <div className="pane-block">
            <div className="pane-label">{t("routine.addNew")}</div>
        <Field label={t("field.name")} htmlFor="routine-name">
          <input
            id="routine-name"
            ref={nameRef}
            className="textin"
            placeholder={t("routine.namePh")}
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
        <Field label={t("routine.when")}>
          <Seg value={repeat} options={repeatOptions(t)} onChange={setRepeat} />
        </Field>
        {repeat === "weekly" ? (
          <Field label={t("routine.dow")}>
            <div className="dow-row">
              {WEEKDAYS.map((d) => (
                <button
                  key={d.value}
                  type="button"
                  className={"dow-pick" + (days.includes(d.value) ? " on" : "")}
                  aria-pressed={days.includes(d.value)}
                  aria-label={t(`dow.${d.value}` as MessageKey)}
                  onClick={() => toggleDay(d.value)}
                >
                  {t(`dow.${d.value}.short` as MessageKey)}
                </button>
              ))}
            </div>
          </Field>
        ) : null}
        {repeat === "hourly" ? (
          <p className="apply-note">{t("routine.hourlyNote")}</p>
        ) : (
          <Field label={t("routine.time")} htmlFor="routine-time">
            <input
              id="routine-time"
              className="textin timein"
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          </Field>
        )}
        <Field label={t("routine.prompt")} htmlFor="routine-prompt">
          <textarea
            id="routine-prompt"
            ref={promptRef}
            className="textin"
            placeholder={t("routine.promptPh")}
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
                {t("common.add")}
              </button>
            </div>
          </div>
    </div>
  );
}
