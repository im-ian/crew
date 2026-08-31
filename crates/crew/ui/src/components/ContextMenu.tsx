export type MenuEntry =
  | { type: "action"; label: string; danger?: boolean; onClick: () => void }
  | { type: "sep" }
  | { type: "sub"; label: string; items: MenuEntry[] };

type Props = {
  open: boolean;
  x: number;
  y: number;
  items: MenuEntry[];
};

export function ContextMenu({ open, x, y, items }: Props) {
  return (
    <div
      className={"ctx" + (open ? " open" : "")}
      style={{ left: x, top: y }}
      onClick={(e) => e.stopPropagation()}
    >
      {open ? <MenuList items={items} /> : null}
    </div>
  );
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
            <div key={"sub-" + i} className="ctx-sub">
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
            {item.label}
          </button>
        );
      })}
    </>
  );
}
