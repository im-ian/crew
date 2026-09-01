import { useEffect, useState } from "react";
import { useT } from "../LocaleContext";
import type { AgentInfo, PaneTab, Routine } from "../types";
import { Field } from "./Field";
import { InfoPane } from "./InfoPane";
import { RoutinesModal } from "./RoutinesModal";

const TABS: { id: PaneTab; labelKey: "pane.tab.info" | "pane.tab.routines" | "pane.tab.memory" }[] = [
  { id: "info", labelKey: "pane.tab.info" },
  { id: "routines", labelKey: "pane.tab.routines" },
  { id: "memory", labelKey: "pane.tab.memory" },
];

type Props = {
  open: boolean;
  tab: PaneTab;
  agent: AgentInfo | null;
  onTab: (tab: PaneTab) => void;
  onClose: () => void;
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
  onAddRoutine: (name: string, schedule: string, prompt: string) => Promise<void>;
  onToggleRoutine: (r: Routine) => Promise<void>;
  onDeleteRoutine: (r: Routine) => Promise<void>;
  onRunRoutine: (r: Routine) => Promise<void>;
  onEditRoutine: (
    r: Routine,
    fields: { name?: string; schedule?: string; prompt?: string },
  ) => Promise<void>;
  onLoadRoutineRuns: (r: Routine) => Promise<import("../types").RoutineRun[]>;
  onLoadMemory: (id: string) => Promise<string>;
  onSaveMemory: (text: string) => Promise<void>;
};

export function AgentPane({
  open,
  tab,
  agent,
  onTab,
  onClose,
  onReset,
  onSetFace,
  onSave,
  onAddRoutine,
  onToggleRoutine,
  onDeleteRoutine,
  onRunRoutine,
  onEditRoutine,
  onLoadRoutineRuns,
  onLoadMemory,
  onSaveMemory,
}: Props) {
  const t = useT();
  return (
    <div
      className={"overlay" + (open ? " open" : "")}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="sheet agent-sheet">
        <div className="sheet-head">
          <h3>{agent?.name || agent?.id || t("common.bot")}</h3>
          <button
            type="button"
            className="sheet-close"
            title={t("common.close")}
            aria-label={t("common.close")}
            onClick={onClose}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M4 4l8 8M12 4l-8 8"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
        <div className="pane-tabs" role="tablist">
          {TABS.map((tabDef) => (
            <button
              key={tabDef.id}
              type="button"
              role="tab"
              aria-selected={tab === tabDef.id}
              className={tab === tabDef.id ? "on" : ""}
              onClick={() => onTab(tabDef.id)}
            >
              {t(tabDef.labelKey)}
            </button>
          ))}
        </div>
        <div className="sheet-body">
          <div hidden={tab !== "info"}>
            <InfoPane
              open={open}
              agent={agent}
              onReset={onReset}
              onSetFace={onSetFace}
              onSave={onSave}
            />
          </div>
          <div hidden={tab !== "routines"}>
            <RoutinesModal
              open={open}
              agent={agent}
              onAdd={onAddRoutine}
              onToggle={onToggleRoutine}
              onDelete={onDeleteRoutine}
              onRun={onRunRoutine}
              onEdit={onEditRoutine}
              onLoadRuns={onLoadRoutineRuns}
            />
          </div>
          <div hidden={tab !== "memory"}>
            <MemoryTab
              open={open}
              agent={agent}
              onLoad={onLoadMemory}
              onSave={onSaveMemory}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function MemoryTab({
  open,
  agent,
  onLoad,
  onSave,
}: {
  open: boolean;
  agent: AgentInfo | null;
  onLoad: (id: string) => Promise<string>;
  onSave: (text: string) => Promise<void>;
}) {
  const t = useT();
  const [memory, setMemory] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!open || !agent) return;
    setMemory("");
    setSaved(false);
    void onLoad(agent.id).then((text) => {
      setMemory(text);
      setSaved(false);
    });
  }, [open, agent?.id]);

  return (
    <div className="form-stack">
      <p className="apply-note">{t("memory.note")}</p>
      <Field label={t("memory.label")} htmlFor="pane-memory">
        <textarea
          id="pane-memory"
          className="textin memory"
          placeholder={t("memory.placeholder")}
          value={memory}
          onChange={(e) => {
            setMemory(e.target.value);
            setSaved(false);
          }}
        />
      </Field>
      <div className="actions spread">
        <span className="apply-note">{saved ? t("memory.saved") : t("memory.unsaved")}</span>
        <button
          type="button"
          className="primary"
          onClick={async () => {
            await onSave(memory);
            setSaved(true);
          }}
        >
          {t("common.save")}
        </button>
      </div>
    </div>
  );
}
