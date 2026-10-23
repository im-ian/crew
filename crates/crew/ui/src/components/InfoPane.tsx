import { useEffect, useRef, useState } from "react";
import type { AvatarShape } from "../avatar";
import { useT } from "../LocaleContext";
import { cliFromCmd, formatCmd } from "../options";
import type { AgentInfo, CliKind } from "../types";
import { Avatar } from "./Avatar";
import { FacePop } from "./FacePicker";
import { Field } from "./Field";
import { ModelPicker } from "./ModelPicker";

type Props = {
  open: boolean;
  agent: AgentInfo | null;
  onReset: () => void;
  onSetFace: (shape?: string | null, color?: string | null) => Promise<void>;
  onSave: (fields: {
    name: string;
    model: string;
    effort: string;
    cwd: string;
  }) => Promise<void>;
  onSetCli: (cli: CliKind, cmd?: string) => Promise<boolean>;
};

export function InfoPane({
  open,
  agent,
  onReset,
  onSetFace,
  onSave,
  onSetCli,
}: Props) {
  const t = useT();
  const fromAgent = cliFromCmd(agent?.cmd, agent?.headless);
  const [draftCli, setDraftCli] = useState<CliKind | null>(null);
  const cli = draftCli ?? fromAgent;
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [cwd, setCwd] = useState("");
  const [command, setCommand] = useState("");
  const saveTimer = useRef<number | null>(null);
  // Until the list refreshes the card still shows the old CLI's models, and a
  // pick from it would land on the new CLI.
  const switching = useRef(false);
  const fieldsRef = useRef({ name, model, effort, cwd });
  fieldsRef.current = { name, model, effort, cwd };

  const cmdKey = agent?.cmd?.join("\0") ?? "";
  useEffect(() => {
    setDraftCli(null);
    setCommand(formatCmd(agent?.cmd));
  }, [open, agent?.id, agent?.headless, cmdKey]);

  useEffect(() => {
    if (!open || !agent) return;
    setName(agent.name || agent.id || "");
    setModel(agent.model || "");
    setEffort(agent.effort || "");
    setCwd(agent.cwd || "");
  }, [open, agent?.id]);

  function scheduleSave(next?: Partial<typeof fieldsRef.current>) {
    const merged = { ...fieldsRef.current, ...next };
    fieldsRef.current = merged;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void onSave(merged);
    }, 400);
  }

  async function flushSave(next?: Partial<typeof fieldsRef.current>) {
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const merged = { ...fieldsRef.current, ...next };
    fieldsRef.current = merged;
    await onSave(merged);
  }

  return (
    <div className="form-stack">
      <div className="info-hero">
        <FacePop
          key={agent?.id || "face"}
          active={open}
          id={agent?.id}
          shape={agent?.avatar_shape}
          color={agent?.avatar_color}
          onShape={(next: AvatarShape) => {
            void onSetFace(next, undefined);
          }}
          onColor={(next) => {
            void onSetFace(undefined, next);
          }}
          onFace={(nextShape, nextColor) => {
            void onSetFace(nextShape, nextColor);
          }}
        >
          <Avatar
            className="info-avatar"
            id={agent?.id}
            name={agent?.name || agent?.id}
            src={agent?.avatar}
            shape={agent?.avatar_shape}
            color={agent?.avatar_color}
            status={agent?.status}
          />
        </FacePop>
      </div>
      <Field label={t("field.name")} htmlFor="info-name">
        <input
          id="info-name"
          className="textin"
          placeholder={t("info.namePh")}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            scheduleSave({ name: e.target.value });
          }}
          onBlur={() => void flushSave()}
        />
      </Field>
      {/* A bot on its own command has no CLI to pick for. */}
      {cli ? (
        <Field label={t("field.ai")}>
          <ModelPicker
            cli={cli}
            model={model}
            effort={effort}
            command={command}
            active={open}
            onCli={async (next) => {
              if (next === "custom") {
                setDraftCli("custom");
                setCommand("");
                return;
              }
              if (switching.current) return;
              switching.current = true;
              try {
                // Land pending edits under the old CLI; the switch drops its model.
                await flushSave();
                if (await onSetCli(next)) {
                  setDraftCli(null);
                  setModel("");
                }
              } finally {
                switching.current = false;
              }
            }}
            onCommand={setCommand}
            onCommandCommit={async (raw) => {
              const trimmed = raw.trim();
              if (!trimmed || trimmed === formatCmd(agent?.cmd).trim()) return;
              if (switching.current) return;
              switching.current = true;
              try {
                await flushSave();
                if (await onSetCli("custom", trimmed)) {
                  setDraftCli(null);
                  setModel("");
                }
              } finally {
                switching.current = false;
              }
            }}
            onModel={(next) => {
              if (switching.current) return;
              setModel(next);
              void flushSave({ model: next });
            }}
            onEffort={(next) => {
              if (switching.current) return;
              setEffort(next);
              void flushSave({ effort: next });
            }}
          />
        </Field>
      ) : null}
      <Field label={t("field.cwd")} htmlFor="info-cwd">
        <input
          id="info-cwd"
          className="textin"
          placeholder={t("info.cwdPh")}
          value={cwd}
          onChange={(e) => {
            setCwd(e.target.value);
            scheduleSave({ cwd: e.target.value });
          }}
          onBlur={() => void flushSave()}
        />
      </Field>
      <p className="apply-note">{t("info.applyNote")}</p>
      <div className="actions">
        <button type="button" className="danger" onClick={onReset}>
          {t("info.clearChat")}
        </button>
      </div>
    </div>
  );
}
