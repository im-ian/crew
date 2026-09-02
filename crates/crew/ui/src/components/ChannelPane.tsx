import { useEffect, useRef, useState } from "react";
import { useT } from "../LocaleContext";
import type { AgentInfo, ChannelInfo, PaneTab, Routine, RoutineRun } from "../types";
import { Field } from "./Field";
import { MemberPicker } from "./MemberPicker";
import { RoutinesModal } from "./RoutinesModal";

type Props = {
  open: boolean;
  tab: PaneTab;
  channel: ChannelInfo | null;
  agents: AgentInfo[];
  onTab: (tab: PaneTab) => void;
  onClose: () => void;
  onSave: (fields: {
    name: string;
    brief: string;
    members: string[];
  }) => Promise<void>;
  onAddRoutine: (name: string, schedule: string, prompt: string) => Promise<void>;
  onToggleRoutine: (r: Routine) => Promise<void>;
  onDeleteRoutine: (r: Routine) => Promise<void>;
  onRunRoutine: (r: Routine) => Promise<void>;
  onEditRoutine: (
    r: Routine,
    fields: { name?: string; schedule?: string; prompt?: string },
  ) => Promise<void>;
  onLoadRoutineRuns: (r: Routine) => Promise<RoutineRun[]>;
};

const TABS: { id: PaneTab; labelKey: "pane.tab.channel" | "pane.tab.routines" }[] = [
  { id: "info", labelKey: "pane.tab.channel" },
  { id: "routines", labelKey: "pane.tab.routines" },
];

export function ChannelPane({
  open,
  tab,
  channel,
  agents,
  onTab,
  onClose,
  onSave,
  onAddRoutine,
  onToggleRoutine,
  onDeleteRoutine,
  onRunRoutine,
  onEditRoutine,
  onLoadRoutineRuns,
}: Props) {
  const t = useT();
  const [name, setName] = useState("");
  const [brief, setBrief] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const saveTimer = useRef<number | null>(null);
  const fieldsRef = useRef({ name, brief, members });
  fieldsRef.current = { name, brief, members };

  useEffect(() => {
    if (!open || !channel) return;
    setName(channel.name || channel.id || "");
    setBrief(channel.brief || "");
    setMembers(channel.members.slice());
  }, [open, channel?.id, agents.length]);

  function scheduleSave(next?: Partial<typeof fieldsRef.current>) {
    const merged = { ...fieldsRef.current, ...next };
    fieldsRef.current = merged;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void onSave({
        name: merged.name,
        brief: merged.brief,
        members: merged.members,
      });
    }, 400);
  }

  async function flushSave(next?: Partial<typeof fieldsRef.current>) {
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const merged = { ...fieldsRef.current, ...next };
    fieldsRef.current = merged;
    await onSave({
      name: merged.name,
      brief: merged.brief,
      members: merged.members,
    });
  }

  return (
    <div
      className={"overlay" + (open ? " open" : "")}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="sheet agent-sheet">
        <div className="sheet-head">
          <h3>{channel?.name || channel?.id || t("common.channel")}</h3>
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
          <div className="form-stack" hidden={tab !== "info"}>
            <Field label={t("field.name")} htmlFor="channel-name">
              <input
                id="channel-name"
                className="textin"
                placeholder={t("channel.namePh")}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  scheduleSave({ name: e.target.value });
                }}
                onBlur={() => void flushSave()}
              />
            </Field>
            <Field label={t("field.brief")} htmlFor="channel-brief">
              <textarea
                id="channel-brief"
                className="textin memory"
                placeholder={t("channel.briefPh")}
                value={brief}
                onChange={(e) => {
                  setBrief(e.target.value);
                  scheduleSave({ brief: e.target.value });
                }}
                onBlur={() => void flushSave()}
              />
            </Field>
            <Field label={t("field.members")}>
              <MemberPicker
                agents={agents}
                selected={members}
                onChange={(next) => {
                  setMembers(next);
                  void flushSave({ members: next });
                }}
              />
            </Field>
            <p className="apply-note">{t("channel.applyNote")}</p>
          </div>
          <div hidden={tab !== "routines"}>
            <p className="apply-note">{t("channel.routineNote")}</p>
            <RoutinesModal
              open={open}
              agent={channel ? { id: channel.id, routines: channel.routines } : null}
              onAdd={onAddRoutine}
              onToggle={onToggleRoutine}
              onDelete={onDeleteRoutine}
              onRun={onRunRoutine}
              onEdit={onEditRoutine}
              onLoadRuns={onLoadRoutineRuns}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
