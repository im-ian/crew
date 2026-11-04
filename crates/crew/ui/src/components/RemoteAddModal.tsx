import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { api, errMsg } from "../api";
import { randomFace, type AvatarShape } from "../avatar";
import { loadBotDefault } from "../botDefault";
import { useT } from "../LocaleContext";
import type { MessageKey } from "../i18n";
import {
  aliasError,
  freeAlias,
  joinErrorField,
  nameError,
  portOk,
  routerUrl,
  ROUTER_PORT,
  ROUTER_REPO,
  slugAlias,
} from "../remote";
import type { CliKind, RemoteJoin, RemoteServer } from "../types";
import { CircleHelp, LoaderCircle } from "../icons";
import { Avatar } from "./Avatar";
import { FacePop } from "./FacePicker";
import { Field } from "./Field";
import { Modal } from "./Modal";
import { ModelPicker } from "./ModelPicker";

/** The router's address as typed: host, port, and whether to use TLS. */
type Where = { address: string; port: string; tls: boolean };

type Props = {
  open: boolean;
  /** Aliases already in use, so the new router gets one of its own. */
  aliases: string[];
  onClose: () => void;
  /** Rejects with the daemon's reason when the router refused. */
  onJoin: (args: RemoteJoin) => Promise<void>;
};

export function RemoteAddModal({ open, aliases, onClose, onJoin }: Props) {
  const t = useT();
  const [server, setServer] = useState<RemoteServer | null>(null);
  // Held here, so Back from the second step finds the address as it was.
  const [where, setWhere] = useState<Where>({ address: "", port: String(ROUTER_PORT), tls: true });

  // Opening the dialog again starts at the address.
  useEffect(() => {
    if (open) setServer(null);
  }, [open]);

  return (
    <Modal
      open={open}
      title={server ? t("remoteAdd.profileTitle") : t("remoteAdd.title")}
      onClose={onClose}
      aside={
        <button
          type="button"
          className="dialog-help"
          title={t("remoteAdd.help")}
          aria-label={t("remoteAdd.help")}
          onClick={() => void api.openUrl(ROUTER_REPO)}
        >
          <CircleHelp size={18} />
        </button>
      }
    >
      {server ? (
        <ProfileStep
          server={server}
          aliases={aliases}
          onBack={() => setServer(null)}
          onJoin={onJoin}
        />
      ) : (
        <AddressStep
          active={open}
          where={where}
          onWhere={setWhere}
          onClose={onClose}
          onFound={setServer}
        />
      )}
    </Modal>
  );
}

function AddressStep({
  active,
  where,
  onWhere,
  onClose,
  onFound,
}: {
  active: boolean;
  where: Where;
  onWhere: (next: Where) => void;
  onClose: () => void;
  onFound: (server: RemoteServer) => void;
}) {
  const t = useT();
  const { address, port, tls } = where;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const addressRef = useRef<HTMLInputElement>(null);
  const url = routerUrl(address, port, tls);
  const badPort = !portOk(port);
  const typedScheme = url === address.trim().replace(/\/+$/, "") && !!url;

  useEffect(() => {
    if (!active) return;
    setBusy(false);
    setError("");
    const id = window.setTimeout(() => addressRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [active]);

  async function check() {
    if (!url || badPort || busy) {
      addressRef.current?.focus();
      return;
    }
    setBusy(true);
    setError("");
    try {
      onFound(await api.remoteProbe(url));
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  function onEnter(e: KeyboardEvent) {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    e.preventDefault();
    void check();
  }

  return (
    <>
      <p>{t("remoteAdd.intro")}</p>
      <div className="form-stack">
        <div className="remote-address">
          <Field label={t("remoteAdd.address")} htmlFor="remote-address">
            <input
              id="remote-address"
              ref={addressRef}
              className="textin"
              placeholder={t("remoteAdd.addressPh")}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              value={address}
              onChange={(e) => {
                onWhere({ ...where, address: e.target.value });
                setError("");
              }}
              onKeyDown={onEnter}
            />
          </Field>
          <Field label={t("remoteAdd.port")} htmlFor="remote-port">
            <input
              id="remote-port"
              className="textin"
              inputMode="numeric"
              autoComplete="off"
              disabled={typedScheme}
              value={port}
              onChange={(e) => {
                onWhere({ ...where, port: e.target.value });
                setError("");
              }}
              onKeyDown={onEnter}
            />
          </Field>
        </div>
        <div className="settings-notify">
          <label className="field" htmlFor="remote-tls">
            {t("remoteAdd.tls")}
          </label>
          <input
            id="remote-tls"
            type="checkbox"
            role="switch"
            className="switch"
            disabled={typedScheme}
            checked={tls}
            title={tls ? t("common.on") : t("common.off")}
            onChange={(e) => {
              onWhere({ ...where, tls: e.target.checked });
              setError("");
            }}
          />
        </div>
        <p className={"apply-note" + (error || badPort ? " is-error" : "")} role="status">
          {error
            ? error
            : badPort
              ? t("remoteAdd.badPort")
              : url
                ? t(tls || typedScheme ? "remoteAdd.urlHint" : "remoteAdd.urlHintPlain", { url })
                : t("remoteAdd.addressNote")}
        </p>
      </div>
      <div className="actions spread">
        <button type="button" className="ghost" onClick={onClose}>
          {t("common.cancel")}
        </button>
        <button
          type="button"
          className="primary busy-btn"
          disabled={busy || !url || badPort}
          onClick={() => void check()}
        >
          {busy ? <LoaderCircle className="spin" size={14} /> : null}
          {busy ? t("remoteAdd.checking") : t("remoteAdd.check")}
        </button>
      </div>
    </>
  );
}

const NAME_ERRORS: Record<string, MessageKey> = {
  empty: "error.nameRequired",
  long: "remoteAdd.tooLong",
  bad: "remoteAdd.nameBad",
};

const ALIAS_ERRORS: Record<string, MessageKey> = {
  empty: "remoteAdd.aliasRequired",
  long: "remoteAdd.tooLong",
  bad: "remoteAdd.aliasBad",
  taken: "remoteAdd.aliasTaken",
};

function ProfileStep({
  server,
  aliases,
  onBack,
  onJoin,
}: {
  server: RemoteServer;
  aliases: string[];
  onBack: () => void;
  onJoin: (args: RemoteJoin) => Promise<void>;
}) {
  const t = useT();
  const [alias, setAlias] = useState(() =>
    freeAlias(slugAlias(server.title || server.name), aliases),
  );
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [invite, setInvite] = useState("");
  const start = useRef(loadBotDefault()).current;
  const [cli, setCli] = useState<CliKind>(start.cli);
  const [model, setModel] = useState(start.model);
  const [effort, setEffort] = useState(start.effort);
  const [command, setCommand] = useState(start.cmd);
  const [face] = useState(() => randomFace({ color: "#3a3a3c" }));
  const [shape, setShape] = useState<AvatarShape | "">(face.shape);
  const [color, setColor] = useState(face.color);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  // Where the router's refusal goes: under the field it is about, or below.
  const [refused, setRefused] = useState<{ field: "name" | "invite" | null; text: string } | null>(
    null,
  );
  const nameRef = useRef<HTMLInputElement>(null);
  const closed = server.signup === "closed";
  const needsInvite = server.signup === "invite";

  useEffect(() => {
    const id = window.setTimeout(() => nameRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, []);

  const nameProblem = nameError(name);
  const aliasProblem = aliasError(alias, aliases);
  const inviteMissing = needsInvite && !invite.trim();
  const showName = nameProblem && (tried || nameProblem !== "empty");
  const nameNote = refused?.field === "name"
    ? refused.text
    : showName
      ? t(NAME_ERRORS[nameProblem])
      : null;
  const inviteNote = refused?.field === "invite"
    ? refused.text
    : tried && inviteMissing
      ? t("remoteAdd.inviteRequired")
      : null;

  async function submit() {
    if (busy || closed) return;
    setTried(true);
    if (nameProblem || aliasProblem || inviteMissing) {
      if (nameProblem) nameRef.current?.focus();
      return;
    }
    setBusy(true);
    setRefused(null);
    try {
      await onJoin({
        url: server.url,
        alias: alias.trim(),
        name: name.trim(),
        invite: needsInvite ? invite.trim() : null,
        role: role.trim() || null,
        cli,
        model,
        effort,
        cmd: command,
        shape: shape || null,
        color: color || null,
      });
    } catch (err) {
      const text = errMsg(err);
      const field = joinErrorField(text);
      setRefused({ field: field === "invite" && !needsInvite ? null : field, text });
      if (field === "name") nameRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  function onEnter(e: KeyboardEvent) {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    e.preventDefault();
    void submit();
  }

  return (
    <>
      <p className="remote-server">
        {t("remoteAdd.server", { title: server.title || server.name, version: server.version })}
        <span className="remote-server-url">{server.url}</span>
      </p>
      <div className="form-stack">
        <p className="apply-note">{t("remoteAdd.profileNote")}</p>
        <div className="info-hero">
          <FacePop
            active
            id="remote-new"
            shape={shape || null}
            color={color || null}
            onShape={setShape}
            onColor={setColor}
            onFace={(nextShape, nextColor) => {
              setShape(nextShape);
              setColor(nextColor);
            }}
          >
            <Avatar
              className="new-avatar"
              id="remote-new"
              name={name.trim() || "new"}
              shape={shape || null}
              color={color || null}
            />
          </FacePop>
        </div>
        <Field
          label={t("field.name")}
          htmlFor="remote-name"
          hint={nameNote ? <span className="field-error">{nameNote}</span> : t("remoteAdd.nameHint")}
        >
          <input
            id="remote-name"
            ref={nameRef}
            className="textin"
            placeholder={t("remoteAdd.namePh")}
            autoComplete="off"
            spellCheck={false}
            maxLength={64}
            aria-invalid={!!nameNote}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (refused?.field === "name") setRefused(null);
            }}
            onKeyDown={onEnter}
          />
        </Field>
        <Field
          label={t("remoteAdd.alias")}
          htmlFor="remote-alias"
          hint={
            aliasProblem ? (
              <span className="field-error">{t(ALIAS_ERRORS[aliasProblem])}</span>
            ) : (
              t("remoteAdd.aliasHint", { alias: alias.trim() })
            )
          }
        >
          <input
            id="remote-alias"
            className="textin"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-invalid={!!aliasProblem}
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
            onKeyDown={onEnter}
          />
        </Field>
        <Field label={t("field.ai")} hint={t("remoteAdd.aiHint")}>
          <ModelPicker
            cli={cli}
            model={model}
            effort={effort}
            active
            pickInstalled
            command={command}
            onCli={(next) => {
              setCli(next);
              setModel("");
              if (next === "custom") setCommand("");
            }}
            onModel={setModel}
            onEffort={setEffort}
            onCommand={setCommand}
          />
        </Field>
        <Field label={t("remoteAdd.role")} htmlFor="remote-role" hint={t("remoteAdd.roleHint")}>
          <input
            id="remote-role"
            className="textin"
            placeholder={t("remoteAdd.rolePh")}
            autoComplete="off"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            onKeyDown={onEnter}
          />
        </Field>
        {needsInvite ? (
          <Field
            label={t("remoteAdd.invite")}
            htmlFor="remote-invite"
            hint={
              inviteNote ? (
                <span className="field-error">{inviteNote}</span>
              ) : (
                t("remoteAdd.inviteHint")
              )
            }
          >
            <input
              id="remote-invite"
              className="textin"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={!!inviteNote}
              value={invite}
              onChange={(e) => {
                setInvite(e.target.value);
                if (refused?.field === "invite") setRefused(null);
              }}
              onKeyDown={onEnter}
            />
          </Field>
        ) : null}
        {closed ? (
          <p className="apply-note is-error">{t("remoteAdd.closed")}</p>
        ) : refused && !refused.field ? (
          <p className="apply-note is-error" role="status">
            {refused.text}
          </p>
        ) : null}
      </div>
      <div className="actions spread">
        <button type="button" className="ghost" disabled={busy} onClick={onBack}>
          {t("remoteAdd.back")}
        </button>
        <button
          type="button"
          className="primary busy-btn"
          disabled={busy || closed}
          onClick={() => void submit()}
        >
          {busy ? <LoaderCircle className="spin" size={14} /> : null}
          {busy ? t("remoteAdd.joining") : t("remoteAdd.join")}
        </button>
      </div>
    </>
  );
}
