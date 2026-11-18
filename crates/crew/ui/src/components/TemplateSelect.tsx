import { useEffect, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown } from "../icons";
import { useT } from "../LocaleContext";
import { NO_TEMPLATE, stepTemplate, templateOrder } from "../newTeam";
import type { Template } from "../templates";
import { usePopover } from "../usePopover";
import { TemplateFaces } from "./TemplateFace";

type Props = {
  templates: Template[];
  /** A template id, or `NO_TEMPLATE`. */
  value: string;
  active: boolean;
  onChange: (id: string) => void;
};

/**
 * The bot template for a new group, shaped like the model picker: the closed
 * button shows the pick and its faces, the list opens below. ↑ ↓ move,
 * Enter picks, Escape closes.
 */
export function TemplateSelect({ templates, value, active, onChange }: Props) {
  const t = useT();
  const { open, setOpen, rootRef } = usePopover(active);
  const [cursor, setCursor] = useState(value);
  const order = templateOrder(templates);
  const chosen = templates.find((x) => x.id === value) ?? null;
  const crew = templates.filter((x) => x.builtin);
  const mine = templates.filter((x) => !x.builtin);

  useEffect(() => {
    if (open) setCursor(value);
  }, [open, value]);

  function pick(id: string) {
    onChange(id);
    setOpen(false);
  }

  function onKey(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      setCursor((cur) => stepTemplate(order, cur, e.key === "ArrowDown" ? 1 : -1));
    } else if (e.key === "Enter" && open) {
      e.preventDefault();
      pick(cursor);
    }
  }

  function row(id: string, x: Template | null) {
    const on = id === value;
    return (
      <button
        key={id || "none"}
        type="button"
        role="option"
        aria-selected={on}
        className={"model-pick-row tpl-row" + (on ? " on" : "") + (id === cursor ? " is-active" : "")}
        onMouseEnter={() => setCursor(id)}
        onClick={() => pick(id)}
      >
        <span className="tpl-row-check">{on ? <Check size={14} /> : null}</span>
        <span className="tpl-row-main">
          <span className="tpl-row-name">
            {x ? x.name : t("newGroup.noTemplate")}
            {x?.builtin ? <span className="tpl-chip">{t("templates.chip")}</span> : null}
          </span>
          <span className="tpl-row-desc">{x ? x.description : t("newGroup.noTemplateDesc")}</span>
        </span>
        {x ? (
          <span className="tpl-row-side">
            <TemplateFaces template={x} size="xs" stack />
            <span className="tpl-row-count">{t("templates.bots", { n: String(x.bots.length) })}</span>
          </span>
        ) : null}
      </button>
    );
  }

  return (
    <div className={"model-pick tpl-select" + (open ? " open" : "")} ref={rootRef}>
      <button
        type="button"
        id="new-group-template"
        className="textin model-pick-hit tpl-select-hit"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onKeyDown={onKey}
      >
        <span className="model-pick-name">{chosen ? chosen.name : t("newGroup.noTemplate")}</span>
        {chosen?.builtin ? <span className="tpl-chip">{t("templates.chip")}</span> : null}
        {chosen ? <TemplateFaces template={chosen} size="xs" stack /> : <span className="tpl-hit-sub" />}
        <ChevronDown size={14} />
      </button>
      {open ? (
        <div className="model-pick-card tpl-select-card" role="listbox" aria-label={t("newGroup.template")}>
          {row(NO_TEMPLATE, null)}
          {crew.length ? <div className="tpl-group-h">{t("templates.builtin")}</div> : null}
          {crew.map((x) => row(x.id, x))}
          {mine.length ? <div className="tpl-group-h">{t("templates.mine")}</div> : null}
          {mine.map((x) => row(x.id, x))}
          <p className="model-pick-note tpl-keys">
            <kbd>↑</kbd>
            <kbd>↓</kbd> {t("newGroup.keys.move")} · <kbd>Enter</kbd> {t("newGroup.keys.pick")} ·{" "}
            <kbd>Esc</kbd> {t("newGroup.keys.close")}
          </p>
        </div>
      ) : null}
    </div>
  );
}
