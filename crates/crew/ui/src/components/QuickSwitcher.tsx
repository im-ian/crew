import { useEffect, useMemo, useRef, useState } from "react";
import { handleBackdropPointerDown } from "../dialogLayer";
import { useT } from "../LocaleContext";
import { Search } from "../icons";
import { imeKey, stepIndex, switchSections, type SwitchSection } from "../quickSwitch";
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
 * ⌘K: a large panel over the dimmed window, a search field over the bots in
 * sections (recent, then each folder and router). ↑↓ walk the list across
 * sections, Enter opens the bot's chat, Escape or a click outside closes it.
 */
export function QuickSwitcher({ agents, groups, order, recent, current, onPick, onClose }: Props) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const sections = useMemo(
    () => switchSections({ agents, groups, order, recent, current, query }),
    [agents, groups, order, recent, current, query],
  );
  const rows = useMemo(() => sections.flatMap((section) => section.rows), [sections]);
  // Where each section's rows start in the one list ↑↓ walk.
  const starts = useMemo(() => {
    let n = 0;
    return sections.map((section) => {
      const at = n;
      n += section.rows.length;
      return at;
    });
  }, [sections]);
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
    const list = listRef.current;
    if (!list) return;
    // The first row brings its section's heading along.
    if (active <= 0) {
      list.scrollTop = 0;
      return;
    }
    const el = list.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function heading(section: SwitchSection): string {
    const count = ` (${section.rows.length})`;
    switch (section.kind) {
      case "recent":
        return t("switch.recent");
      case "results":
        return t("switch.results") + count;
      case "loose":
        return t("switch.loose") + count;
      default:
        return section.title + count;
    }
  }

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
        <div className="quick-switch-search">
          <Search size={20} />
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
        </div>
        {rows.length ? (
          <div className="quick-switch-list" id="quick-switch-list" role="listbox" ref={listRef}>
            {sections.map((section, si) => {
              const first = starts[si];
              return (
                <section
                  key={section.key}
                  className="quick-switch-section"
                  role="group"
                  aria-label={heading(section)}
                >
                  <h4 className="quick-switch-heading">{heading(section)}</h4>
                  {section.rows.map((row, at) => {
                    const i = first + at;
                    const a = row.agent;
                    const status = statusView(a, now, t);
                    const here = a.id === current;
                    return (
                      <div
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
                        {/* Under a folder heading the folder goes without saying. */}
                        {row.group && (section.kind === "recent" || section.kind === "results") ? (
                          <span className="quick-switch-group">{row.group}</span>
                        ) : null}
                        <span className="quick-switch-tail">
                          {status ? (
                            <span className={"head-status is-" + status.tone}>
                              <span className="head-status-text">{status.text}</span>
                            </span>
                          ) : null}
                          {here ? <span className="quick-switch-here">{t("switch.current")}</span> : null}
                        </span>
                      </div>
                    );
                  })}
                </section>
              );
            })}
          </div>
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
