import { useEffect, useState } from "react";
import { useT } from "../LocaleContext";
import { api } from "../api";
import type { Skill } from "../types";
import { Field } from "./Field";
import { Modal } from "./Modal";

type Props = {
  open: boolean;
  onClose: () => void;
};

export function SkillsPane({ open, onClose }: Props) {
  const t = useT();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setEditing(null);
    setName("");
    setBody("");
    setArmed(false);
    setError("");
    void api
      .listSkills()
      .then(setSkills)
      .catch(() => setSkills([]));
  }, [open]);

  function pick(skill: Skill) {
    setEditing(skill.name);
    setName(skill.name);
    setBody(skill.body);
    setArmed(false);
    setError("");
  }

  function startNew() {
    setEditing(null);
    setName("");
    setBody("");
    setArmed(false);
    setError("");
  }

  async function save() {
    const n = name.trim();
    if (!n || !body.trim()) return;
    setBusy(true);
    setError("");
    try {
      const saved = await api.saveSkill(n, body);
      // A rename writes a new file; drop the one it replaced.
      if (editing && editing !== saved.name) {
        await api.removeSkill(editing).catch(() => {});
      }
      setSkills(await api.listSkills());
      setEditing(saved.name);
      setName(saved.name);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!editing) return;
    if (!armed) {
      setArmed(true);
      return;
    }
    setBusy(true);
    try {
      await api.removeSkill(editing);
      setSkills(await api.listSkills());
      startNew();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} title={t("skills.title")} onClose={onClose}>
      <div className="form-stack">
        <div className="pane-block">
          <div className="pane-label">{t("skills.list")}</div>
          <div className="skill-list">
            {!skills.length ? (
              <div className="empty-routines">{t("skills.empty")}</div>
            ) : (
              skills.map((s) => (
                <button
                  key={s.name}
                  type="button"
                  className={"skill-row" + (editing === s.name ? " is-open" : "")}
                  onClick={() => pick(s)}
                >
                  <span className="skill-name">/{s.name}</span>
                  <span className="skill-peek">{firstLine(s.body)}</span>
                </button>
              ))
            )}
          </div>
        </div>
        <div className="pane-block">
          <div className="pane-label">{editing ? t("common.edit") : t("skills.new")}</div>
          <Field label={t("field.name")} htmlFor="skill-name">
            <input
              id="skill-name"
              className="textin"
              autoComplete="off"
              placeholder={t("skills.namePh")}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label={t("skills.body")} htmlFor="skill-body">
            <textarea
              id="skill-body"
              className="textin skill-body"
              placeholder={t("skills.bodyPh")}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </Field>
          {error ? <p className="apply-note is-error">{error}</p> : null}
          <p className="apply-note">{t("skills.note")}</p>
          <div className="actions">
            <button
              type="button"
              className="primary"
              disabled={busy || !name.trim() || !body.trim()}
              onClick={() => void save()}
            >
              {t("common.save")}
            </button>
            {editing ? (
              <button type="button" disabled={busy} onClick={() => void remove()}>
                {armed ? t("skills.deleteAgain") : t("common.delete")}
              </button>
            ) : null}
            {editing ? (
              <button type="button" onClick={startNew}>
                {t("skills.new")}
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </Modal>
  );
}

function firstLine(body: string): string {
  const line = body
    .split("\n")
    .map((l) => l.trim().replace(/^#+\s*/, ""))
    .find(Boolean);
  return line ? line.slice(0, 60) : "";
}
