import { useEffect, useRef, useState } from "react";
import type { AvatarShape } from "../avatar";
import { useT } from "../LocaleContext";
import { cliFromCmd, effortOptions } from "../options";
import type { AgentInfo } from "../types";
import { Avatar } from "./Avatar";
import { FacePop } from "./FacePicker";
import { Field } from "./Field";
import { ModelSelect } from "./ModelSelect";
import { Seg } from "./Seg";

type Props = {
  open: boolean;
  agent: AgentInfo | null;
  onReset: () => void;
  onSetFace: (shape?: string | null, color?: string | null) => Promise<void>;
  onSave: (fields: {
    name: string;
    role: string;
    description: string;
    model: string;
    effort: string;
    cwd: string;
  }) => Promise<void>;
};

export function InfoPane({
  open,
  agent,
  onReset,
  onSetFace,
  onSave,
}: Props) {
  const t = useT();
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [description, setDescription] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [cwd, setCwd] = useState("");
  const saveTimer = useRef<number | null>(null);
  const fieldsRef = useRef({ name, role, description, model, effort, cwd });
  fieldsRef.current = { name, role, description, model, effort, cwd };

  useEffect(() => {
    if (!open || !agent) return;
    setName(agent.name || agent.id || "");
    setRole(agent.role || "");
    setDescription(agent.description || "");
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
      <Field label={t("field.role")} htmlFor="info-role">
        <input
          id="info-role"
          className="textin"
          placeholder={t("info.rolePh")}
          value={role}
          onChange={(e) => {
            setRole(e.target.value);
            scheduleSave({ role: e.target.value });
          }}
          onBlur={() => void flushSave()}
        />
      </Field>
      <Field label={t("field.description")} htmlFor="info-description">
        <textarea
          id="info-description"
          className="textin"
          placeholder={t("info.descPh")}
          value={description}
          onChange={(e) => {
            setDescription(e.target.value);
            scheduleSave({ description: e.target.value });
          }}
          onBlur={() => void flushSave()}
        />
      </Field>
      <Field label={t("field.model")} htmlFor="model">
        <ModelSelect
          id="model"
          cli={cliFromCmd(agent?.cmd)}
          value={model}
          onChange={(next) => {
            setModel(next);
            void flushSave({ model: next });
          }}
          active={open}
        />
      </Field>
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
      <Field label={t("field.effort")}>
        <Seg
          value={effort}
          options={effortOptions(t)}
          onChange={(next) => {
            setEffort(next);
            void flushSave({ effort: next });
          }}
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
