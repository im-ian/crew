import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { addAi, dropIndex, moveAi, removeAi, type AiChoice } from "../aiList";
import { ChevronDown, ChevronUp, GripVertical, Plus, X } from "../icons";
import { useT } from "../LocaleContext";
import { CLIS } from "../options";
import { ModelPicker } from "./ModelPicker";

type Props = {
  list: AiChoice[];
  active: boolean;
  onChange: (list: AiChoice[]) => void;
};

type Drag = {
  from: number;
  to: number;
  /** Each row's vertical middle when the drag began, in the list's order. */
  mids: number[];
};

/**
 * The default AI as a list: the top one starts a new bot, and a turn whose
 * own AI is out of its limit runs on the others, top to bottom. A row moves
 * by its handle or by the arrows beside it.
 */
export function AiList({ list, active, onChange }: Props) {
  const t = useT();
  const rows = useRef<(HTMLDivElement | null)[]>([]);
  const [drag, setDrag] = useState<Drag | null>(null);
  // While a row is dragged the list shows where it would land.
  // Keyed by the place each row had before the drag, so the row being
  // dragged keeps its element and the pointer it holds.
  const order = list.map((_, i) => i);
  const shown = drag ? moveAi(order, drag.from, drag.to) : order;

  function change(index: number, next: Partial<AiChoice>) {
    onChange(list.map((ai, i) => (i === index ? { ...ai, ...next } : ai)));
  }

  function grab(e: ReactPointerEvent<HTMLButtonElement>, index: number) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const mids = rows.current.slice(0, list.length).map((row) => {
      const box = row?.getBoundingClientRect();
      return box ? box.top + box.height / 2 : 0;
    });
    setDrag({ from: index, to: index, mids });
  }

  function slide(e: ReactPointerEvent<HTMLButtonElement>) {
    if (!drag) return;
    const to = dropIndex(drag.mids, e.clientY, drag.from);
    if (to !== drag.to) setDrag({ ...drag, to });
  }

  function release() {
    if (!drag) return;
    if (drag.to !== drag.from) onChange(moveAi(list, drag.from, drag.to));
    setDrag(null);
  }

  return (
    <div className="ai-list">
      {shown.map((at, i) => {
        const ai = list[at];
        return (
        <div
          key={at}
          ref={(el) => {
            rows.current[i] = el;
          }}
          className={"ai-row" + (drag?.from === at ? " dragging" : "")}
        >
          <button
            type="button"
            className="ai-row-btn ai-grip"
            title={t("settings.ai.drag")}
            aria-label={t("settings.ai.drag")}
            disabled={list.length < 2}
            onPointerDown={(e) => grab(e, at)}
            onPointerMove={slide}
            onPointerUp={release}
            onPointerCancel={() => setDrag(null)}
            onDragStart={(e) => e.preventDefault()}
          >
            <GripVertical size={14} />
          </button>
          <div className="ai-pick">
            <ModelPicker
              cli={ai.cli}
              model={ai.model}
              effort={ai.effort}
              active={active}
              command={ai.cmd}
              onCli={(cli) => change(at, { cli, model: "", effort: "", cmd: "" })}
              onModel={(model) => change(at, { model })}
              onEffort={(effort) => change(at, { effort })}
              onCommand={(cmd) => change(at, { cmd })}
            />
          </div>
          <button
            type="button"
            className="ai-row-btn"
            title={t("settings.ai.up")}
            aria-label={t("settings.ai.up")}
            disabled={at === 0}
            onClick={() => onChange(moveAi(list, at, at - 1))}
          >
            <ChevronUp size={14} />
          </button>
          <button
            type="button"
            className="ai-row-btn"
            title={t("settings.ai.down")}
            aria-label={t("settings.ai.down")}
            disabled={at === list.length - 1}
            onClick={() => onChange(moveAi(list, at, at + 1))}
          >
            <ChevronDown size={14} />
          </button>
          <button
            type="button"
            className="ai-row-btn"
            title={t("settings.ai.remove")}
            aria-label={t("settings.ai.remove")}
            disabled={list.length < 2}
            onClick={() => onChange(removeAi(list, at))}
          >
            <X size={14} />
          </button>
        </div>
        );
      })}
      <button
        type="button"
        className="ghost settings-action"
        onClick={() => onChange(addAi(list, CLIS.map((c) => c.value)))}
      >
        <Plus size={14} />
        {t("settings.ai.add")}
      </button>
    </div>
  );
}
