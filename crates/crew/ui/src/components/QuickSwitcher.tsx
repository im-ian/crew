import { useEffect, useMemo, useRef, useState } from "react";
import { handleBackdropPointerDown } from "../dialogLayer";
import { useT } from "../LocaleContext";
import { imeKey, stepIndex, switchRows } from "../quickSwitch";
import type { AgentInfo, Group } from "../types";
import { statusView, waitingOn } from "../statusView";
import { Avatar } from "./Avatar";

type Props = {
  agents: readonly AgentInfo[];
  groups: readonly Group[];
  /** Bot ids top to bottom as the sidebar shows them. */
  order: readonly string[];
  /** Bot ids opened before, newest first. */
  recent: readonly string[];
  /** The chat open now. It goes last, marked. */
  current: string | null;
  onPick: (id: string) => void;
  onClose: () => void;
};

/**
 * ⌘K: a search field over the bots, at the top of the window. ↑↓ walk the
 * list, Enter opens the bot's chat, Escape or a click outside closes it.
 */
export function QuickSwitcher({ agents, groups, order, recent, current, onPick, onClose }: Props) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const rows = useMemo(
    () => switchRows({ agents, groups, order, recent, current, query }),
    [agents, groups, order, recent, current, query],
  );
  const active = rows.length ? Math.min(index, rows.length - 1) : -1;
  const now = Date.now();

  // Shut without a pick, the caret goes back where it was.
  useEffect(() => {
    const before = document.activeElement;
    inputRef.current?.focus();
    return () => {
      const now = document.activeElement;
      if (now && now !== document.body && now.isConnected) return;
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, []);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function pick(i: number) {
    const row = rows[i];
    if (row) onPick(row.agent.id);
  }

  return (
    <div
      className="modal open quick-switch"
      onPointerDown={(e) => handleBackdropPointerDown(e, onClose)}
    >
      <div className="dialog quick-switch-box" role="dialog" aria-label={t("switch.label")}>
        <input
          ref={inputRef}
          className="quick-switch-input"
          type="text"
          value={query}
          placeholder={t("switch.placeholder")}
          spellCheck={false}
          autoComplete="off"
          role="combobox"
          aria-expanded="true"
          aria-controls="quick-switch-list"
          aria-activedescendant={active >= 0 ? `quick-switch-${active}` : undefined}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              onClose();
              return;
            }
            if (e.key !== "Enter" && e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
            // The key that ends a Hangul syllable is the IME's, not the list's.
            if (imeKey(e.nativeEvent)) return;
            e.preventDefault();
            e.stopPropagation();
            if (e.key === "Enter") pick(active);
            else setIndex(stepIndex(active, rows.length, e.key === "ArrowDown" ? 1 : -1));
          }}
        />
        {rows.length ? (
          <ul className="quick-switch-list" id="quick-switch-list" role="listbox" ref={listRef}>
            {rows.map((row, i) => {
              const a = row.agent;
              const status = statusView(a, now, t);
              const here = a.id === current;
              return (
                <li
                  key={a.id}
                  id={`quick-switch-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={i === active}
                  className={"quick-switch-row" + (i === active ? " is-active" : "")}
                  // Keep the caret in the field.
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseMove={() => {
                    if (i !== active) setIndex(i);
                  }}
                  onClick={() => pick(i)}
                >
                  <Avatar
                    id={a.id}
                    name={a.name || a.id}
                    src={a.avatar}
                    shape={a.avatar_shape}
                    color={a.avatar_color}
                    badge={a.status || undefined}
                    status={a.status}
                    waiting={waitingOn(a).length > 0}
                  />
                  <span className="quick-switch-name">{a.name || a.id}</span>
                  {row.group ? <span className="quick-switch-group">{row.group}</span> : null}
                  <span className="quick-switch-tail">
                    {status ? (
                      <span className={"head-status is-" + status.tone}>
                        <span className="head-status-text">{status.text}</span>
                      </span>
                    ) : null}
                    {here ? <span className="quick-switch-here">{t("switch.current")}</span> : null}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="quick-switch-empty">{t("switch.empty")}</p>
        )}
        <div className="quick-switch-foot" aria-hidden="true">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> {t("switch.move")}
          </span>
          <span>
            <kbd>↩</kbd> {t("switch.open")}
          </span>
          <span>
            <kbd>Esc</kbd> {t("switch.close")}
          </span>
        </div>
      </div>
    </div>
  );
}
