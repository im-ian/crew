import { useEffect, useRef, useState } from "react";
import { loadAiList } from "../aiListSync";
import { folderName } from "../groups";
import type { TFn } from "../i18n";
import { LoaderCircle, Pencil } from "../icons";
import { api, errMsg } from "../api";
import type { GroupMade } from "../makeTeam";
import { useT } from "../LocaleContext";
import {
  NO_TEMPLATE,
  refill,
  swapLine,
  teamOf,
  type BotAi,
  type GroupFields,
  type TeamBot,
} from "../newTeam";
import { CLIS } from "../options";
import { exhaustedClis, type CliState, type Template } from "../templates";
import { templateBotLine } from "../templateEdit";
import type { CliKind } from "../types";
import { Field } from "./Field";
import { FolderPick } from "./FolderPick";
import { Modal } from "./Modal";
import { ModelPicker } from "./ModelPicker";
import { Seg } from "./Seg";
import { TemplateFace } from "./TemplateFace";
import { TemplateSelect } from "./TemplateSelect";

export type NewGroup = {
  name: string;
  path: string;
  memory: string;
  worktree: boolean;
  /** The bots to make in it, the lead marked. Empty for a group with none. */
  team: TeamBot[];
};

type Props = {
  open: boolean;
  onClose: () => void;
  onPickFolder: () => Promise<string | null>;
  /** Resolves when the bots are made or making them stopped. On success the
      dialog is closed by the caller. */
  onCreate: (group: NewGroup, progress: (done: number, total: number) => void) => Promise<GroupMade>;
};

const BLANK: GroupFields = { memory: "", worktree: true, memoryEdited: false, worktreeEdited: false };

/** What the app knows of each CLI here: installed, its models, out of its limit. */
async function readCliStates(): Promise<Record<string, CliState>> {
  const clis = CLIS.map((c) => c.value).filter((c) => c !== "custom");
  const lists = await Promise.allSettled(clis.map((cli) => api.listModels(cli)));
  const usage = await api.planUsage(["claude", "grok", "codex"]).catch(() => []);
  const out = exhaustedClis(usage, Date.now() / 1000);
  const states: Record<string, CliState> = {};
  clis.forEach((cli, i) => {
    const got = lists[i];
    if (got.status !== "fulfilled") return;
    states[cli] = { installed: got.value.installed, models: got.value.models, exhausted: out.has(cli) };
  });
  return states;
}

/**
 * A new group: its name, folder, memory and worktree switch on the left, and
 * on the right the template whose bots it starts with. Each bot shows the AI
 * it gets on this PC, and the user can change it before the group is made.
 */
export function NewGroupModal({ open, onClose, onPickFolder, onCreate }: Props) {
  const t = useT();
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [fields, setFields] = useState<GroupFields>(BLANK);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templateId, setTemplateId] = useState(NO_TEMPLATE);
  const [states, setStates] = useState<Record<string, CliState>>({});
  const [aiOrder, setAiOrder] = useState<string[]>([]);
  const [picks, setPicks] = useState<Record<number, BotAi>>({});
  const [editing, setEditing] = useState<number | null>(null);
  const [making, setMaking] = useState<{ done: number; total: number } | null>(null);
  const [failure, setFailure] = useState<Extract<GroupMade, { ok: false }> | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const nameEdited = useRef(false);

  useEffect(() => {
    if (!open) return;
    setMaking(null);
    setFailure(null);
    setName("");
    setPath("");
    setFields(BLANK);
    setTemplateId(NO_TEMPLATE);
    setPicks({});
    setEditing(null);
    nameEdited.current = false;
    let gone = false;
    void api
      .listTemplates()
      .then((list) => !gone && setTemplates(list))
      .catch(() => {});
    void readCliStates().then((s) => !gone && setStates(s));
    void loadAiList()
      .then((list) => !gone && setAiOrder(list.map((a) => a.cli)))
      .catch(() => {});
    const timer = window.setTimeout(() => nameRef.current?.focus(), 0);
    return () => {
      gone = true;
      window.clearTimeout(timer);
    };
  }, [open]);

  const template = templates.find((x) => x.id === templateId) ?? null;
  const team = teamOf(template, states, aiOrder, picks);

  function chooseTemplate(id: string) {
    setTemplateId(id);
    setPicks({});
    setEditing(null);
    setFields((cur) => refill(cur, templates.find((x) => x.id === id) ?? null));
  }

  async function submit() {
    if (making) return;
    const trimmed = name.trim();
    if (!trimmed) {
      nameRef.current?.focus();
      return;
    }
    setFailure(null);
    setMaking({ done: 0, total: team.length });
    try {
      const result = await onCreate(
        { name: trimmed, path: path.trim(), memory: fields.memory, worktree: fields.worktree, team },
        (done, total) => setMaking({ done, total }),
      );
      if (!result.ok) setFailure(result);
    } catch (err) {
      setFailure({ ok: false, stage: "reserve", error: errMsg(err), made: [], total: team.length, groupName: trimmed });
    } finally {
      setMaking(null);
    }
  }

  // Some bots were made: the group is there, so making it again would make
  // a second one. Only closing is left.
  const stuck = failure?.stage === "add";
  const locked = !!making || stuck;

  const from = template ? t("newGroup.fromTemplate", { name: template.name }) : null;

  return (
    <Modal open={open} title={t("newGroup.title")} onClose={onClose} className="ng-dialog">
      <fieldset className="ng-fieldset" disabled={locked}>
      <div className="ng-cols">
        <div className="ng-col ng-info">
          <h4 className="ng-h">{t("newGroup.info")}</h4>
          <Field label={t("field.name")} htmlFor="new-group-name" hint={t("newGroup.nameHint")}>
            <input
              id="new-group-name"
              ref={nameRef}
              className="textin"
              placeholder={t("newGroup.namePh")}
              autoComplete="off"
              value={name}
              onChange={(e) => {
                nameEdited.current = true;
                setName(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
          </Field>
          <Field label={t("group.folderLabel")} htmlFor="new-group-path" hint={t("group.folderHint")}>
            <FolderPick
              id="new-group-path"
              path={path}
              onPick={onPickFolder}
              onChange={(picked) => {
                setPath(picked);
                if (picked && !nameEdited.current) setName(folderName(picked));
              }}
            />
          </Field>
          <Field
            label={t("groupSettings.memoryLabel")}
            htmlFor="new-group-memory"
            hint={
              from && !fields.memoryEdited && fields.memory
                ? t("newGroup.memoryFromTemplate", { name: template?.name ?? "" })
                : t("groupSettings.memoryNote")
            }
          >
            <textarea
              id="new-group-memory"
              className="textin memory"
              placeholder={t("groupSettings.memoryPh")}
              value={fields.memory}
              onChange={(e) => setFields({ ...fields, memory: e.target.value, memoryEdited: true })}
            />
          </Field>
          <Field
            label={t("templateEdit.worktree")}
            hint={
              from && !fields.worktreeEdited
                ? t("newGroup.worktreeFromTemplate", { name: template?.name ?? "" })
                : t("newGroup.worktreeHint")
            }
          >
            <Seg
              value={fields.worktree ? "on" : "off"}
              options={[
                { value: "on", label: t("templateEdit.on") },
                { value: "off", label: t("templateEdit.off") },
              ]}
              onChange={(v) => setFields({ ...fields, worktree: v === "on", worktreeEdited: true })}
            />
          </Field>
        </div>
        <div className="ng-col ng-pick">
          <h4 className="ng-h">{t("newGroup.bots")}</h4>
          <Field label={t("newGroup.template")} htmlFor="new-group-template">
            <TemplateSelect templates={templates} value={templateId} active={open} onChange={chooseTemplate} />
          </Field>
          {team.length ? (
            <div className="ng-bots with-roles">
              <p className="ng-sub">{t("newGroup.willMake", { n: String(team.length) })}</p>
              <ul>
                {team.map((bot, i) => {
                  const swap = swapLine(bot, t);
                  const line = templateBotLine(
                    { ...bot.ai, tier: template?.bots[i]?.tier ?? "normal" },
                    t,
                    states[bot.ai.cli]?.models,
                  );
                  return (
                    <li key={i}>
                      <TemplateFace seed={`${templateId}-${i}`} shape={bot.shape} lead={bot.lead} size="sm" />
                      <span className="nm">
                        {bot.name}
                        {bot.lead ? <span className="lead-tag">{t("templates.lead")}</span> : null}
                      </span>
                      <span className="ng-ai">
                        <small>{line}</small>
                        <button
                          type="button"
                          className="icon-btn sm"
                          title={t("newGroup.changeAi")}
                          aria-label={t("newGroup.changeAi")}
                          aria-expanded={editing === i}
                          onClick={() => setEditing(editing === i ? null : i)}
                        >
                          <Pencil size={12} />
                        </button>
                      </span>
                      {bot.role ? <span className="role">{bot.role}</span> : null}
                      {swap ? <span className="ng-swap">{swap}</span> : null}
                      {editing === i ? (
                        <span className="ng-ai-pick">
                          <ModelPicker
                            cli={bot.ai.cli as CliKind}
                            model={bot.ai.model}
                            effort={bot.ai.effort}
                            active={open}
                            noCustom
                            onCli={(cli) => setPicks({ ...picks, [i]: { cli, model: "", effort: bot.ai.effort } })}
                            onModel={(model) =>
                              setPicks({ ...picks, [i]: { cli: bot.ai.cli, model, effort: bot.ai.effort } })
                            }
                            onEffort={(effort) =>
                              setPicks({ ...picks, [i]: { cli: bot.ai.cli, model: bot.ai.model, effort } })
                            }
                          />
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : (
            <p className="field-hint">{t("newGroup.noTemplateDesc")}</p>
          )}
        </div>
      </div>
      </fieldset>
      <NewGroupFoot
        t={t}
        making={making}
        failure={failure}
        canCreate={!!name.trim()}
        onClose={onClose}
        onCreate={() => void submit()}
      />
    </Modal>
  );
}

/**
 * The dialog's foot: the create button, its progress while the bots are made,
 * and why making them stopped. After some bots were made only closing is
 * left, since creating again would make a second group.
 */
export function NewGroupFoot({
  t,
  making,
  failure,
  canCreate,
  onClose,
  onCreate,
}: {
  t: TFn;
  making: { done: number; total: number } | null;
  failure: Extract<GroupMade, { ok: false }> | null;
  canCreate: boolean;
  onClose: () => void;
  onCreate: () => void;
}) {
  const stuck = failure?.stage === "add";
  return (
    <>
      {failure ? (
        <p className="ng-error" role="alert">
          {stuck
            ? t("newGroup.failAdd", {
                made: String(failure.made.length),
                total: String(failure.total),
                error: failure.error,
                group: failure.groupName,
              })
            : t("newGroup.failReserve", { error: failure.error })}
        </p>
      ) : null}
      <div className="actions spread">
        <button type="button" className="ghost" disabled={!!making} onClick={onClose}>
          {stuck ? t("common.close") : t("common.cancel")}
        </button>
        {stuck ? null : (
          <button
            type="button"
            className="primary ng-create"
            disabled={!canCreate || !!making}
            aria-busy={!!making}
            onClick={onCreate}
          >
            {making ? (
              <>
                <LoaderCircle className="spin" size={14} />
                {making.total
                  ? t("newGroup.making", { done: String(making.done), total: String(making.total) })
                  : t("newGroup.makingGroup")}
              </>
            ) : (
              t("common.create")
            )}
          </button>
        )}
      </div>
    </>
  );
}
