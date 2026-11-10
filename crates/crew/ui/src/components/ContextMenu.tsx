import { useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { fitAxis, liftBy, MENU_MARGIN } from "../menuFit";

export type MenuEntry =
  | {
      type: "action";
      label: string;
      hint?: string;
      danger?: boolean;
      icon?: ReactNode;
      onClick: () => void;
    }
  | { type: "sep" }
  | { type: "sub"; label: string; items: MenuEntry[] };

type Props = {
  open: boolean;
  x: number;
  y: number;
  items: MenuEntry[];
};

export function ContextMenu({ open, x, y, items }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y, subsLeft: false });
  // Measured before paint, so a menu opened by the window's edge never shows
  // cut off first. The pointer is the corner it grows from.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!open || !el) return;
    // Measured in the corner, where the window's edge cannot squeeze it.
    el.style.left = "0px";
    el.style.top = "0px";
    const { width, height } = el.getBoundingClientRect();
    const left = fitAxis(x, width, window.innerWidth);
    const top = fitAxis(y, height, window.innerHeight);
    // A submenu opens to the right; when that runs out, every one opens left.
    const subsLeft = left + width + SUB_WIDTH > window.innerWidth - MENU_MARGIN;
    el.style.left = left + "px";
    el.style.top = top + "px";
    setPos((p) =>
      p.left === left && p.top === top && p.subsLeft === subsLeft ? p : { left, top, subsLeft },
    );
  }, [open, x, y, items]);
  return (
    <div
      ref={ref}
      className={"ctx" + (open ? " open" : "") + (pos.subsLeft ? " subs-left" : "")}
      style={open ? { left: pos.left, top: pos.top } : { left: x, top: y }}
      onClick={(e) => e.stopPropagation()}
    >
      {open ? <MenuList items={items} /> : null}
    </div>
  );
}

/** `.ctx.nested`'s min-width, the room a submenu wants beside its menu. */
const SUB_WIDTH = 148;

/** A submenu by the window's bottom moves up until all of it shows. */
function liftSubmenu(e: MouseEvent<HTMLDivElement>) {
  const nested = e.currentTarget.querySelector<HTMLElement>(":scope > .ctx.nested");
  if (!nested) return;
  nested.style.transform = "";
  const lift = liftBy(nested.getBoundingClientRect().bottom, window.innerHeight);
  if (lift) nested.style.transform = `translateY(${-lift}px)`;
}

function MenuList({ items }: { items: MenuEntry[] }) {
  return (
    <>
      {items.map((item, i) => {
        if (item.type === "sep") {
          return <div key={"sep-" + i} className="ctx-sep" />;
        }
        if (item.type === "sub") {
          return (
            <div key={"sub-" + i} className="ctx-sub" onMouseEnter={liftSubmenu}>
              <button type="button">
                {item.label}
                <span className="ctx-caret">›</span>
              </button>
              <div className="ctx nested">
                <MenuList items={item.items} />
              </div>
            </div>
          );
        }
        return (
          <button
            key={"act-" + i}
            type="button"
            className={item.danger ? "ctx-remove" : undefined}
            onClick={item.onClick}
          >
            {item.icon ? <span className="ctx-ico">{item.icon}</span> : null}
            {item.label}
            {item.hint ? <span className="ctx-hint">{item.hint}</span> : null}
          </button>
        );
      })}
    </>
  );
}
