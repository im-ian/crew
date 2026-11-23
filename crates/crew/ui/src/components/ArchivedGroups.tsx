import { useState } from "react";
import { useLocale, useT } from "../LocaleContext";
import type { ArchivedGroup } from "../types";
import { Avatar } from "./Avatar";
import { ChevronDown } from "../icons";

/** Faces shown for one group; the rest are counted. */
const FACES = 3;

type Props = {
  groups: readonly ArchivedGroup[];
  onRestore: (id: string) => void;
  /** Asks first: deleting an archived group is for good. */
  onDelete: (id: string) => void;
};

/**
 * Groups put away with their bots, under the rail: each with its bots' faces
 * and the day it was put away, to restore or to delete for good. Folded until
 * opened, and nothing at all when none is archived.
 */
export function ArchivedGroups({ groups, onRestore, onDelete }: Props) {
  const t = useT();
  const { locale } = useLocale();
  const [open, setOpen] = useState(false);
  if (!groups.length) return null;
  return (
    <section className="archived-groups" aria-label={t("archived.title")}>
      <button
        type="button"
        className={"archived-head" + (open ? " is-open" : "")}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <ChevronDown className="archived-chevron" size={14} />
        <span className="archived-title">{t("archived.title")}</span>
        <span className="archived-count">{groups.length}</span>
      </button>
      {open ? (
        <ul className="archived-list">
          {groups.map((g) => (
            <li key={g.id} className="archived-row">
              <div className="archived-info">
                <span className="archived-name" title={g.name}>
                  {g.name}
                </span>
                <span className="archived-meta">
                  <span className="archived-faces">
                    {g.bots.slice(0, FACES).map((b) => (
                      <Avatar
                        key={b.id}
                        as="span"
                        className="archived-face"
                        id={b.id}
                        name={b.name}
                        src={b.avatar}
                        shape={b.avatar_shape}
                        color={b.avatar_color}
                        title={b.name}
                      />
                    ))}
                    {g.bots.length > FACES ? (
                      <span className="archived-more">+{g.bots.length - FACES}</span>
                    ) : null}
                  </span>
                  <span>{t("archived.bots", { n: String(g.bots.length) })}</span>
                  <span>
                    {t("archived.on", {
                      date: new Date(g.archived_at).toLocaleDateString(locale, {
                        month: "short",
                        day: "numeric",
                      }),
                    })}
                  </span>
                </span>
              </div>
              <div className="archived-acts">
                <button type="button" className="ghost sm" onClick={() => onRestore(g.id)}>
                  {t("archived.restore")}
                </button>
                <button type="button" className="ghost sm danger-text" onClick={() => onDelete(g.id)}>
                  {t("archived.delete")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
