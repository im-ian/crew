import { Fragment, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { dropIndex, moveAi } from "../aiList";
import { randomFace } from "../avatar";
import { loadBotDefault } from "../botDefault";
import { GripVertical, Pencil, Plus, Star, X } from "../icons";
import { useT } from "../LocaleContext";
import {
  addBot,
  changeBot,
  moveBot,
  removeBot,
  templateBotLine,
  templateFromGroup,
  templateProblem,
  toggleLead,
} from "../templateEdit";
import { TIERS, tierOf, type Template, type Tier } from "../templates";
import type { AgentInfo, CliKind, Group } from "../types";
import { FacePop } from "./FacePicker";
import { Field } from "./Field";
import { Modal } from "./Modal";
import { ModelPicker } from "./ModelPicker";
import { Seg } from "./Seg";
import { TEMPLATE_FACE, TemplateFace } from "./TemplateFace";

type Props = {
  open: boolean;
  /** What the dialog starts with. An empty id is a new template. */
  initial: Template;
  /** Fill from this group as the dialog opens: "save a group as a template". */
  fillFrom?: string | null;
  groups: Group[];
  agents: AgentInfo[];
  loadMemory: (groupId: string) => Promise<string>;
  onClose: () => void;
  onSave: (t: Template) => Promise<void>;
};

type Drag = { from: number; to: number; mids: number[] };

/** Make or change a template: its bots, lead, group memory and folder rule. */
export function TemplateEditModal({
  open,
  initial,
  fillFrom = null,
  groups,
  agents,
  loadMemory,
  onClose,
  onSave,
}: Props) {
  const t = useT();
  const [tpl, setTpl] = useState(initial);
  const [openBot, setOpenBot] = useState<number | null>(null);
  const [fillId, setFillId] = useState("");
  const [skipped, setSkipped] = useState(0);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  const rows = useRef<(HTMLDivElement | null)[]>([]);
  const nameRef = useRef<HTMLInputElement>(null);
  const fillSeq = useRef(0);

  useEffect(() => {
    if (!open) return;
    setTpl(initial);
    setOpenBot(null);
    setSkipped(0);
    setBusy(false);
    setDrag(null);
    setFillId("");
    if (fillFrom) void fill(fillFrom);
    // `fill` reads the props of this open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initial, fillFrom]);

  async function fill(groupId: string) {
    const group = groups.find((g) => g.id === groupId);
    setFillId(groupId);
    if (!group) return;
    const seq = ++fillSeq.current;
    const memory = await loadMemory(groupId);
    if (seq !== fillSeq.current) return;
    const made = templateFromGroup(group, agents, memory);
    // The template's own name and description stay when it already has them.
    setTpl((cur) => ({
      ...made.template,
      id: cur.id,
      name: cur.name.trim() ? cur.name : made.template.name,
      description: cur.description,
    }));
    setSkipped(made.skipped);
    setOpenBot(null);
  }

  const order = tpl.bots.map((_, i) => i);
  const shown = drag ? moveAi(order, drag.from, drag.to) : order;

  function grab(e: ReactPointerEvent<HTMLButtonElement>, index: number) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const mids = rows.current.slice(0, tpl.bots.length).map((row) => {
      const box = row?.getBoundingClientRect();
      return box ? box.top + box.height / 2 : 0;
    });
    setOpenBot(null);
    setDrag({ from: index, to: index, mids });
  }

  function slide(e: ReactPointerEvent<HTMLButtonElement>) {
    if (!drag) return;
    const to = dropIndex(drag.mids, e.clientY, drag.from);
    if (to !== drag.to) setDrag({ ...drag, to });
  }

  function release() {
    if (!drag) return;
    if (drag.to !== drag.from) setTpl((cur) => moveBot(cur, drag.from, drag.to));
    setDrag(null);
  }

  function add() {
    const ai = loadBotDefault();
    const face = randomFace();
    const next = addBot(tpl, t("templateEdit.newBot"), ai, face.shape);
    setTpl(next);
    setOpenBot(next.bots.length - 1);
  }

  const problem = templateProblem(tpl);

  async function save() {
    if (problem === "name") {
      nameRef.current?.focus();
      return;
    }
    if (problem) return;
    setBusy(true);
    try {
      await onSave(tpl);
    } finally {
      setBusy(false);
    }
  }

  const tierOptions = TIERS.map((value: Tier) => ({ value, label: t(`tier.${value}`) }));

  return (
    <Modal
      open={open}
      title={tpl.id ? t("templateEdit.titleEdit") : t("templateEdit.titleNew")}
      onClose={onClose}
      className="tpl-dialog"
    >
      <div className="form-stack">
        {groups.length ? (
          <div className="tpl-fill">
            <span>{t("templateEdit.fill")}</span>
            <select
              className="textin"
              value={fillId}
              aria-label={t("templateEdit.fill")}
              onChange={(e) => {
                if (e.target.value) void fill(e.target.value);
              }}
            >
              <option value="">{t("templateEdit.fillPick")}</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {skipped ? (
          <p className="field-hint">{t("templateEdit.skipped", { n: String(skipped) })}</p>
        ) : null}
        <Field label={t("field.name")} htmlFor="tpl-name">
          <input
            id="tpl-name"
            ref={nameRef}
            className="textin"
            autoComplete="off"
            value={tpl.name}
            onChange={(e) => setTpl({ ...tpl, name: e.target.value })}
          />
        </Field>
        <Field label={t("templateEdit.desc")} htmlFor="tpl-desc">
          <input
            id="tpl-desc"
            className="textin"
            autoComplete="off"
            value={tpl.description}
            onChange={(e) => setTpl({ ...tpl, description: e.target.value })}
          />
        </Field>
        <Field
          label={`${t("templateEdit.bots")} ${tpl.bots.length}`}
          hint={tpl.bots.length > 1 ? t("templateEdit.botsHint") : undefined}
        >
          {tpl.bots.length ? (
            <div className="tpl-bots">
              {shown.map((at, i) => {
                const bot = tpl.bots[at];
                const seed = `${tpl.id || "new"}-${at}`;
                const isLead = tpl.lead === at;
                return (
                  <Fragment key={at}>
                    <div
                      ref={(el) => {
                        rows.current[i] = el;
                      }}
                      className={
                        "tpl-bot" +
                        (openBot === at ? " open" : "") +
                        (drag?.from === at ? " dragging" : "")
                      }
                    >
                      <button
                        type="button"
                        className="tpl-grip icon-btn sm"
                        title={t("templateEdit.drag")}
                        aria-label={t("templateEdit.drag")}
                        disabled={tpl.bots.length < 2}
                        onPointerDown={(e) => grab(e, at)}
                        onPointerMove={slide}
                        onPointerUp={release}
                        onPointerCancel={() => setDrag(null)}
                        onDragStart={(e) => e.preventDefault()}
                      >
                        <GripVertical size={14} />
                      </button>
                      <TemplateFace seed={seed} shape={bot.shape} lead={isLead} size="sm" />
                      <div className="tpl-bot-text">
                        <div className="tpl-bot-name">{bot.name || t("templateEdit.unnamed")}</div>
                        <div className="tpl-bot-meta">{templateBotLine(bot, t)}</div>
                      </div>
                      <button
                        type="button"
                        className={"icon-btn sm tpl-lead-btn" + (isLead ? " is-lead" : "")}
                        title={t("templateEdit.lead")}
                        aria-label={t("templateEdit.lead")}
                        aria-pressed={isLead}
                        onClick={() => setTpl(toggleLead(tpl, at))}
                      >
                        <Star size={14} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn sm"
                        title={t("templateEdit.editBot")}
                        aria-label={t("templateEdit.editBot")}
                        aria-expanded={openBot === at}
                        onClick={() => setOpenBot(openBot === at ? null : at)}
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn sm"
                        title={t("templateEdit.removeBot")}
                        aria-label={t("templateEdit.removeBot")}
                        onClick={() => {
                          setOpenBot(null);
                          setTpl(removeBot(tpl, at));
                        }}
                      >
                        <X size={14} />
                      </button>
                    </div>
                    {openBot === at ? (
                      <div className="tpl-bot-edit">
                        <div className="info-hero">
                          <FacePop
                            active={open}
                            id={seed}
                            shape={bot.shape ?? null}
                            color={TEMPLATE_FACE}
                            shapeOnly
                            onShape={(shape) => setTpl(changeBot(tpl, at, { shape }))}
                            onColor={() => {}}
                          >
                            <TemplateFace seed={seed} shape={bot.shape} size="md" />
                          </FacePop>
                        </div>
                        <Field label={t("field.name")} htmlFor={`tpl-bot-name-${at}`}>
                          <input
                            id={`tpl-bot-name-${at}`}
                            className="textin"
                            autoComplete="off"
                            value={bot.name}
                            onChange={(e) => setTpl(changeBot(tpl, at, { name: e.target.value }))}
                          />
                        </Field>
                        <Field
                          label={t("templateEdit.role")}
                          htmlFor={`tpl-bot-role-${at}`}
                          hint={t("templateEdit.roleHint")}
                        >
                          <textarea
                            id={`tpl-bot-role-${at}`}
                            className="textin memory tpl-role"
                            value={bot.role}
                            onChange={(e) => setTpl(changeBot(tpl, at, { role: e.target.value }))}
                          />
                        </Field>
                        <Field label={t("field.ai")}>
                          <ModelPicker
                            cli={bot.cli as CliKind}
                            model={bot.model}
                            effort={bot.effort}
                            active={open}
                            allowMissing
                            noCustom
                            onCli={(cli) => setTpl(changeBot(tpl, at, { cli, model: "" }))}
                            onModel={(model) =>
                              setTpl(changeBot(tpl, at, { model, tier: model ? tierOf(bot.cli, model) : bot.tier }))
                            }
                            onEffort={(effort) => setTpl(changeBot(tpl, at, { effort }))}
                          />
                        </Field>
                        <Field label={t("templateEdit.tier")} hint={t("templateEdit.tierHint")}>
                          <Seg
                            value={bot.tier}
                            options={tierOptions}
                            onChange={(tier) => setTpl(changeBot(tpl, at, { tier }))}
                          />
                        </Field>
                      </div>
                    ) : null}
                  </Fragment>
                );
              })}
            </div>
          ) : null}
          <button type="button" className="ghost tpl-add" onClick={add}>
            <Plus size={14} />
            {t("templateEdit.addBot")}
          </button>
        </Field>
        <Field
          label={t("groupSettings.memoryLabel")}
          htmlFor="tpl-memory"
          hint={t("templateEdit.memoryHint")}
        >
          <textarea
            id="tpl-memory"
            className="textin memory"
            value={tpl.memory}
            onChange={(e) => setTpl({ ...tpl, memory: e.target.value })}
          />
        </Field>
        <Field label={t("templateEdit.worktree")} hint={t("templateEdit.worktreeHint")}>
          <Seg
            value={tpl.worktree ? "on" : "off"}
            options={[
              { value: "on", label: t("templateEdit.on") },
              { value: "off", label: t("templateEdit.off") },
            ]}
            onChange={(v) => setTpl({ ...tpl, worktree: v === "on" })}
          />
        </Field>
        {problem === "botName" ? <p className="field-hint">{t("templateEdit.botNameNeeded")}</p> : null}
      </div>
      <div className="actions spread">
        <button type="button" className="ghost" onClick={onClose}>
          {t("common.cancel")}
        </button>
        <button type="button" className="primary" disabled={busy || !!problem} onClick={() => void save()}>
          {t("common.save")}
        </button>
      </div>
    </Modal>
  );
}
