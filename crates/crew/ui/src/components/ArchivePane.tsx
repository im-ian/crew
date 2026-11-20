import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../api";
import {
  collectArchive,
  dayOf,
  matches,
  mergeArchives,
  newestFirst,
  type ArchiveDay,
  type ArchiveItem,
  type ArchiveKind,
} from "../archive";
import { useFileOpen, opensInPanel } from "../fileRef";
import {
  ArrowUpRight,
  BookOpen,
  CircleDot,
  CornerDownRight,
  FileCode,
  FileText,
  GitPullRequest,
  Globe,
  ImageIcon,
  Pin,
  Search,
  Tag,
} from "../icons";
import { groupBots } from "../leadGroup";
import { useLocale } from "../LocaleContext";
import { mediaSrc } from "../markdown";
import type { AgentInfo, ChatMessage, Group } from "../types";
import { Avatar } from "./Avatar";

type Sub = "links" | "files" | "images";
export type GithubState = { state: "open" | "merged" | "closed"; title?: string };

const ICON: Record<ArchiveKind, (p: { size?: number }) => ReactNode> = {
  pr: GitPullRequest,
  issue: CircleDot,
  release: Tag,
  doc: BookOpen,
  link: Globe,
  text: FileText,
  code: FileCode,
  image: ImageIcon,
  file: FileText,
};

const DAYS: ArchiveDay[] = ["today", "week", "older"];

/**
 * The bot info sheet's 보관함: links and files its chat brought up, read
 * from the transcript. A lead's also gathers its group's. What the daemon
 * adds (pins, GitHub state, whether a file is still there) is optional: a
 * command that is missing or fails leaves that part out.
 */
export function ArchivePane({
  open,
  agent,
  agents,
  groups,
  messages,
  onJump,
}: {
  open: boolean;
  agent: AgentInfo | null;
  agents: readonly AgentInfo[];
  groups: readonly Group[];
  /** The open chat's lines, when that chat is this bot's. */
  messages: readonly ChatMessage[] | null;
  onJump: (agent: string, msgId: string) => void;
}) {
  const { t, locale } = useLocale();
  const openFile = useFileOpen();
  const [sub, setSub] = useState<Sub>("links");
  const [query, setQuery] = useState("");
  const [pins, setPins] = useState<Set<string>>(new Set());
  const [states, setStates] = useState<Record<string, GithubState>>({});
  const [exists, setExists] = useState<Record<string, boolean>>({});
  const [own, setOwn] = useState<readonly ChatMessage[]>([]);
  const [team, setTeam] = useState<Record<string, readonly ChatMessage[]>>({});
  const id = agent?.id ?? null;

  // A lead's archive holds what its group's bots brought up too.
  const mates = useMemo(() => {
    const group = id ? groups.find((g) => g.lead === id) : undefined;
    return group ? groupBots(group, agents).filter((a) => a.id !== id) : [];
  }, [groups, agents, id]);

  useEffect(() => {
    if (!open || !id) return;
    let gone = false;
    api.archivePins(id).then((list) => !gone && setPins(new Set(list)), () => {});
    // The open chat's own lines are passed in; another chat's are read once.
    if (!messages) api.getMessages(id).then((m) => !gone && setOwn(m), () => {});
    for (const mate of mates) {
      api.getMessages(mate.id).then((m) => !gone && setTeam((prev) => ({ ...prev, [mate.id]: m })), () => {});
    }
    return () => {
      gone = true;
    };
  }, [open, id, mates, messages === null]);

  const items = useMemo(() => {
    if (!id) return [];
    const lists = [collectArchive(messages ?? own, id)];
    for (const mate of mates) lists.push(collectArchive(team[mate.id] ?? [], mate.id));
    return newestFirst(mergeArchives(lists));
  }, [id, messages, own, mates, team]);

  // GitHub state and whether files are there, asked once per new address.
  const asked = useMemo(() => new Set<string>(), [id]);
  useEffect(() => {
    if (!open || !items.length) return;
    const urls = items.filter((i) => (i.kind === "pr" || i.kind === "issue") && i.url && !asked.has(i.url)).map((i) => i.url!);
    const paths = items.filter((i) => i.path && !asked.has(i.path)).map((i) => i.path!);
    for (const k of [...urls, ...paths]) asked.add(k);
    if (urls.length) api.githubStates(urls).then((s) => setStates((p) => ({ ...p, ...s })), () => {});
    if (paths.length) api.pathsExist(paths).then((e) => setExists((p) => ({ ...p, ...e })), () => {});
  }, [open, items, asked]);

  const links = items.filter((i) => i.section === "links");
  const files = items.filter((i) => i.section === "files");
  const images = files.filter((i) => i.kind === "image");
  const shown = (sub === "links" ? links : sub === "files" ? files : images).filter((i) => matches(i, query));
  const pinned = sub === "images" ? [] : shown.filter((i) => pins.has(i.key));
  const rest = sub === "images" ? shown : shown.filter((i) => !pins.has(i.key));
  const now = Date.now();
  const byAgent = new Map(agents.map((a) => [a.id, a]));

  function togglePin(item: ArchiveItem) {
    if (!id) return;
    const on = !pins.has(item.key);
    setPins((prev) => {
      const next = new Set(prev);
      if (on) next.add(item.key);
      else next.delete(item.key);
      return next;
    });
    api.setArchivePin(id, item.key, on).then((list) => setPins(new Set(list)), () => {});
  }

  function openItem(item: ArchiveItem) {
    if (item.url) void api.openUrl(item.url);
    else if (item.path && openFile && opensInPanel(item.path)) openFile.open({ path: item.path });
    else if (item.path) void api.openPath(item.path);
  }

  const when = (ts: number) => {
    const d = new Date(ts);
    return dayOf(ts, now) === "today"
      ? d.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })
      : d.toLocaleDateString(locale, { month: "short", day: "numeric" });
  };

  function row(item: ArchiveItem) {
    const gone = item.path ? exists[item.path] === false : false;
    const gh = item.url ? states[item.url] : undefined;
    const Icon = ICON[item.kind];
    const face = mates.length ? byAgent.get(item.agent) : undefined;
    const from = item.from ? t(`archive.from.${item.from}`) : "";
    const what =
      item.kind === "pr" || item.kind === "issue"
        ? `${item.where} · ${t(`archive.kind.${item.kind}`)} #${item.num}`
        : item.kind === "release"
          ? `${item.where} · ${t("archive.kind.release")}`
          : item.where;
    return (
      <div key={item.key} className={"archive-item" + (gone ? " is-missing" : "")} title={item.url ?? item.path}>
        <span className={`archive-icon kind-${item.kind}`}>
          <Icon />
        </span>
        <div className="archive-text">
          <div className="archive-title">
            {gh?.title || item.title}
            {gh ? <span className={`archive-badge is-${gh.state}`}>{t(`archive.state.${gh.state}`)}</span> : null}
          </div>
          <div className="archive-meta">
            {face ? (
              <Avatar as="span" className="archive-face" id={face.id} name={face.name} src={face.avatar} shape={face.avatar_shape} color={face.avatar_color} />
            ) : null}
            <span className="archive-where">{gone ? `${what} · ${t("archive.gone")}` : from ? `${what} · ${from}` : what}</span>
            <span className="archive-when">{when(item.ts)}</span>
          </div>
        </div>
        <div className="archive-actions">
          <button
            type="button"
            className={"archive-act" + (pins.has(item.key) ? " is-on" : "")}
            title={pins.has(item.key) ? t("archive.unpin") : t("archive.pin")}
            aria-label={pins.has(item.key) ? t("archive.unpin") : t("archive.pin")}
            aria-pressed={pins.has(item.key)}
            onClick={() => togglePin(item)}
          >
            <Pin size={15} />
          </button>
          <button
            type="button"
            className="archive-act"
            title={t("archive.jump")}
            aria-label={t("archive.jump")}
            onClick={() => onJump(item.agent, item.msgId)}
          >
            <CornerDownRight size={15} />
          </button>
          {gone ? null : (
            <button
              type="button"
              className="archive-act archive-open"
              title={t("archive.open")}
              aria-label={t("archive.open")}
              onClick={() => openItem(item)}
            >
              <ArrowUpRight size={15} />
            </button>
          )}
        </div>
      </div>
    );
  }

  const tabs: { id: Sub; label: string }[] = [
    { id: "links", label: t("archive.links", { n: links.length }) },
    { id: "files", label: t("archive.files", { n: files.length }) },
    { id: "images", label: t("archive.images", { n: images.length }) },
  ];

  return (
    <div className="archive">
      <div className="seg archive-seg" data-cols="3" role="tablist">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={sub === tab.id}
            className={sub === tab.id ? "on" : ""}
            onClick={() => setSub(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <label className="archive-search">
        <Search size={15} />
        <input
          className="textin"
          placeholder={t("archive.search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      {!shown.length ? (
        <p className="apply-note">{query ? t("archive.noMatch") : t(`archive.empty.${sub}`)}</p>
      ) : sub === "images" ? (
        <div className="archive-grid">
          {rest.map((item) => {
            const gone = item.path ? exists[item.path] === false : false;
            return (
              <button
                key={item.key}
                type="button"
                className="archive-shot"
                title={item.path}
                onClick={() => (gone ? onJump(item.agent, item.msgId) : openItem(item))}
              >
                {gone ? <span className="archive-shot-gone">{t("archive.gone")}</span> : <img src={mediaSrc(item.path!)} alt="" loading="lazy" />}
                <span className="archive-shot-name">{item.title}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <>
          {pinned.length ? (
            <>
              <div className="pane-label archive-label">{t("archive.pinned")}</div>
              <div className="archive-list">{pinned.map(row)}</div>
            </>
          ) : null}
          {DAYS.map((day) => {
            const part = rest.filter((i) => dayOf(i.ts, now) === day);
            if (!part.length) return null;
            return (
              <div key={day} className="archive-day">
                <div className="pane-label archive-label">{t(`archive.day.${day}`)}</div>
                <div className="archive-list">{part.map(row)}</div>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
