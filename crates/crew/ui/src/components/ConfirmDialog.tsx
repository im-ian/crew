import { useEffect, useState } from "react";
import type { ConfirmKind } from "../types";
import { Modal } from "./Modal";

type Props = {
  open: boolean;
  kind: ConfirmKind;
  onCancel: () => void;
  onConfirm: (dropRoutines: boolean) => void;
};

export function ConfirmDialog({ open, kind, onCancel, onConfirm }: Props) {
  const [drop, setDrop] = useState(false);

  useEffect(() => {
    if (open) setDrop(false);
  }, [open]);

  let title = "히스토리를 지울까요?";
  let body =
    "이름과 역할은 그대로이고, 대화 맥락만 빈 새 세션이 됩니다. 채널은 유지됩니다.";
  let ok = "지우기";
  let okClass = "primary";
  let showToggle = true;

  if (kind === "remove") {
    title = "봇을 삭제할까요?";
    body = "에이전트와 실행 중인 세션이 제거됩니다.";
    ok = "삭제";
    okClass = "danger";
    showToggle = false;
  } else if (kind === "leave-channel") {
    title = "이 채널에서 나갈까요?";
    body = "채널이 목록에서 제거됩니다.";
    ok = "나가기";
    okClass = "danger";
    showToggle = false;
  } else if (kind === "remove-channel") {
    title = "채널을 삭제할까요?";
    body = "채널과 대화가 제거됩니다.";
    ok = "삭제";
    okClass = "danger";
    showToggle = false;
  } else if (kind === "remove-group") {
    title = "그룹을 삭제할까요?";
    body = "그룹만 사라지고, 안의 대화는 목록에 남습니다.";
    ok = "삭제";
    okClass = "danger";
    showToggle = false;
  }

  return (
    <Modal open={open} title={title} onClose={onCancel}>
      <p>{body}</p>
      {showToggle ? (
        <label className="toggle">
          <input
            type="checkbox"
            checked={drop}
            onChange={(e) => setDrop(e.target.checked)}
          />
          루틴도 함께 제거
        </label>
      ) : null}
      <div className="actions spread">
        <button type="button" className="ghost" onClick={onCancel}>
          취소
        </button>
        <button type="button" className={okClass} onClick={() => onConfirm(drop)}>
          {ok}
        </button>
      </div>
    </Modal>
  );
}
