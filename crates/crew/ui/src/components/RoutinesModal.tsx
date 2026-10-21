import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { useT } from "../LocaleContext";
import { formatSchedule } from "../schedule";
import type { Routine } from "../types";
import { ContextMenu } from "./ContextMenu";

/// A bot, or a channel addressed as `#room` — both keep a routine list.
export type RoutineHost = { id: string; routines?: Routine[] };

type Props = {
  open: boolean;
  agent: RoutineHost | null;
  onToggle: (r: Routine) => Promise<void>;
  onDelete: (r: Routine) => Promise<void>;
  onRun: (r: Routine) => Promise<void>;
};

/// Routines are added and changed by asking a bot in chat, which runs
/// `crew routine`; this sheet only lists them.
export function RoutinesModal({
  open,
  agent,
  onToggle,
  onDelete,
  onRun,
}: Props) {
  const t = useT();
  const [menu, setMenu] = useState<{ x: number; y: number; r: Routine } | null>(
    null,
  );
  const menuRef = useRef<HTMLDivElement>(null);
  const routines = (agent && agent.routines) || [];

  useEffect(() => {
    if (!open) return;
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
    </div>
  );
}
