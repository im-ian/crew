import { useEffect, useState } from "react";
import { api } from "../api";
import { useT } from "../LocaleContext";
import { copyTemplate, emptyTemplate, type Template } from "../templates";
import { popoverIsOpen } from "../usePopover";
import type { AgentInfo, Group } from "../types";
import { TemplateEditModal } from "./TemplateEditModal";
import { TemplatesModal } from "./TemplatesModal";

type Props = {
  open: boolean;
  onClose: () => void;
  groups: Group[];
  agents: AgentInfo[];
  /** The group of the open chat, for "save a group as a template". */
  currentGroupId: string | null;
  onError: (err: unknown) => void;
};

type Editing = { initial: Template; fillFrom: string | null };

/**
 * The templates window and the one that makes or changes a template. It
 * reads and writes the daemon's list, and takes its own Escape: the editor
 * first, then the list.
 */
export function TemplatesHost({ open, onClose, groups, agents, currentGroupId, onError }: Props) {
  const t = useT();
  const [list, setList] = useState<Template[]>([]);
  const [editing, setEditing] = useState<Editing | null>(null);

  async function reload() {
    try {
      setList(await api.listTemplates());
    } catch (err) {
      onError(err);
    }
  }

  useEffect(() => {
    if (!open) {
      setEditing(null);
      return;
    }
    void reload();
    // Read again each time it opens; another window may have changed it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.isComposing || popoverIsOpen()) return;
      e.preventDefault();
      e.stopPropagation();
      if (editing) setEditing(null);
      else onClose();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, editing, onClose]);

  async function save(next: Template) {
    try {
      await api.saveTemplate(next);
      setEditing(null);
      await reload();
    } catch (err) {
      onError(err);
    }
  }

  async function remove(x: Template) {
    try {
      await api.removeTemplate(x.id);
      await reload();
    } catch (err) {
      onError(err);
    }
  }

  async function loadMemory(groupId: string) {
    try {
      return await api.getGroupMemory(groupId);
    } catch (err) {
      onError(err);
      return "";
    }
  }

  const fromGroup =
    currentGroupId && groups.some((g) => g.id === currentGroupId) ? currentGroupId : groups[0]?.id ?? null;

  return (
    <>
      <TemplatesModal
        open={open && !editing}
        templates={list}
        hasGroups={groups.length > 0}
        onClose={onClose}
        onNew={() => setEditing({ initial: emptyTemplate(), fillFrom: null })}
        onCopy={(x) =>
          setEditing({ initial: copyTemplate(x, t("templates.copyName", { name: x.name })), fillFrom: null })
        }
        onEdit={(x) => setEditing({ initial: x, fillFrom: null })}
        onRemove={(x) => void remove(x)}
        onFromGroup={() => setEditing({ initial: emptyTemplate(), fillFrom: fromGroup })}
      />
      <TemplateEditModal
        open={open && !!editing}
        initial={editing?.initial ?? emptyTemplate()}
        fillFrom={editing?.fillFrom ?? null}
        groups={groups}
        agents={agents}
        loadMemory={loadMemory}
        onClose={() => setEditing(null)}
        onSave={save}
      />
    </>
  );
}
