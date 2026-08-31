import type { Kind } from "../types";

type Props = {
  open: boolean;
  x: number;
  y: number;
  kind: Kind;
  onReset: () => void;
  onClone: () => void;
  onLeave: () => void;
  onRemove: () => void;
};

export function ContextMenu({
  open,
  x,
  y,
  kind,
  onReset,
  onClone,
  onLeave,
  onRemove,
}: Props) {
  const isCh = kind === "channel";
  return (
    <div
      className={"ctx" + (open ? " open" : "")}
      style={{ left: x, top: y }}
      onClick={(e) => e.stopPropagation()}
    >
      <button type="button" hidden={isCh} onClick={onReset}>
        히스토리 지우기
      </button>
      <button type="button" hidden={isCh} onClick={onClone}>
        봇 복제
      </button>
      <button type="button" hidden={!isCh} onClick={onLeave}>
        채널 나가기
      </button>
      <button type="button" className="ctx-remove" onClick={onRemove}>
        {isCh ? "채널 삭제" : "봇 삭제"}
      </button>
    </div>
  );
}
