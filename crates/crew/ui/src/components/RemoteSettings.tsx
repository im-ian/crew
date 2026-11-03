import { useEffect, useRef, useState } from "react";
import { api, errMsg } from "../api";
import { useT } from "../LocaleContext";
import { localAgents, toggled } from "../remote";
import type { AgentInfo, RemoteAccount, RemoteInfo } from "../types";
import { Avatar } from "./Avatar";
import { CopyButton } from "./CopyButton";
import { Field } from "./Field";

export type RemoteChange = {
  alias: string;
  delegates: string[] | null;
  trusted: string[] | null;
  blocked: string[] | null;
};

type Props = {
  remotes: RemoteInfo[];
  agents: AgentInfo[];
  /** The page is showing, so the team memos can be read. */
  active: boolean;
  onSet: (change: RemoteChange) => Promise<void>;
  onLeave: (alias: string) => void;
  onAdd: () => void;
};

/** Settings → Remote: one card per router this PC is signed up to. */
export function RemoteSettings({ remotes, agents, active, onSet, onLeave, onAdd }: Props) {
  const t = useT();
  if (!remotes.length) {
    return (
      <div className="form-stack">
        <p className="empty-routines">{t("remote.empty")}</p>
        <button type="button" className="ghost settings-action" onClick={onAdd}>
          {t("menu.addRemote")}
        </button>
      </div>
    );
  }
  return (
    <div className="remote-cards">
      {remotes.map((r) => (
        <RemoteCard
          key={r.alias}
          remote={r}
          agents={agents}
          active={active}
          onSet={onSet}
          onLeave={() => onLeave(r.alias)}
        />
      ))}
    </div>
  );
}

function RemoteCard({
  remote: r,
  agents,
  active,
  onSet,
  onLeave,
}: {
  remote: RemoteInfo;
  agents: AgentInfo[];
  active: boolean;
  onSet: (change: RemoteChange) => Promise<void>;
  onLeave: () => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const rep = agents.find((a) => a.id === r.bot);
  // The representative does the work itself; the rest are who it may hand to.
  const candidates = localAgents(agents).filter((a) => a.id !== r.bot);

  async function change(next: Omit<RemoteChange, "alias">) {
    if (busy) return;
    setBusy(true);
    try {
      await onSet({ alias: r.alias, ...next });
    } finally {
      setBusy(false);
    }
  }

  function without(list: RemoteAccount[], account: string): string[] {
    return list.filter((p) => p.account !== account).map((p) => p.account);
  }

  return (
    <section className="remote-card" aria-label={r.alias}>
      <div className="remote-card-head">
        <span className="remote-card-alias">{r.alias}</span>
        <span className={"remote-conn" + (r.connected ? " is-on" : "")} aria-hidden />
        <span className="remote-card-state">
          {r.connected ? t("sidebar.remoteConnected") : t("sidebar.remoteDisconnected")}
        </span>
      </div>
      <dl className="remote-facts">
        <dt>{t("remote.url")}</dt>
        <dd>{r.url}</dd>
        <dt>{t("remote.myName")}</dt>
        <dd>
          {r.name}
          {rep ? (
            <span className="remote-facts-sub">
              {t("remote.repBot", { name: rep.name || rep.id })}
            </span>
          ) : null}
        </dd>
      </dl>
      <div className="form-stack">
        <Field label={t("remote.delegates")} hint={t("remote.delegatesNote")}>
          {candidates.length ? (
            <div className="remote-picks">
              {candidates.map((a) => (
                <label key={a.id} className="remote-pick">
                  <input
                    type="checkbox"
                    checked={r.delegates.includes(a.id)}
                    disabled={busy}
                    onChange={() =>
                      void change({
                        delegates: toggled(r.delegates, a.id),
                        trusted: null,
                        blocked: null,
                      })
                    }
                  />
                  <Avatar
                    as="span"
                    className="remote-pick-avatar"
                    id={a.id}
                    name={a.name || a.id}
                    src={a.avatar}
                    shape={a.avatar_shape}
                    color={a.avatar_color}
                  />
                  <span className="remote-pick-name">{a.name || a.id}</span>
                </label>
              ))}
            </div>
          ) : (
            <p className="apply-note">{t("remote.noDelegates")}</p>
          )}
        </Field>
        <Field label={t("remote.trusted")} hint={t("remote.trustedNote")}>
          <People
            people={r.trusted}
            action={t("remote.remove")}
            busy={busy}
            onAction={(account) =>
              void change({ delegates: null, trusted: without(r.trusted, account), blocked: null })
            }
          />
        </Field>
        <Field label={t("remote.blocked")} hint={t("remote.blockedNote")}>
          <People
            people={r.blocked}
            action={t("remote.unblock")}
            busy={busy}
            onAction={(account) =>
              void change({ delegates: null, trusted: null, blocked: without(r.blocked, account) })
            }
          />
        </Field>
        <TeamMemoryField alias={r.alias} active={active} />
        <Field label={t("remote.leave")} hint={t("remote.leaveNote", { name: r.name })}>
          <button type="button" className="danger settings-action" onClick={onLeave}>
            {t("remote.leaveAction", { alias: r.alias })}
          </button>
        </Field>
      </div>
    </section>
  );
}

function People({
  people,
  action,
  busy,
  onAction,
}: {
  people: RemoteAccount[];
  action: string;
  busy: boolean;
  onAction: (account: string) => void;
}) {
  const t = useT();
  if (!people.length) return <p className="apply-note">{t("remote.nobody")}</p>;
  return (
    <ul className="remote-people">
      {people.map((p) => (
        <li key={p.account}>
          <span className="remote-people-name">{p.name || p.account}</span>
          <span className="remote-people-account">{p.account}</span>
          <button
            type="button"
            className="ghost remote-people-action"
            disabled={busy}
            aria-label={`${action} · ${p.name || p.account}`}
            onClick={() => onAction(p.account)}
          >
            {action}
          </button>
        </li>
      ))}
    </ul>
  );
}

type Note =
  | { kind: "saved" }
  | { kind: "changed"; mine: string }
  | { kind: "error"; text: string };

/**
 * The router's one memo, read by every remote turn. A save only lands on the
 * version it was read at; a teammate's save in between wins, the editor shows
 * theirs, and what was typed here stays one click from the clipboard.
 */
function TeamMemoryField({ alias, active }: { alias: string; active: boolean }) {
  const t = useT();
  const [text, setText] = useState("");
  const [base, setBase] = useState("");
  const [version, setVersion] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const edited = useRef(false);

  async function load(): Promise<boolean> {
    try {
      const memo = await api.getTeamMemory(alias);
      setBase(memo.text);
      setText(memo.text);
      setVersion(memo.version);
      edited.current = false;
      return true;
    } catch (err) {
      setVersion(null);
      setNote({ kind: "error", text: errMsg(err) });
      return false;
    }
  }

  useEffect(() => {
    if (!active || edited.current) return;
    setNote(null);
    void load();
  }, [active, alias]);

  async function save() {
    if (saving || version === null || text === base) return;
    setSaving(true);
    const mine = text;
    try {
      const ok = await api.setTeamMemory(alias, mine, version);
      if (await load()) setNote(ok ? { kind: "saved" } : { kind: "changed", mine });
    } catch (err) {
      setNote({ kind: "error", text: errMsg(err) });
    } finally {
      setSaving(false);
    }
  }

  const id = `team-memory-${alias}`;
  return (
    <Field label={t("remote.teamMemory")} htmlFor={id} hint={t("remote.teamMemoryNote")}>
      <textarea
        id={id}
        className="textin memory"
        placeholder={t("remote.teamMemoryPh")}
        value={text}
        disabled={version === null}
        onChange={(e) => {
          edited.current = true;
          setText(e.target.value);
          if (note?.kind === "saved") setNote(null);
        }}
      />
      <div className="remote-memo-foot">
        {note ? (
          <p
            className={"apply-note" + (note.kind === "saved" ? "" : " is-error")}
            role="status"
          >
            {note.kind === "saved"
              ? t("memory.saved")
              : note.kind === "changed"
                ? t("remote.teamMemoryChanged")
                : note.text}
            {note.kind === "changed" ? <CopyButton text={note.mine} /> : null}
          </p>
        ) : (
          <span />
        )}
        <button
          type="button"
          className="ghost"
          disabled={saving || version === null || text === base}
          onClick={() => void save()}
        >
          {t("common.save")}
        </button>
      </div>
    </Field>
  );
}
