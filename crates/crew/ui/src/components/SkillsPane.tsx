import { useEffect, useRef, useState } from "react";
import { useT } from "../LocaleContext";
import { api } from "../api";
import { Plus } from "../icons";
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
  // What the user tried to leave to while edits were unsaved; the same
  // press again goes through and drops them.
  const [leaving, setLeaving] = useState<string | null>(null);
  // Another skill already has the typed name; the next save overwrites that
  // one, and only that one.
  const [clash, setClash] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const saved = skills.find((s) => s.name === editing);
  const dirty = !saved || name.trim() !== saved.name || body !== saved.body;
  const unsaved = saved ? dirty : Boolean(name.trim() || body.trim());

  useEffect(() => {
    if (!open) return;
    load(null);
    void api
      .listSkills()
      .then(setSkills)
      .catch(() => setSkills([]));
  }, [open]);

  function load(skill: Skill | null) {
    setEditing(skill?.name ?? null);
    setName(skill?.name ?? "");
    setBody(skill?.body ?? "");
    setArmed(false);
    setError("");
    setLeaving(null);
    setClash(null);
  }

  function leave(to: string, go: () => void) {
    if (unsaved && leaving !== to) {
      // One question at a time: the next press either leaves or saves.
      setClash(null);
      setLeaving(to);
      return;
    }
    go();
  }

  const close = () => leave("close", onClose);

  // The window holds the keyboard while open (App stays out), so Escape
  // runs the same unsaved check as a click outside.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.isComposing) return;
      e.preventDefault();
      close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function startNew() {
    leave("new", () => {
      load(null);
      nameRef.current?.focus();
    });
  }

  async function save() {
    const n = name.trim();
    if (!n || !body.trim()) return;
    setBusy(true);
    setError("");
    try {
      const res = await api.saveSkill(n, body, editing, clash);
      if (res.kind === "exists") {
        setLeaving(null);
        setClash(res.name);
        return;
      }
      setClash(null);
      setSkills(await api.listSkills());
      setEditing(res.skill.name);
      setName(res.skill.name);
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
      load(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title={t("skills.title")}
      onClose={close}
      className="skills-dialog"
    >
      <div className="skill-split">
        <div className="skill-side">
          <div className="field-head">
            <div className="pane-label">{t("skills.list")}</div>
            <button type="button" className="field-action skill-new" onClick={startNew}>
              <Plus size={13} />
              {t("skills.new")}
            </button>
          </div>
          <div className="skill-list">
            {!skills.length ? (
              <div className="skill-empty">{t("skills.empty")}</div>
            ) : (
              skills.map((s) => (
                <button
                  key={s.name}
                  type="button"
                  className={"skill-row" + (editing === s.name ? " is-open" : "")}
                  onClick={() => leave(s.name, () => load(s))}
                >
                  <span className="skill-name">/{s.name}</span>
                  <span className="skill-peek">{firstLine(s.body)}</span>
                </button>
              ))
            )}
          </div>
        </div>
        <div className="skill-detail">
          <div className="pane-label">{editing ? t("common.edit") : t("skills.new")}</div>
          <Field label={t("field.name")} htmlFor="skill-name">
            <div className="skill-slug">
              <input
                id="skill-name"
                ref={nameRef}
                className="textin"
                autoComplete="off"
                spellCheck={false}
                placeholder={t("skills.namePh")}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setLeaving(null);
                  setClash(null);
                }}
              />
            </div>
          </Field>
          <Field label={t("skills.body")} htmlFor="skill-body">
            <textarea
              id="skill-body"
              className="textin skill-body"
              placeholder={t("skills.bodyPh")}
              value={body}
              onChange={(e) => {
                setBody(e.target.value);
                setLeaving(null);
              }}
            />
          </Field>
          {error ? <p className="apply-note is-error">{error}</p> : null}
          {leaving ? <p className="apply-note is-error">{t("skills.unsaved")}</p> : null}
          {clash ? (
            <p className="apply-note is-error">{t("skills.exists", { name: clash })}</p>
          ) : null}
          <p className="apply-note">{t("skills.note")}</p>
          <div className={"actions" + (editing ? " spread" : "")}>
            {editing ? (
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={() => void remove()}
              >
                {armed ? t("skills.deleteAgain") : t("common.delete")}
              </button>
            ) : null}
            <button
              type="button"
              className="primary"
              disabled={busy || !dirty || !name.trim() || !body.trim()}
              onClick={() => void save()}
            >
              {clash ? t("skills.overwrite") : t("common.save")}
            </button>
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
