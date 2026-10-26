import { useEffect, useRef, useState } from "react";
import { useT } from "../LocaleContext";
import type { AgentInfo, CliKind, PaneTab, Routine } from "../types";
import { Field } from "./Field";
import { InfoPane } from "./InfoPane";
import { RoutinesModal } from "./RoutinesModal";
import { X } from "../icons";

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
    model: string;
    effort: string;
    cwd: string;
  }) => Promise<void>;
  onSetCli: (cli: CliKind, cmd?: string) => Promise<boolean>;
  onToggleRoutine: (r: Routine) => Promise<void>;
  onDeleteRoutine: (r: Routine) => Promise<void>;
  onRunRoutine: (r: Routine) => Promise<void>;
  onLoadMemory: (id: string) => Promise<string>;
  onSaveMemory: (text: string, base: string) => Promise<boolean>;
  agents: AgentInfo[];
  onLoadShared: () => Promise<string>;
  onSaveShared: (text: string, base: string) => Promise<boolean>;
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
  onSetCli,
  onToggleRoutine,
  onDeleteRoutine,
  onRunRoutine,
  onLoadMemory,
  onSaveMemory,
  agents,
  onLoadShared,
  onSaveShared,
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
            <X />
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
              onSetCli={onSetCli}
            />
          </div>
          <div hidden={tab !== "routines"}>
            <RoutinesModal
              open={open}
              agent={agent}
              onToggle={onToggleRoutine}
              onDelete={onDeleteRoutine}
              onRun={onRunRoutine}
            />
          </div>
          <div hidden={tab !== "memory"}>
            <MemoryTab
              open={open}
              agent={agent}
              agents={agents}
              onLoad={onLoadMemory}
              onSave={onSaveMemory}
              onLoadShared={onLoadShared}
              onSaveShared={onSaveShared}
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
  agents,
  onLoad,
  onSave,
  onLoadShared,
  onSaveShared,
}: {
  open: boolean;
  agent: AgentInfo | null;
  agents: AgentInfo[];
  onLoad: (id: string) => Promise<string>;
  onSave: (text: string, base: string) => Promise<boolean>;
  onLoadShared: () => Promise<string>;
  onSaveShared: (text: string, base: string) => Promise<boolean>;
}) {
  const t = useT();
  const [memory, setMemory] = useState("");
  const [saved, setSaved] = useState(false);
  const edited = useRef(false);
  // The text as loaded. Save only goes through if the file still matches it.
  const base = useRef("");
  const [shared, setShared] = useState("");
  const [sharedSaved, setSharedSaved] = useState(false);
  const sharedEdited = useRef(false);
  const sharedBase = useRef("");
  const team = agents
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((a) => `${a.name} (${a.id})`)
    .join(", ");

  useEffect(() => {
    if (!open || !agent) return;
    setMemory("");
    setSaved(false);
    edited.current = false;
    void onLoad(agent.id).then((text) => {
      base.current = text;
      setMemory(text);
      setSaved(false);
    });
    setShared("");
    setSharedSaved(false);
    sharedEdited.current = false;
    void onLoadShared().then((text) => {
      sharedBase.current = text;
      setShared(text);
      setSharedSaved(false);
    });
  }, [open, agent?.id]);

  // The bot keeps its own memory, so a finished turn may have changed it.
  // Show that unless the user is mid-edit.
  useEffect(() => {
    if (!open || !agent || agent.status === "working") return;
    if (!edited.current) {
      void onLoad(agent.id).then((text) => {
        if (edited.current) return;
        base.current = text;
        setMemory(text);
      });
    }
    if (!sharedEdited.current) {
      void onLoadShared().then((text) => {
        if (sharedEdited.current) return;
        sharedBase.current = text;
        setShared(text);
      });
    }
  }, [agent?.status]);

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
            edited.current = true;
          }}
        />
      </Field>
      <div className="actions">
        {saved ? <span className="apply-note">{t("memory.saved")}</span> : null}
        <button
          type="button"
          className="primary wide"
          onClick={async () => {
            if (!(await onSave(memory, base.current))) return;
            base.current = memory;
            setSaved(true);
            edited.current = false;
          }}
        >
          {t("common.save")}
        </button>
      </div>
      <p className="apply-note">{t("memory.sharedNote")}</p>
      {team ? <p className="apply-note">{t("memory.sharedTeam", { team })}</p> : null}
      <Field label={t("memory.sharedLabel")} htmlFor="pane-shared">
        <textarea
          id="pane-shared"
          className="textin memory"
          placeholder={t("memory.sharedPlaceholder")}
          value={shared}
          onChange={(e) => {
            setShared(e.target.value);
            setSharedSaved(false);
            sharedEdited.current = true;
          }}
        />
      </Field>
      <div className="actions">
        {sharedSaved ? <span className="apply-note">{t("memory.saved")}</span> : null}
        <button
          type="button"
          className="primary wide"
          onClick={async () => {
            if (!(await onSaveShared(shared, sharedBase.current))) return;
            sharedBase.current = shared;
            setSharedSaved(true);
            sharedEdited.current = false;
          }}
        >
          {t("common.save")}
        </button>
      </div>
    </div>
  );
}
