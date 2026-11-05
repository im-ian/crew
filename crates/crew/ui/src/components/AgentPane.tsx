import { handleBackdropPointerDown } from "../dialogLayer";
import { useT } from "../LocaleContext";
import type { AgentInfo, CliKind, PaneTab, Routine } from "../types";
import { InfoPane } from "./InfoPane";
import { RoutinesModal } from "./RoutinesModal";
import { X } from "../icons";

const TABS: { id: PaneTab; labelKey: "pane.tab.info" | "pane.tab.routines" }[] = [
  { id: "info", labelKey: "pane.tab.info" },
  { id: "routines", labelKey: "pane.tab.routines" },
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
}: Props) {
  const t = useT();
  return (
    <div
      className={"overlay" + (open ? " open" : "")}
      onPointerDown={(e) => handleBackdropPointerDown(e, onClose)}
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
        </div>
      </div>
    </div>
  );
}
