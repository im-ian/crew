import { useEffect, useRef, useState } from "react";
import { useT } from "../LocaleContext";
import type { AgentInfo } from "../types";
import { Field } from "./Field";
import { MemberPicker } from "./MemberPicker";
import { Modal } from "./Modal";

type Props = {
  open: boolean;
  agents: AgentInfo[];
  onClose: () => void;
  onCreate: (name: string, members: string[]) => Promise<void>;
};

export function NewChannelModal({ open, agents, onClose, onCreate }: Props) {
  const t = useT();
  const [name, setName] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setMembers([]);
    setBusy(false);
    const t = window.setTimeout(() => nameRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [open]);

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed) {
      nameRef.current?.focus();
      await onCreate("", []);
      return;
    }
    setBusy(true);
    try {
      await onCreate(trimmed, members);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} title={t("newChannel.title")} onClose={onClose}>
      <div className="form-stack">
        <Field label={t("field.name")} htmlFor="new-channel-name">
          <input
            id="new-channel-name"
            ref={nameRef}
            className="textin"
            placeholder={t("channel.namePh")}
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
        <Field label={t("field.members")}>
          <MemberPicker agents={agents} selected={members} onChange={setMembers} />
        </Field>
      </div>
      <div className="actions spread">
        <button type="button" className="ghost" onClick={onClose}>
          {t("common.cancel")}
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => void submit()}
        >
          {t("common.create")}
        </button>
      </div>
    </Modal>
  );
}
