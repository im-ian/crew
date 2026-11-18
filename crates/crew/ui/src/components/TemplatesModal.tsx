import { Layers, Star, Trash2 } from "../icons";
import { useT } from "../LocaleContext";
import type { Template } from "../templates";
import { Modal } from "./Modal";
import { TemplateFaces } from "./TemplateFace";

type Props = {
  open: boolean;
  templates: Template[];
  /** There is a group to save as a template. */
  hasGroups: boolean;
  onClose: () => void;
  onNew: () => void;
  onCopy: (t: Template) => void;
  onEdit: (t: Template) => void;
  onRemove: (t: Template) => void;
  onFromGroup: () => void;
};

/** Crew's templates and the user's: each one's bots, lead and folder rule. */
export function TemplatesModal({
  open,
  templates,
  hasGroups,
  onClose,
  onNew,
  onCopy,
  onEdit,
  onRemove,
  onFromGroup,
}: Props) {
  const t = useT();
  const crew = templates.filter((x) => x.builtin);
  const mine = templates.filter((x) => !x.builtin);

  function card(x: Template) {
    const lead = x.lead != null ? x.bots[x.lead] : undefined;
    return (
      <div className="tpl-card" key={x.id}>
        <div className="tpl-card-top">
          <span className="tpl-card-name">
            {x.name}
            {x.builtin ? <span className="tpl-chip">{t("templates.chip")}</span> : null}
          </span>
          <span className="tpl-card-acts">
            {x.builtin ? (
              <button type="button" className="ghost sm" onClick={() => onCopy(x)}>
                {t("templates.copy")}
              </button>
            ) : (
              <>
                <button type="button" className="ghost sm" onClick={() => onEdit(x)}>
                  {t("templates.edit")}
                </button>
                <button
                  type="button"
                  className="icon-btn sm"
                  title={t("templates.remove")}
                  aria-label={t("templates.remove")}
                  onClick={() => onRemove(x)}
                >
                  <Trash2 size={14} />
                </button>
              </>
            )}
          </span>
        </div>
        {x.description ? <p className="tpl-card-desc">{x.description}</p> : null}
        <TemplateFaces template={x} size="md" />
        <p className="tpl-card-meta">
          {t("templates.bots", { n: String(x.bots.length) })}
          {lead ? (
            <>
              {" · "}
              {t("templates.lead")}
              <span className="lead-mark" aria-hidden>
                <Star size={10} />
              </span>
              {lead.name}
            </>
          ) : null}
          {" · "}
          {x.worktree ? t("templates.worktreeOn") : t("templates.worktreeOff")}
        </p>
      </div>
    );
  }

  return (
    <Modal
      open={open}
      title={t("templates.title")}
      onClose={onClose}
      className="tpl-dialog"
      aside={
        <button type="button" className="primary sm" onClick={onNew}>
          {t("templates.new")}
        </button>
      }
    >
      <p className="field-hint tpl-lede">{t("templates.lede")}</p>
      <h4 className="tpl-sec">
        {t("templates.builtin")}
        <span>{t("templates.builtinNote")}</span>
      </h4>
      <div className="tpl-list">{crew.map(card)}</div>
      <h4 className="tpl-sec">{t("templates.mine")}</h4>
      <div className="tpl-list">
        {mine.length ? mine.map(card) : <p className="field-hint">{t("templates.mineEmpty")}</p>}
        <button
          type="button"
          className="tpl-from-group"
          disabled={!hasGroups}
          onClick={onFromGroup}
        >
          <Layers size={16} />
          <span className="tfg-text">
            <b>{t("templates.fromGroup")}</b>
            <small>{hasGroups ? t("templates.fromGroupNote") : t("templates.noGroups")}</small>
          </span>
        </button>
      </div>
      <div className="actions">
        <button type="button" className="primary" onClick={onClose}>
          {t("common.close")}
        </button>
      </div>
    </Modal>
  );
}
