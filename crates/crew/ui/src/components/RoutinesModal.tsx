import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
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
import type { Routine } from "../types";
import { ContextMenu } from "./ContextMenu";
import { Field } from "./Field";
import { Seg } from "./Seg";

/// A bot, or a channel addressed as `#room` — both keep a routine list.
export type RoutineHost = { id: string; routines?: Routine[] };

type Props = {
  open: boolean;
  agent: RoutineHost | null;
  onAdd: (name: string, schedule: string, prompt: string) => Promise<void>;
  onToggle: (r: Routine) => Promise<void>;
  onDelete: (r: Routine) => Promise<void>;
  onRun: (r: Routine) => Promise<void>;
};

export function RoutinesModal({
  open,
  agent,
  onAdd,
  onToggle,
  onDelete,
  onRun,
}: Props) {
  const t = useT();
  const [name, setName] = useState("");
  const [repeat, setRepeat] = useState<Repeat>("daily");
  const [days, setDays] = useState<number[]>([1]);
  const [time, setTime] = useState("09:00");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [nl, setNl] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; r: Routine } | null>(
    null,
  );
  const menuRef = useRef<HTMLDivElement>(null);
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
    setMenu(null);
  }, [open, agent?.id]);

  // Local rather than the app's menu: this one opens inside the right-hand
  // sheet, where it has to be kept on screen, and its Escape must not also
  // close the sheet under it.
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector("button")?.focus();
    const close = () => setMenu(null);
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      close();
    }
    document.addEventListener("click", close);
    document.addEventListener("contextmenu", close);
    document.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("contextmenu", close);
      document.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  function openMenu(e: MouseEvent | KeyboardEvent, r: Routine) {
    e.preventDefault();
    // Or the document listener above closes the menu this just opened.
    e.stopPropagation();
    const box = e.currentTarget.getBoundingClientRect();
    const fromKey = !("clientX" in e);
    const x = fromKey ? box.left + 12 : e.clientX;
    const y = fromKey ? box.bottom - 8 : e.clientY;
    setMenu({
      x: Math.min(x, window.innerWidth - 184),
      y: Math.min(y, window.innerHeight - 96),
      r,
    });
  }

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

  return (
    <div className="form-stack">
      {menu ? (
        <div className="routine-menu" ref={menuRef}>
          <ContextMenu
            open
            x={menu.x}
            y={menu.y}
            items={[
              {
                type: "action",
                label: t("common.runNow"),
                onClick: () => {
                  setMenu(null);
                  void onRun(menu.r);
                },
              },
              { type: "sep" },
              {
                type: "action",
                label: t("common.delete"),
                danger: true,
                onClick: () => {
                  setMenu(null);
                  void onDelete(menu.r);
                },
              },
            ]}
          />
        </div>
      ) : null}
          <div className="pane-block">
            <div className="pane-label">{t("routine.list")}</div>
            <div className="routine-list">
              {!routines.length ? (
                <div className="empty-routines">{t("routine.empty")}</div>
              ) : (
                routines.map((r) => (
                  <div
                    className={"routine" + (r.enabled === false ? " is-off" : "")}
                    key={r.id || r.name}
                    tabIndex={0}
                    title={t("routine.menuHint")}
                    onContextMenu={(e) => openMenu(e, r)}
                    onKeyDown={(e) => {
                      if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
                        openMenu(e, r);
                      }
                    }}
                  >
                    <div className="routine-text">
                      <div className="routine-name">{r.name || r.id}</div>
                      <div className="routine-meta">
                        {formatSchedule(r.schedule || "", t)}
                      </div>
                      {r.prompt ? (
                        <div className="routine-prompt">{r.prompt}</div>
                      ) : null}
                    </div>
                    {/* The state was a word in the meta line and a button that
                        said the opposite; a switch is both. */}
                    <input
                      type="checkbox"
                      role="switch"
                      className="switch"
                      checked={r.enabled !== false}
                      aria-label={r.name || r.id}
                      title={r.enabled === false ? t("common.off") : t("common.on")}
                      onChange={() => void onToggle(r)}
                    />
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
