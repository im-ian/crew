use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use anyhow::Context;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::broadcast;

use crate::config::{
    empty_to_none, find_routine_index, parse_hex_color, roster_update_text, unique_ids, write_roster,
    AgentConfig, AvatarShape, Channel, Config, Effort, Routine,
};
use crate::cron;
use crate::headless::{self, HeadlessSession};
use crate::paths;
use crate::protocol::{AgentInfo, AgentStatus, ChannelInfo, ChatMessage, Event, Request, Role};
use crate::pty_agent::{self, PtySession};
use crate::targeting::{self, TurnOrigin};

const DEFAULT_COLS: u16 = 100;
const DEFAULT_ROWS: u16 = 32;
const MAX_INBOX: usize = 32;

#[derive(Clone)]
enum LiveAgent {
    Pty(Arc<PtySession>),
    Headless(Arc<HeadlessSession>),
}

impl LiveAgent {
    fn id(&self) -> &str {
        match self {
            Self::Pty(s) => &s.id,
            Self::Headless(s) => &s.id,
        }
    }

    fn name(&self) -> &str {
        match self {
            Self::Pty(s) => &s.name,
            Self::Headless(s) => &s.name,
        }
    }

    fn cmd(&self) -> Vec<String> {
        match self {
            Self::Pty(s) => s.cmd.clone(),
            Self::Headless(s) => s.cmd.clone(),
        }
    }

    fn cwd(&self) -> PathBuf {
        match self {
            Self::Pty(s) => s.cwd.clone(),
            Self::Headless(s) => s.cwd.clone(),
        }
    }

    fn status(&self) -> AgentStatus {
        match self {
            Self::Pty(s) => s
                .inner
                .lock()
                .map(|i| i.status)
                .unwrap_or(AgentStatus::Idle),
            Self::Headless(s) => s
                .inner
                .lock()
                .map(|i| i.status)
                .unwrap_or(AgentStatus::Idle),
        }
    }

    fn is_live(&self) -> bool {
        self.status() != AgentStatus::Exited
    }

    fn pty(&self) -> Option<Arc<PtySession>> {
        match self {
            Self::Pty(s) => Some(s.clone()),
            Self::Headless(_) => None,
        }
    }

    fn frame_event(&self) -> Event {
        match self {
            Self::Pty(s) => match s.inner.lock() {
                Ok(inner) => Event::Frame {
                    agent: s.id.clone(),
                    cols: inner.cols,
                    rows: inner.rows,
                    text: pty_agent::screen_text(&inner),
                    status: inner.status,
                    seq: inner.seq,
                },
                Err(_) => Event::Frame {
                    agent: s.id.clone(),
                    cols: DEFAULT_COLS,
                    rows: DEFAULT_ROWS,
                    text: String::new(),
                    status: AgentStatus::Idle,
                    seq: 0,
                },
            },
            Self::Headless(s) => match s.inner.lock() {
                Ok(inner) => Event::Frame {
                    agent: s.id.clone(),
                    cols: inner.cols,
                    rows: inner.rows,
                    text: String::new(),
                    status: inner.status,
                    seq: inner.seq,
                },
                Err(_) => Event::Frame {
                    agent: s.id.clone(),
                    cols: DEFAULT_COLS,
                    rows: DEFAULT_ROWS,
                    text: String::new(),
                    status: AgentStatus::Idle,
                    seq: 0,
                },
            },
        }
    }

    fn snapshot_event(&self) -> Event {
        match self.frame_event() {
            Event::Frame {
                agent,
                cols,
                rows,
                text,
                status,
                ..
            } => Event::Snapshot {
                agent,
                cols,
                rows,
                text,
                status,
            },
            other => other,
        }
    }

    fn kill(&self) {
        match self {
            Self::Pty(s) => {
                if let Ok(mut inner) = s.inner.lock() {
                    let _ = inner.child.kill();
                    let _ = inner.child.wait();
                }
            }
            Self::Headless(s) => headless::kill(s),
        }
    }
}

static EVENTS: OnceLock<broadcast::Sender<Event>> = OnceLock::new();
static AGENTS: OnceLock<Mutex<HashMap<String, LiveAgent>>> = OnceLock::new();
static CONFIGS: OnceLock<Mutex<HashMap<String, AgentConfig>>> = OnceLock::new();
static CHANNELS: OnceLock<Mutex<HashMap<String, Channel>>> = OnceLock::new();
static INBOX: OnceLock<Mutex<HashMap<String, VecDeque<PendingDelivery>>>> = OnceLock::new();
static ORIGINS: OnceLock<Mutex<HashMap<String, TurnOrigin>>> = OnceLock::new();

struct PendingDelivery {
    text: String,
    newline: bool,
    msg_id: Option<String>,
    origin: TurnOrigin,
}

fn origins() -> &'static Mutex<HashMap<String, TurnOrigin>> {
    ORIGINS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn set_origin(id: &str, origin: TurnOrigin) {
    if let Ok(mut map) = origins().lock() {
        map.insert(id.to_string(), origin);
    }
}

fn get_origin(id: &str) -> Option<TurnOrigin> {
    origins().lock().ok()?.get(id).cloned()
}

fn take_origin(id: &str) -> Option<TurnOrigin> {
    origins().lock().ok()?.remove(id)
}

pub fn events() -> &'static broadcast::Sender<Event> {
    EVENTS.get_or_init(|| {
        let (tx, _rx) = broadcast::channel(256);
        tx
    })
}

fn agents() -> &'static Mutex<HashMap<String, LiveAgent>> {
    AGENTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn configs() -> &'static Mutex<HashMap<String, AgentConfig>> {
    CONFIGS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn channels() -> &'static Mutex<HashMap<String, Channel>> {
    CHANNELS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn inbox() -> &'static Mutex<HashMap<String, VecDeque<PendingDelivery>>> {
    INBOX.get_or_init(|| Mutex::new(HashMap::new()))
}

fn clear_inbox(id: &str) {
    if let Ok(mut map) = inbox().lock() {
        map.remove(id);
    }
}

fn enqueue_delivery(
    id: &str,
    text: &str,
    newline: bool,
    msg_id: Option<String>,
    origin: TurnOrigin,
) -> anyhow::Result<()> {
    let mut map = inbox().lock().expect("inbox mutex");
    let q = map.entry(id.to_string()).or_default();
    if q.len() >= MAX_INBOX {
        anyhow::bail!("agent {id} is busy (inbox full)");
    }
    q.push_back(PendingDelivery {
        text: text.to_string(),
        newline,
        msg_id: msg_id.clone(),
        origin,
    });
    drop(map);
    if let Some(mid) = msg_id {
        crate::transcript::set_queued(id, &mid, true);
    }
    Ok(())
}

fn is_busy_err(err: &anyhow::Error) -> bool {
    err.to_string().contains("is working")
}

fn agent_busy(id: &str) -> anyhow::Result<bool> {
    Ok(live_status(id)? == AgentStatus::Working)
}

fn live_status(id: &str) -> anyhow::Result<AgentStatus> {
    let map = agents().lock().expect("agents mutex");
    let live = map
        .get(id)
        .with_context(|| format!("unknown agent {id}"))?;
    match live {
        LiveAgent::Headless(session) => {
            let inner = session.inner.lock().expect("headless inner");
            if inner.child.is_some() {
                Ok(AgentStatus::Working)
            } else {
                Ok(inner.status)
            }
        }
        LiveAgent::Pty(session) => {
            let inner = session.inner.lock().expect("pty inner");
            if inner.status == AgentStatus::Exited {
                anyhow::bail!("agent {id} has exited");
            }
            Ok(inner.status)
        }
    }
}

fn set_live_status(id: &str, status: AgentStatus) {
    let live = {
        let map = match agents().lock() {
            Ok(m) => m,
            Err(_) => return,
        };
        match map.get(id) {
            Some(LiveAgent::Headless(s)) => Some(s.clone()),
            _ => None,
        }
    };
    if let Some(session) = live {
        headless::set_status(&session, status);
    }
    emit_agent_frame(id);
}

fn interrupt_turn(id: &str) -> anyhow::Result<()> {
    let live = {
        let map = agents().lock().expect("agents mutex");
        map.get(id)
            .cloned()
            .with_context(|| format!("unknown agent {id}"))?
    };
    match live {
        LiveAgent::Headless(session) => headless::interrupt(&session),
        LiveAgent::Pty(_) => {}
    }
    crate::transcript::end_turn(id);
    emit_agent_frame(id);
    pump_inbox(id);
    Ok(())
}

fn approve_agent(id: &str, allow: bool) -> anyhow::Result<()> {
    let Some(msg) = crate::transcript::pending_approval(id) else {
        anyhow::bail!("no pending approval");
    };
    let state = if allow {
        crate::protocol::ApprovalState::Allowed
    } else {
        crate::protocol::ApprovalState::Denied
    };
    crate::transcript::set_approval(id, &msg.id, state);
    if let Some(channel) = get_origin(id).and_then(|o| o.reply_channel) {
        let key = format!("ch:{channel}");
        if let Some(ch_msg) = crate::transcript::pending_approval(&key) {
            if ch_msg.from == id {
                crate::transcript::set_approval(&key, &ch_msg.id, state);
            }
        }
    }
    set_live_status(id, AgentStatus::Idle);
    if allow {
        let origin = get_origin(id).unwrap_or_else(TurnOrigin::user);
        submit_delivery(
            id,
            "User allowed this action. Continue.",
            true,
            None,
            origin,
        )?;
    }
    Ok(())
}

fn start_delivery(id: &str, text: &str, newline: bool, origin: TurnOrigin) -> anyhow::Result<()> {
    crate::transcript::expect_echo(id, text);
    set_origin(id, origin);
    match deliver(id, text, newline) {
        Ok(()) => Ok(()),
        Err(err) => {
            crate::transcript::cancel_expect(id);
            take_origin(id);
            Err(err)
        }
    }
}

fn submit_delivery(
    id: &str,
    text: &str,
    newline: bool,
    msg_id: Option<String>,
    origin: TurnOrigin,
) -> anyhow::Result<()> {
    if targeting::relay_exhausted(&origin) {
        note_relay_stop(id, &origin);
        anyhow::bail!(
            "relay limit reached after {} bot-to-bot hops; waiting for the user",
            targeting::MAX_RELAY_HOPS
        );
    }
    if agent_busy(id)? {
        return enqueue_delivery(id, text, newline, msg_id, origin);
    }
    match start_delivery(id, text, newline, origin.clone()) {
        Ok(()) => Ok(()),
        Err(err) if is_busy_err(&err) => enqueue_delivery(id, text, newline, msg_id, origin),
        Err(err) => Err(err),
    }
}

/// Say once, where the user is looking, that a bot-to-bot chain was cut short.
fn note_relay_stop(id: &str, origin: &TurnOrigin) {
    let line = if crate::paths::locale() == "en" {
        "Bots kept handing this back and forth, so it stopped here. Say something to pick it up."
    } else {
        "봇끼리 계속 주고받아서 여기서 멈췄습니다. 말을 걸면 다시 이어집니다."
    };
    match origin.reply_channel.as_deref() {
        Some(channel) if known_channel(channel) => {
            crate::transcript::push_channel(channel, Role::System, "crew", line);
        }
        _ => {
            crate::transcript::push_system(id, "crew", line);
        }
    }
}

pub(crate) fn pump_inbox(id: &str) {
    match agent_busy(id) {
        Ok(false) => {}
        _ => return,
    }
    let next = {
        let mut map = match inbox().lock() {
            Ok(m) => m,
            Err(_) => return,
        };
        map.get_mut(id).and_then(|q| q.pop_front())
    };
    let Some(item) = next else {
        return;
    };
    match start_delivery(id, &item.text, item.newline, item.origin.clone()) {
        Ok(()) => {
            if let Some(ref mid) = item.msg_id {
                crate::transcript::set_queued(id, mid, false);
            }
        }
        Err(err) if is_busy_err(&err) => {
            if let Ok(mut map) = inbox().lock() {
                map.entry(id.to_string()).or_default().push_front(item);
            }
        }
        Err(err) => {
            if let Some(ref mid) = item.msg_id {
                crate::transcript::set_queued(id, mid, false);
            }
            eprintln!("[crew] inbox {id}: {err:#}");
            pump_inbox(id);
        }
    }
}

fn roster_vec() -> Vec<AgentConfig> {
    let cfgs = configs().lock().expect("configs mutex");
    let mut v: Vec<AgentConfig> = cfgs.values().cloned().collect();
    v.sort_by(|a, b| a.id.cmp(&b.id));
    v
}

fn channel_vec() -> Vec<Channel> {
    let chans = channels().lock().expect("channels mutex");
    let mut v: Vec<Channel> = chans.values().cloned().collect();
    v.sort_by(|a, b| a.id.cmp(&b.id));
    v
}

fn save_state() -> anyhow::Result<()> {
    let agents = roster_vec();
    let chans = channel_vec();
    Config {
        agents: agents.clone(),
        channels: chans.clone(),
    }
    .save()?;
    let _ = write_roster(&agents, &chans);
    Ok(())
}

fn snapshot_event() -> Event {
    Event::Agents {
        agents: list_agents(),
        channels: list_channels(),
    }
}

pub fn emit_frame(session: &PtySession) {
    {
        let map = match agents().lock() {
            Ok(m) => m,
            Err(_) => return,
        };
        match map.get(&session.id) {
            Some(LiveAgent::Pty(current)) if std::ptr::eq(current.as_ref(), session) => {}
            _ => return,
        }
    }
    let ev = match session.inner.lock() {
        Ok(inner) => Event::Frame {
            agent: session.id.clone(),
            cols: inner.cols,
            rows: inner.rows,
            text: pty_agent::screen_text(&inner),
            status: inner.status,
            seq: inner.seq,
        },
        Err(_) => return,
    };
    notify_from_frame(&ev);
    let _ = events().send(ev);
}

pub fn emit_agent_frame(id: &str) {
    let ev = {
        let map = match agents().lock() {
            Ok(m) => m,
            Err(_) => return,
        };
        match map.get(id) {
            Some(live) => live.frame_event(),
            None => return,
        }
    };
    notify_from_frame(&ev);
    let _ = events().send(ev);
}

fn notify_from_frame(ev: &Event) {
    let Event::Frame {
        agent,
        status,
        ..
    } = ev
    else {
        return;
    };
    let prev = {
        let mut map = last_status().lock().expect("status mutex");
        let prev = map.get(agent).copied().unwrap_or(AgentStatus::Idle);
        map.insert(agent.clone(), *status);
        prev
    };
    let name = configs()
        .lock()
        .ok()
        .and_then(|m| m.get(agent).map(|c| c.display_name().to_string()))
        .unwrap_or_else(|| agent.clone());
    let interrupted = agent_interrupted(agent);
    let channel = get_origin(agent).and_then(|o| o.reply_channel);
    crate::notify::maybe_status_notify(
        agent,
        &name,
        channel.as_deref(),
        prev,
        *status,
        interrupted,
    );
}

fn agent_interrupted(id: &str) -> bool {
    let map = match agents().lock() {
        Ok(m) => m,
        Err(_) => return false,
    };
    match map.get(id) {
        Some(LiveAgent::Headless(s)) => headless::is_interrupted(s),
        _ => false,
    }
}

fn last_status() -> &'static Mutex<HashMap<String, AgentStatus>> {
    static LAST: OnceLock<Mutex<HashMap<String, AgentStatus>>> = OnceLock::new();
    LAST.get_or_init(|| Mutex::new(HashMap::new()))
}

fn search_corpus(query: &str) -> Vec<crate::search::SearchHit> {
    let roster = roster_vec();
    let bots: Vec<_> = roster
        .iter()
        .map(|a| crate::search::SearchBot {
            id: a.id.as_str(),
            name: a.name.as_str(),
            role: a.role.as_deref(),
        })
        .collect();
    let routines: Vec<_> = roster
        .iter()
        .flat_map(|a| {
            a.routines.iter().map(|r| crate::search::SearchRoutine {
                agent: a.id.as_str(),
                id: r.id.as_str(),
                name: r.name.as_str(),
                prompt: r.prompt.as_str(),
            })
        })
        .collect();
    let stored = crate::transcript::all_messages();
    let messages: Vec<_> = stored
        .iter()
        .map(|(scope, m)| crate::search::SearchMessage {
            scope: scope.as_str(),
            id: m.id.as_str(),
            from: m.from.as_str(),
            text: m.text.as_str(),
        })
        .collect();
    crate::search::search(query, &bots, &routines, &messages)
}

fn open_agent(
    cfg: &AgentConfig,
    cols: u16,
    rows: u16,
    fresh_session: bool,
    roster: &[AgentConfig],
) -> anyhow::Result<LiveAgent> {
    if cfg.uses_pty() {
        Ok(LiveAgent::Pty(pty_agent::spawn(
            cfg,
            cols,
            rows,
            fresh_session,
            roster,
        )?))
    } else {
        Ok(LiveAgent::Headless(headless::open(
            cfg,
            cols,
            rows,
            fresh_session,
        )?))
    }
}

pub async fn run() -> anyhow::Result<()> {
    paths::ensure_home()?;
    if paths::is_socket_live() {
        anyhow::bail!(
            "daemon already running ({})",
            paths::socket_path().display()
        );
    }
    paths::remove_stale_socket();

    crate::transcript::set_seal_hook(on_assistant_sealed);

    let cfg = Config::load()?;
    {
        let mut cfgs = configs().lock().expect("configs mutex");
        for agent_cfg in &cfg.agents {
            cfgs.insert(agent_cfg.id.clone(), agent_cfg.clone());
            crate::transcript::load_agent(&agent_cfg.id);
        }
        let mut chans = channels().lock().expect("channels mutex");
        for ch in &cfg.channels {
            chans.insert(ch.id.clone(), ch.clone());
            crate::transcript::load_channel(&ch.id);
        }
    }
    {
        let mut map = agents().lock().expect("agents mutex");
        for agent_cfg in &cfg.agents {
            match open_agent(agent_cfg, DEFAULT_COLS, DEFAULT_ROWS, false, &cfg.agents) {
                Ok(live) => {
                    if agent_cfg.uses_pty() {
                        eprintln!(
                            "[crew] spawned {} -> {} ({})",
                            live.id(),
                            agent_cfg.spawn_cmd_with(false, &cfg.agents).join(" "),
                            live.cwd().display()
                        );
                    } else {
                        eprintln!(
                            "[crew] registered {} (headless) ({})",
                            live.id(),
                            live.cwd().display()
                        );
                    }
                    map.insert(live.id().to_string(), live);
                }
                Err(err) => {
                    eprintln!("[crew] failed to open {}: {err:#}", agent_cfg.id);
                }
            }
        }
    }
    let _ = write_roster(&cfg.agents, &cfg.channels);

    let listener = UnixListener::bind(paths::socket_path())
        .with_context(|| format!("bind {}", paths::socket_path().display()))?;
    paths::write_pid(std::process::id())?;
    eprintln!(
        "[crew] daemon listening on {}",
        paths::socket_path().display()
    );

    let (shutdown_tx, mut shutdown_rx) = tokio::sync::watch::channel(false);
    spawn_status_ticker();
    spawn_transcript_ticker();
    spawn_routine_ticker();

    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                eprintln!("[crew] signal, shutting down");
                break;
            }
            _ = shutdown_rx.changed() => {
                if *shutdown_rx.borrow() {
                    break;
                }
            }
            accepted = listener.accept() => {
                match accepted {
                    Ok((stream, _)) => {
                        let shutdown = shutdown_tx.clone();
                        tokio::spawn(async move {
                            if let Err(err) = handle_client(stream, shutdown).await {
                                eprintln!("[crew] client: {err:#}");
                            }
                        });
                    }
                    Err(err) => {
                        eprintln!("[crew] accept: {err}");
                    }
                }
            }
        }
    }

    shutdown_agents();
    paths::remove_stale_socket();
    paths::remove_pid();
    let _ = events().send(Event::Shutdown);
    Ok(())
}

fn spawn_status_ticker() {
    std::thread::Builder::new()
        .name("crew-status".into())
        .spawn(|| loop {
            std::thread::sleep(Duration::from_millis(400));
            let list: Vec<LiveAgent> = match agents().lock() {
                Ok(map) => map.values().cloned().collect(),
                Err(_) => return,
            };
            if list.is_empty() && EVENTS.get().is_none() {
                return;
            }
            for live in list {
                let Some(session) = live.pty() else {
                    continue;
                };
                let mut changed = false;
                if let Ok(mut inner) = session.inner.lock() {
                    if inner.status == AgentStatus::Exited {
                        continue;
                    }
                    if let Ok(Some(_)) = inner.child.try_wait() {
                        inner.status = AgentStatus::Exited;
                        inner.seq += 1;
                        changed = true;
                    } else if inner.status == AgentStatus::Working
                        && inner.last_output.elapsed() > Duration::from_millis(1200)
                    {
                        inner.status = pty_agent::classify(&inner.parser, false);
                        inner.seq += 1;
                        changed = true;
                    }
                }
                if changed {
                    emit_frame(&session);
                }
            }
        })
        .expect("status ticker");
}

fn spawn_transcript_ticker() {
    std::thread::Builder::new()
        .name("crew-transcript".into())
        .spawn(|| loop {
            std::thread::sleep(Duration::from_millis(50));
            crate::transcript::tick();
            if EVENTS.get().is_none() {
                return;
            }
        })
        .expect("transcript ticker");
}

pub fn on_pty_output(agent: &str, bytes: &[u8]) {
    crate::transcript::on_pty_bytes(agent, bytes);
}

pub fn on_pty_exit(agent: &str) {
    crate::transcript::seal_agent(agent);
}

fn spawn_routine_ticker() {
    std::thread::Builder::new()
        .name("crew-routines".into())
        .spawn(|| loop {
            tick_routines();
            std::thread::sleep(Duration::from_secs(15));
            if EVENTS.get().is_none() {
                return;
            }
        })
        .expect("routine ticker");
}

fn tick_routines() {
    let now = match cron::now_local() {
        Ok(t) => t,
        Err(err) => {
            eprintln!("[crew] routine clock: {err:#}");
            return;
        }
    };
    let due: Vec<(String, String, String, String)> = {
        let cfgs = match configs().lock() {
            Ok(c) => c,
            Err(_) => return,
        };
        let mut jobs = Vec::new();
        for cfg in cfgs.values() {
            for r in &cfg.routines {
                if r.is_due(&now) {
                    jobs.push((
                        cfg.id.clone(),
                        r.id.clone(),
                        r.name.clone(),
                        r.prompt.clone(),
                    ));
                }
            }
        }
        jobs
    };
    let key = now.minute_key();
    for (agent, rid, name, prompt) in due {
        let exited = {
            let map = match agents().lock() {
                Ok(m) => m,
                Err(_) => return,
            };
            match map.get(&agent) {
                Some(live) => live.status() == AgentStatus::Exited,
                None => continue,
            }
        };
        // The minute is spent either way. Marking only on success let the 15s ticker
        // retry a failing routine four times inside the same minute.
        if let Err(err) = mark_routine_run(&agent, &rid, &key) {
            eprintln!("[crew] routine last_run {agent}/{name}: {err:#}");
        }
        let fired = if exited {
            Err(anyhow::anyhow!("agent {agent} has exited"))
        } else {
            fire_routine(&agent, &name, &prompt)
        };
        match fired {
            Ok(()) => {
                let _ = crate::routine_log::record(&agent, &rid, true, "ok");
            }
            Err(err) => {
                let _ = crate::routine_log::record(&agent, &rid, false, &err.to_string());
                crate::notify::routine_failed(&agent, &name);
                eprintln!("[crew] routine {agent}/{name}: {err:#}");
            }
        }
    }
}

fn fire_routine(agent: &str, name: &str, prompt: &str) -> anyhow::Result<()> {
    ensure_accepts_turn(agent)?;
    let msg = crate::transcript::push_routine(agent, name, prompt);
    let envelope = crate::protocol::routine_envelope(name, prompt);
    submit_delivery(
        agent,
        &envelope,
        true,
        Some(msg.id),
        TurnOrigin::routine(name),
    )?;
    eprintln!("[crew] routine {agent}/{name}");
    Ok(())
}

fn mark_routine_run(agent: &str, key: &str, minute_key: &str) -> anyhow::Result<()> {
    let mut cfg = {
        let cfgs = configs().lock().expect("configs mutex");
        cfgs.get(agent)
            .cloned()
            .with_context(|| format!("unknown agent {agent}"))?
    };
    let idx = find_routine_index(&cfg.routines, key)
        .ok_or_else(|| anyhow::anyhow!("unknown routine {key}"))?;
    cfg.routines[idx].last_run = Some(minute_key.to_string());
    persist_config(&cfg)
}

fn shutdown_agents() {
    crate::transcript::seal_all_now();
    if let Ok(mut map) = inbox().lock() {
        map.clear();
    }
    let list: Vec<LiveAgent> = match agents().lock() {
        Ok(mut map) => map.drain().map(|(_, v)| v).collect(),
        Err(_) => return,
    };
    for live in list {
        live.kill();
    }
}

async fn handle_client(
    stream: UnixStream,
    shutdown: tokio::sync::watch::Sender<bool>,
) -> anyhow::Result<()> {
    let (read, mut write) = stream.into_split();
    let mut lines = BufReader::new(read).lines();
    let mut rx = events().subscribe();
    let mut subscribed = false;

    loop {
        tokio::select! {
            line = lines.next_line() => {
                let Some(line) = line? else { break; };
                if line.trim().is_empty() {
                    continue;
                }
                let req: Request = match serde_json::from_str(&line) {
                    Ok(r) => r,
                    Err(err) => {
                        write_event(&mut write, &Event::Error { message: err.to_string() }).await?;
                        continue;
                    }
                };
                if matches!(req, Request::Subscribe) {
                    subscribed = true;
                }
                let responses = dispatch(req, &shutdown);
                for ev in responses {
                    write_event(&mut write, &ev).await?;
                }
            }
            ev = rx.recv(), if subscribed => {
                match ev {
                    Ok(ev) => write_event(&mut write, &ev).await?,
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }
    Ok(())
}

async fn write_event(
    write: &mut tokio::net::unix::OwnedWriteHalf,
    ev: &Event,
) -> anyhow::Result<()> {
    let line = ev.to_line()?;
    write.write_all(line.as_bytes()).await?;
    write.write_all(b"\n").await?;
    Ok(())
}

fn dispatch(req: Request, shutdown: &tokio::sync::watch::Sender<bool>) -> Vec<Event> {
    match req {
        Request::Ping => vec![Event::Pong],
        Request::List | Request::Subscribe => {
            let mut out = vec![snapshot_event()];
            if matches!(req, Request::Subscribe) {
                out.extend(all_snapshots().into_iter().map(|ev| match ev {
                    Event::Snapshot {
                        agent,
                        cols,
                        rows,
                        text,
                        status,
                    } => Event::Frame {
                        agent,
                        cols,
                        rows,
                        text,
                        status,
                        seq: 0,
                    },
                    other => other,
                }));
                let ids: Vec<String> = {
                    let map = agents().lock().expect("agents mutex");
                    map.keys().cloned().collect()
                };
                for id in ids {
                    out.push(Event::Messages {
                        agent: id.clone(),
                        messages: crate::transcript::messages(&id),
                    });
                }
                out.push(Event::Channels {
                    channels: list_channels(),
                });
                for ch in list_channels() {
                    out.push(Event::ChannelMessages {
                        channel: ch.id.clone(),
                        messages: crate::transcript::channel_messages(&ch.id),
                    });
                }
            }
            out
        }
        Request::Send { agent, text } => match send_agent(&agent, &text) {
            Ok(()) => vec![Event::Ok],
            Err(err) => vec![Event::Error {
                message: err.to_string(),
            }],
        },
        Request::Interrupt { agent } => match interrupt_turn(&agent) {
            Ok(()) => vec![Event::Ok],
            Err(err) => vec![Event::Error {
                message: err.to_string(),
            }],
        },
        Request::Approve { agent, allow } => match approve_agent(&agent, allow) {
            Ok(()) => vec![Event::Ok],
            Err(err) => vec![Event::Error {
                message: err.to_string(),
            }],
        },
        Request::Search { query } => vec![Event::Search {
            hits: search_corpus(&query),
        }],
        Request::Tell {
            from,
            to,
            text,
            channel,
        } => {
            let channel = channel.and_then(|s| {
                let t = s.trim().to_string();
                if t.is_empty() {
                    None
                } else {
                    Some(t)
                }
            });
            if let Some(channel) = channel {
                match send_channel(&channel, &from, &text) {
                    Ok(()) => vec![Event::Told {
                        from: from_id(&from),
                        to: format!("#{channel}"),
                    }],
                    Err(err) => vec![Event::Error {
                        message: err.to_string(),
                    }],
                }
            } else {
                match tell_agent(&from, &to, &text) {
                    Ok(()) => vec![Event::Told {
                        from: from_id(&from),
                        to,
                    }],
                    Err(err) => vec![Event::Error {
                        message: err.to_string(),
                    }],
                }
            }
        }
        Request::Input { agent, data } => match write_pty(&agent, &data, false) {
            Ok(()) => vec![Event::Ok],
            Err(err) => vec![Event::Error {
                message: err.to_string(),
            }],
        },
        Request::Resize { agent, cols, rows } => match resize_agent(&agent, cols, rows) {
            Ok(()) => vec![Event::Ok],
            Err(err) => vec![Event::Error {
                message: err.to_string(),
            }],
        },
        Request::Snapshot { agent } => match snapshot_agent(&agent) {
            Ok(ev) => vec![ev],
            Err(err) => vec![Event::Error {
                message: err.to_string(),
            }],
        },
        Request::Messages { agent } => match messages_agent(&agent) {
            Ok(ev) => vec![ev],
            Err(err) => vec![Event::Error {
                message: err.to_string(),
            }],
        },
        Request::AddAgent {
            id,
            name,
            cmd,
            cwd,
            model,
            effort,
        } => match add_agent(id, name, cmd, cwd, model, effort) {
            Ok(()) => vec![Event::Ok, snapshot_event()],
            Err(err) => vec![Event::Error {
                message: err.to_string(),
            }],
        },
        Request::CloneAgent { id, name } => match clone_agent(&id, name) {
            Ok(new_id) => vec![Event::Cloned { id: new_id }, snapshot_event()],
            Err(err) => vec![Event::Error {
                message: err.to_string(),
            }],
        },
        Request::RemoveAgent { id } => match remove_agent(&id) {
            Ok(()) => vec![Event::Ok, snapshot_event()],
            Err(err) => vec![Event::Error {
                message: err.to_string(),
            }],
        },
        Request::SetAgent {
            id,
            model,
            effort,
            unset_model,
            unset_effort,
            title,
            description,
            role,
            unset_title,
            unset_description,
            unset_role,
            avatar,
            unset_avatar,
            shape,
            color,
            name,
            cwd,
            unset_cwd,
        } => match set_agent(
            &id,
            model,
            effort,
            unset_model,
            unset_effort,
            title,
            description,
            role,
            unset_title,
            unset_description,
            unset_role,
            avatar,
            unset_avatar,
            shape,
            color,
            name,
            cwd,
            unset_cwd,
        ) {
            Ok(()) => vec![Event::Ok, snapshot_event()],
            Err(err) => vec![Event::Error {
                message: err.to_string(),
            }],
        },
        Request::Reset {
            agent,
            drop_routines,
        } => match reset_agent(&agent, drop_routines) {
            Ok(archive) => vec![
                Event::Reset {
                    agent,
                    archive,
                    drop_routines,
                },
                snapshot_event(),
            ],
            Err(err) => vec![Event::Error {
                message: err.to_string(),
            }],
        },
        Request::AddRoutine {
            agent,
            name,
            schedule,
            prompt,
        } => match add_routine(&agent, name, schedule, prompt) {
            Ok(()) => vec![Event::Ok, snapshot_event()],
            Err(err) => vec![Event::Error {
                message: err.to_string(),
            }],
        },
        Request::RemoveRoutine { agent, key } => match remove_routine(&agent, &key) {
            Ok(()) => vec![Event::Ok, snapshot_event()],
            Err(err) => vec![Event::Error {
                message: err.to_string(),
            }],
        },
        Request::SetRoutineEnabled {
            agent,
            key,
            enabled,
        } => match set_routine_enabled(&agent, &key, enabled) {
            Ok(()) => vec![Event::Ok, snapshot_event()],
            Err(err) => vec![Event::Error {
                message: err.to_string(),
            }],
        },
        Request::RunRoutine { agent, key } => match run_routine(&agent, &key) {
            Ok(()) => vec![Event::Ok, snapshot_event()],
            Err(err) => vec![Event::Error {
                message: err.to_string(),
            }],
        },
        Request::EditRoutine {
            agent,
            key,
            name,
            schedule,
            prompt,
        } => match edit_routine(&agent, &key, name, schedule, prompt) {
            Ok(()) => vec![Event::Ok, snapshot_event()],
            Err(err) => vec![Event::Error {
                message: err.to_string(),
            }],
        },
        Request::RoutineRuns { agent, key } => vec![Event::RoutineRuns {
            agent: agent.clone(),
            key: key.clone(),
            runs: crate::routine_log::list(&agent, &key),
        }],
        Request::ListChannels => vec![Event::Channels {
            channels: list_channels(),
        }],
        Request::ChannelMessages { channel } => match channel_messages_event(&channel) {
            Ok(ev) => vec![ev],
            Err(err) => vec![Event::Error {
                message: err.to_string(),
            }],
        },
        Request::AddChannel { id, name, members } => match add_channel(id, name, members) {
            Ok(()) => vec![
                Event::Ok,
                Event::Channels {
                    channels: list_channels(),
                },
                snapshot_event(),
            ],
            Err(err) => vec![Event::Error {
                message: err.to_string(),
            }],
        },
        Request::JoinChannel { channel, agent } => match join_channel(&channel, &agent) {
            Ok(()) => vec![
                Event::Ok,
                Event::Channels {
                    channels: list_channels(),
                },
                snapshot_event(),
            ],
            Err(err) => vec![Event::Error {
                message: err.to_string(),
            }],
        },
        Request::LeaveChannel { channel, agent } => match leave_channel(&channel, &agent) {
            Ok(()) => vec![
                Event::Ok,
                Event::Channels {
                    channels: list_channels(),
                },
                snapshot_event(),
            ],
            Err(err) => vec![Event::Error {
                message: err.to_string(),
            }],
        },
        Request::RemoveChannel { channel } => match remove_channel(&channel) {
            Ok(()) => vec![
                Event::Ok,
                Event::Channels {
                    channels: list_channels(),
                },
                snapshot_event(),
            ],
            Err(err) => vec![Event::Error {
                message: err.to_string(),
            }],
        },
        Request::SetChannel {
            id,
            name,
            brief,
            unset_brief,
            members,
        } => match set_channel(&id, name, brief, unset_brief, members) {
            Ok(()) => vec![
                Event::Ok,
                Event::Channels {
                    channels: list_channels(),
                },
                snapshot_event(),
            ],
            Err(err) => vec![Event::Error {
                message: err.to_string(),
            }],
        },
        Request::Shutdown => {
            let _ = shutdown.send(true);
            vec![Event::Shutdown]
        }
    }
}

fn list_agents() -> Vec<AgentInfo> {
    let map = agents().lock().expect("agents mutex");
    let cfgs = configs().lock().expect("configs mutex");
    let mut list: Vec<AgentInfo> = map
        .values()
        .map(|s| {
            let status = s.status();
            let cfg = cfgs.get(s.id());
            AgentInfo {
                id: s.id().to_string(),
                name: cfg
                    .map(|c| c.display_name().to_string())
                    .unwrap_or_else(|| s.name().to_string()),
                status,
                cmd: cfg.map(|c| c.cmd.clone()).unwrap_or_else(|| s.cmd()),
                cwd: cfg
                    .map(|c| crate::config::Config::default_cwd(c).display().to_string())
                    .unwrap_or_else(|| s.cwd().display().to_string()),
                model: cfg.and_then(|c| c.model.clone()),
                effort: cfg.and_then(|c| c.effort),
                avatar: cfg.and_then(|c| c.avatar.clone()),
                avatar_shape: cfg.and_then(|c| c.avatar_shape),
                avatar_color: cfg.and_then(|c| c.avatar_color.clone()),
                title: cfg.and_then(|c| c.title.clone()),
                description: cfg.and_then(|c| c.description.clone()),
                role: cfg.and_then(|c| c.role.clone()),
                routines: cfg.map(|c| c.routines.clone()).unwrap_or_default(),
                preview: None,
                origin_channel: get_origin(s.id()).and_then(|o| o.reply_channel),
                last_ts: 0,
            }
        })
        .collect();
    list.sort_by(|a, b| a.id.cmp(&b.id));
    for a in &mut list {
        a.preview = crate::transcript::preview(&a.id);
        a.last_ts = crate::transcript::last_ts(&a.id);
    }
    list
}

fn all_snapshots() -> Vec<Event> {
    let map = agents().lock().expect("agents mutex");
    map.values().map(|s| s.snapshot_event()).collect()
}

fn snapshot_agent(id: &str) -> anyhow::Result<Event> {
    let map = agents().lock().expect("agents mutex");
    let session = map.get(id).with_context(|| format!("unknown agent {id}"))?;
    Ok(session.snapshot_event())
}

fn messages_agent(id: &str) -> anyhow::Result<Event> {
    {
        let map = agents().lock().expect("agents mutex");
        if !map.contains_key(id) {
            anyhow::bail!("unknown agent {id}");
        }
    }
    Ok(Event::Messages {
        agent: id.to_string(),
        messages: crate::transcript::messages(id),
    })
}

fn apply_user_interrupt(id: &str, text: &str) -> anyhow::Result<bool> {
    let status = live_status(id)?;
    match crate::interrupt::member_turn_action(true, status, text) {
        crate::interrupt::UserSendAction::Stop => {
            interrupt_turn(id)?;
            Ok(false)
        }
        crate::interrupt::UserSendAction::Redirect => {
            interrupt_turn(id)?;
            Ok(true)
        }
        crate::interrupt::UserSendAction::Start => Ok(true),
    }
}

fn send_agent(id: &str, text: &str) -> anyhow::Result<()> {
    let proceed = apply_user_interrupt(id, text)?;
    if !proceed {
        crate::transcript::push_user(id, "user", text);
        return Ok(());
    }
    ensure_accepts_turn(id)?;
    let roster = roster_vec();
    let msg = crate::transcript::push_user(id, "user", text);
    let mentions = targeting::one_on_one_tell_targets(text, id, &roster);
    let delivered = crate::config::with_mention_hint(text, id, &roster);
    submit_delivery(id, &delivered, true, Some(msg.id), TurnOrigin::user())?;
    for to in mentions {
        let origin = TurnOrigin::mention_tell(id);
        match tell_agent_origin("user", &to, text, Some(origin)) {
            Ok(()) => {
                crate::transcript::push_notice(id, &format!("to:{to}"), text);
            }
            Err(err) => {
                eprintln!("[crew] mention tell {id} -> {to}: {err:#}");
            }
        }
    }
    Ok(())
}

fn ensure_accepts_turn(id: &str) -> anyhow::Result<()> {
    let map = agents().lock().expect("agents mutex");
    let live = map
        .get(id)
        .with_context(|| format!("unknown agent {id}"))?;
    match live {
        LiveAgent::Headless(_) => Ok(()),
        LiveAgent::Pty(session) => {
            let inner = session.inner.lock().expect("pty inner");
            if inner.status == AgentStatus::Exited {
                anyhow::bail!("agent {id} has exited");
            }
            Ok(())
        }
    }
}

fn from_id(from: &str) -> String {
    let from = from.trim();
    if from.is_empty() {
        "user".into()
    } else {
        from.to_string()
    }
}

fn tell_agent(from: &str, to: &str, text: &str) -> anyhow::Result<()> {
    tell_agent_origin(from, to, text, None)
}

fn tell_agent_origin(
    from: &str,
    to: &str,
    text: &str,
    origin: Option<TurnOrigin>,
) -> anyhow::Result<()> {
    let to = to.trim();
    if to.is_empty() {
        anyhow::bail!("unknown agent {to}");
    }
    {
        let map = agents().lock().expect("agents mutex");
        if !map.contains_key(to) {
            anyhow::bail!("unknown agent {to}");
        }
    }
    let from = from_id(from);
    ensure_accepts_turn(to)?;
    let msg = crate::transcript::push_system(to, &from, text);
    let envelope = crate::protocol::envelope(&from, text);
    let parsed = targeting::origin_from_envelope(&envelope);
    let parent = origin.or_else(|| get_origin(&from));
    let origin = targeting::inherit_origin(parent.as_ref(), parsed);
    submit_delivery(to, &envelope, true, Some(msg.id), origin)?;
    if from != "user" && from != to {
        let known = agents()
            .lock()
            .ok()
            .map(|map| map.contains_key(&from))
            .unwrap_or(false);
        if known {
            crate::transcript::push_notice(&from, &format!("to:{to}"), text);
        }
    }
    let _ = events().send(Event::Told {
        from: from.clone(),
        to: to.to_string(),
    });
    Ok(())
}

fn deliver(id: &str, text: &str, newline: bool) -> anyhow::Result<()> {
    let live = {
        let map = agents().lock().expect("agents mutex");
        map.get(id)
            .cloned()
            .with_context(|| format!("unknown agent {id}"))?
    };
    match live {
        LiveAgent::Pty(_) => write_pty(id, text, newline),
        LiveAgent::Headless(session) => {
            let cfg = clone_agent_cfg(id)?;
            let roster = roster_vec();
            headless::kick(session, cfg, roster, text.to_string())
        }
    }
}

fn write_agent(id: &str, text: &str, newline: bool) -> anyhow::Result<()> {
    write_pty(id, text, newline)
}

fn write_pty(id: &str, text: &str, newline: bool) -> anyhow::Result<()> {
    let session = {
        let map = agents().lock().expect("agents mutex");
        let live = map.get(id).with_context(|| format!("unknown agent {id}"))?;
        live.pty()
            .with_context(|| format!("agent {id} is headless (no PTY)"))?
    };
    {
        let mut inner = session.inner.lock().expect("pty inner");
        if inner.status == AgentStatus::Exited {
            anyhow::bail!("agent {id} has exited");
        }
        inner.writer.write_all(text.as_bytes())?;
        if newline && !text.ends_with('\n') {
            inner.writer.write_all(b"\n")?;
        }
        inner.writer.flush()?;
        inner.last_output = Instant::now();
        if inner.status != AgentStatus::Exited {
            inner.status = AgentStatus::Working;
            inner.seq += 1;
        }
    }
    emit_frame(&session);
    Ok(())
}

fn resize_agent(id: &str, cols: u16, rows: u16) -> anyhow::Result<()> {
    let cols = cols.max(20);
    let rows = rows.max(8);
    let live = {
        let map = agents().lock().expect("agents mutex");
        map.get(id)
            .cloned()
            .with_context(|| format!("unknown agent {id}"))?
    };
    match live {
        LiveAgent::Headless(session) => {
            if let Ok(mut inner) = session.inner.lock() {
                inner.cols = cols;
                inner.rows = rows;
                inner.seq += 1;
            }
            emit_agent_frame(id);
            Ok(())
        }
        LiveAgent::Pty(session) => {
            {
                let mut inner = session.inner.lock().expect("pty inner");
                inner.master.resize(portable_pty::PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })?;
                inner.parser.set_size(rows, cols);
                inner.cols = cols;
                inner.rows = rows;
                inner.seq += 1;
            }
            emit_frame(&session);
            Ok(())
        }
    }
}

fn add_agent(
    id: String,
    name: String,
    cmd: Vec<String>,
    cwd: Option<String>,
    model: Option<String>,
    effort: Option<crate::config::Effort>,
) -> anyhow::Result<()> {
    let cwd = cwd
        .filter(|s| !s.trim().is_empty())
        .or_else(|| Some(crate::config::default_add_cwd(&id)));
    let mut cfg = AgentConfig::new(
        id.clone(),
        if name.is_empty() { id } else { name },
        cmd,
        cwd,
    );
    cfg.model = model.filter(|m| !m.is_empty());
    cfg.effort = effort;
    insert_spawned_agent(cfg)
}

fn clone_agent(src_id: &str, name: Option<String>) -> anyhow::Result<String> {
    let src = clone_agent_cfg(src_id)?;
    let existing: Vec<String> = roster_vec().into_iter().map(|a| a.id).collect();
    let mut cfg = src.duplicate(name.as_deref(), existing.iter().map(|s| s.as_str()));
    cfg.avatar = crate::avatar::copy_for(src.avatar.as_deref(), &cfg.id);
    crate::memory::copy(src_id, &cfg.id)?;
    let new_id = cfg.id.clone();
    insert_spawned_agent(cfg)?;
    Ok(new_id)
}

fn insert_spawned_agent(cfg: AgentConfig) -> anyhow::Result<()> {
    if cfg.id.trim().is_empty() {
        anyhow::bail!("agent id is empty");
    }
    if cfg.cmd.is_empty() {
        anyhow::bail!("cmd is empty");
    }
    {
        let map = agents().lock().expect("agents mutex");
        if map.contains_key(&cfg.id) {
            anyhow::bail!("agent {} already exists", cfg.id);
        }
    }
    if let Some(ref cwd) = cfg.cwd {
        paths::create_cwd(&paths::expand_tilde(cwd))?;
    }
    let id = cfg.id.clone();
    let mut roster = roster_vec();
    if !roster.iter().any(|a| a.id == cfg.id) {
        roster.push(cfg.clone());
    }
    let live = open_agent(&cfg, DEFAULT_COLS, DEFAULT_ROWS, false, &roster)?;
    crate::transcript::load_agent(&id);
    agents()
        .lock()
        .expect("agents mutex")
        .insert(id.clone(), live);
    configs()
        .lock()
        .expect("configs mutex")
        .insert(id.clone(), cfg);
    save_state()?;
    inject_roster_update(Some(&id));
    Ok(())
}

fn remove_agent(id: &str) -> anyhow::Result<()> {
    let session = {
        let mut map = agents().lock().expect("agents mutex");
        map.remove(id)
            .with_context(|| format!("unknown agent {id}"))?
    };
    configs().lock().expect("configs mutex").remove(id);
    crate::avatar::clear(id);
    crate::memory::remove(id);
    crate::transcript::drop_agent(id);
    crate::headless::clear_session(id);
    clear_inbox(id);
    session.kill();
    if let Ok(mut chans) = channels().lock() {
        for ch in chans.values_mut() {
            ch.members.retain(|m| m != id);
        }
    }
    save_state()?;
    inject_roster_update(None);
    Ok(())
}

fn inject_roster_update(skip: Option<&str>) {
    let roster = roster_vec();
    let ids: Vec<String> = match agents().lock() {
        Ok(map) => map
            .iter()
            .filter(|(id, session)| {
                if skip == Some(id.as_str()) {
                    return false;
                }
                session.pty().is_some() && session.is_live()
            })
            .map(|(id, _)| id.clone())
            .collect(),
        Err(_) => return,
    };
    for id in ids {
        let Some(agent) = roster.iter().find(|a| a.id == id) else {
            continue;
        };
        let text = crate::protocol::system_envelope(&roster_update_text(agent, &roster));
        if let Err(err) = write_agent(&id, &text, true) {
            eprintln!("[crew] roster update {id}: {err:#}");
        }
    }
}

fn persist_config(cfg: &AgentConfig) -> anyhow::Result<()> {
    configs()
        .lock()
        .expect("configs mutex")
        .insert(cfg.id.clone(), cfg.clone());
    save_state()
}

fn set_agent(
    id: &str,
    model: Option<String>,
    effort: Option<Effort>,
    unset_model: bool,
    unset_effort: bool,
    title: Option<String>,
    description: Option<String>,
    role: Option<String>,
    unset_title: bool,
    unset_description: bool,
    unset_role: bool,
    avatar: Option<String>,
    unset_avatar: bool,
    shape: Option<AvatarShape>,
    color: Option<String>,
    name: Option<String>,
    cwd: Option<String>,
    unset_cwd: bool,
) -> anyhow::Result<()> {
    let mut cfg = {
        let cfgs = configs().lock().expect("configs mutex");
        cfgs.get(id)
            .cloned()
            .with_context(|| format!("unknown agent {id}"))?
    };
    if unset_model {
        cfg.model = None;
    } else if let Some(model) = model {
        cfg.model = empty_to_none(model);
    }
    if unset_effort {
        cfg.effort = None;
    } else if let Some(effort) = effort {
        cfg.effort = Some(effort);
    }
    if unset_title {
        cfg.title = None;
    } else if let Some(title) = title {
        cfg.title = empty_to_none(title);
    }
    if unset_description {
        cfg.description = None;
    } else if let Some(description) = description {
        cfg.description = empty_to_none(description);
    }
    if unset_role {
        cfg.role = None;
    } else if let Some(role) = role {
        cfg.role = empty_to_none(role);
    }
    if let Some(shape) = shape {
        cfg.avatar_shape = Some(shape);
    }
    if let Some(color) = color {
        cfg.avatar_color = Some(parse_hex_color(&color)?);
    }
    if let Some(name) = name {
        let name = name.trim();
        if !name.is_empty() {
            cfg.name = name.to_string();
        }
    }
    if unset_cwd {
        cfg.cwd = None;
    } else if let Some(cwd) = cwd {
        cfg.cwd = empty_to_none(cwd);
    }
    crate::avatar::apply(&mut cfg, avatar, unset_avatar)?;
    persist_config(&cfg)?;
    Ok(())
}

fn clone_agent_cfg(id: &str) -> anyhow::Result<AgentConfig> {
    let cfgs = configs().lock().expect("configs mutex");
    cfgs.get(id)
        .cloned()
        .with_context(|| format!("unknown agent {id}"))
}

fn add_routine(agent: &str, name: String, schedule: String, prompt: String) -> anyhow::Result<()> {
    let (name, schedule, prompt) = resolve_routine_fields(name, schedule, prompt)?;
    let mut cfg = clone_agent_cfg(agent)?;
    cfg.routines.push(Routine::new(name, schedule, prompt)?);
    persist_config(&cfg)
}

fn resolve_routine_fields(
    name: String,
    schedule: String,
    prompt: String,
) -> anyhow::Result<(String, String, String)> {
    if cron::validate(&schedule).is_ok() && !name.trim().is_empty() && !prompt.trim().is_empty() {
        return Ok((name, schedule, prompt));
    }
    let blob = [name.trim(), schedule.trim(), prompt.trim()]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let parsed = crate::nl_routine::parse_nl_routine(&blob)?;
    let name = if name.trim().is_empty() {
        parsed.name
    } else {
        name
    };
    let prompt = if prompt.trim().is_empty() {
        parsed.prompt
    } else {
        prompt
    };
    Ok((name, parsed.schedule, prompt))
}

fn edit_routine(
    agent: &str,
    key: &str,
    name: Option<String>,
    schedule: Option<String>,
    prompt: Option<String>,
) -> anyhow::Result<()> {
    let mut cfg = clone_agent_cfg(agent)?;
    let idx = find_routine_index(&cfg.routines, key)
        .ok_or_else(|| anyhow::anyhow!("unknown routine {key}"))?;
    if let Some(name) = name {
        let name = name.trim();
        if !name.is_empty() {
            cfg.routines[idx].name = name.to_string();
        }
    }
    if let Some(schedule) = schedule {
        let schedule = schedule.trim();
        if !schedule.is_empty() {
            let resolved = if cron::validate(schedule).is_ok() {
                schedule.to_string()
            } else {
                crate::nl_routine::parse_nl_routine(schedule)?.schedule
            };
            cron::validate(&resolved)?;
            cfg.routines[idx].schedule = resolved;
        }
    }
    if let Some(prompt) = prompt {
        let prompt = prompt.trim();
        if !prompt.is_empty() {
            cfg.routines[idx].prompt = prompt.to_string();
        }
    }
    persist_config(&cfg)
}

fn remove_routine(agent: &str, key: &str) -> anyhow::Result<()> {
    let mut cfg = clone_agent_cfg(agent)?;
    let idx = find_routine_index(&cfg.routines, key)
        .ok_or_else(|| anyhow::anyhow!("unknown routine {key}"))?;
    cfg.routines.remove(idx);
    persist_config(&cfg)
}

fn set_routine_enabled(agent: &str, key: &str, enabled: bool) -> anyhow::Result<()> {
    let mut cfg = clone_agent_cfg(agent)?;
    let idx = find_routine_index(&cfg.routines, key)
        .ok_or_else(|| anyhow::anyhow!("unknown routine {key}"))?;
    cfg.routines[idx].enabled = enabled;
    persist_config(&cfg)
}

fn run_routine(agent: &str, key: &str) -> anyhow::Result<()> {
    let cfg = clone_agent_cfg(agent)?;
    let idx = find_routine_index(&cfg.routines, key)
        .ok_or_else(|| anyhow::anyhow!("unknown routine {key}"))?;
    let r = &cfg.routines[idx];
    let name = r.name.clone();
    let prompt = r.prompt.clone();
    let rid = r.id.clone();
    match fire_routine(agent, &name, &prompt) {
        Ok(()) => {
            let _ = crate::routine_log::record(agent, &rid, true, "ok");
        }
        Err(err) => {
            let _ = crate::routine_log::record(agent, &rid, false, &err.to_string());
            return Err(err);
        }
    }
    let minute_key = cron::now_local()
        .map(|t| t.minute_key())
        .unwrap_or_else(|_| paths::utc_timestamp());
    mark_routine_run(agent, &rid, &minute_key)
}

fn reset_agent(id: &str, drop_routines: bool) -> anyhow::Result<String> {
    let old = {
        let map = agents().lock().expect("agents mutex");
        map.get(id)
            .cloned()
            .with_context(|| format!("unknown agent {id}"))?
    };
    let (cols, rows, pane, status) = match &old {
        LiveAgent::Pty(session) => {
            let inner = session.inner.lock().expect("pty inner");
            (
                inner.cols,
                inner.rows,
                pty_agent::screen_text(&inner),
                inner.status,
            )
        }
        LiveAgent::Headless(session) => {
            let inner = session.inner.lock().expect("headless inner");
            (inner.cols, inner.rows, String::new(), inner.status)
        }
    };

    let mut cfg = {
        let cfgs = configs().lock().expect("configs mutex");
        cfgs.get(id)
            .cloned()
            .with_context(|| format!("unknown agent {id}"))?
    };
    if drop_routines {
        cfg.routines.clear();
    }

    let stamp = paths::utc_timestamp();
    let dir = paths::archive_agent_dir(id, &stamp);
    fs::create_dir_all(&dir)?;
    fs::write(dir.join("pane.txt"), pane)?;
    crate::transcript::archive_and_clear(id, &dir)?;
    let meta = serde_json::json!({
        "agent": id,
        "archived_at": stamp,
        "cmd": cfg.cmd,
        "cwd": crate::config::Config::default_cwd(&cfg).display().to_string(),
        "model": cfg.model,
        "effort": cfg.effort,
        "status": status,
        "drop_routines": drop_routines,
    });
    fs::write(
        dir.join("meta.json"),
        serde_json::to_string_pretty(&meta)? + "\n",
    )?;

    persist_config(&cfg)?;

    let roster = roster_vec();
    crate::headless::clear_session(id);
    clear_inbox(id);
    let new_session = open_agent(&cfg, cols, rows, true, &roster)?;
    {
        let mut map = agents().lock().expect("agents mutex");
        map.insert(id.to_string(), new_session.clone());
    }
    old.kill();
    emit_agent_frame(id);
    eprintln!(
        "[crew] reset {} -> archived {} (drop_routines={drop_routines})",
        id,
        dir.display()
    );
    Ok(dir.display().to_string())
}

fn list_channels() -> Vec<ChannelInfo> {
    let mut list: Vec<ChannelInfo> = channel_vec()
        .into_iter()
        .map(|c| ChannelInfo {
            id: c.id.clone(),
            name: c.name.clone(),
            members: c.members.clone(),
            brief: c.brief.clone(),
            preview: crate::transcript::channel_preview(&c.id),
            last_ts: crate::transcript::channel_last_ts(&c.id),
        })
        .collect();
    list.sort_by(|a, b| a.id.cmp(&b.id));
    list
}

fn channel_messages_event(id: &str) -> anyhow::Result<Event> {
    let id = id.trim();
    {
        let chans = channels().lock().expect("channels mutex");
        if !chans.contains_key(id) {
            anyhow::bail!("unknown channel {id}");
        }
    }
    Ok(Event::ChannelMessages {
        channel: id.to_string(),
        messages: crate::transcript::channel_messages(id),
    })
}

fn known_agent(id: &str) -> bool {
    configs()
        .lock()
        .ok()
        .map(|m| m.contains_key(id))
        .unwrap_or(false)
}

fn add_channel(id: String, name: String, members: Vec<String>) -> anyhow::Result<()> {
    let members = unique_ids(members);
    for m in &members {
        if !known_agent(m) {
            anyhow::bail!("unknown agent {m}");
        }
    }
    let ch = Channel::new(id, name, members)?;
    {
        let mut chans = channels().lock().expect("channels mutex");
        if chans.contains_key(&ch.id) {
            anyhow::bail!("channel {} already exists", ch.id);
        }
        crate::transcript::load_channel(&ch.id);
        chans.insert(ch.id.clone(), ch);
    }
    save_state()?;
    Ok(())
}

fn join_channel(channel: &str, agent: &str) -> anyhow::Result<()> {
    let channel = channel.trim();
    let agent = agent.trim();
    if channel.is_empty() {
        anyhow::bail!("channel id is empty");
    }
    if agent.is_empty() {
        anyhow::bail!("agent id is empty");
    }
    if !known_agent(agent) {
        anyhow::bail!("unknown agent {agent}");
    }
    {
        let mut chans = channels().lock().expect("channels mutex");
        let ch = chans
            .get_mut(channel)
            .with_context(|| format!("unknown channel {channel}"))?;
        if !ch.members.iter().any(|m| m == agent) {
            ch.members.push(agent.to_string());
        }
    }
    save_state()?;
    Ok(())
}

fn set_channel(
    id: &str,
    name: Option<String>,
    brief: Option<String>,
    unset_brief: bool,
    members: Option<Vec<String>>,
) -> anyhow::Result<()> {
    let id = id.trim();
    if id.is_empty() {
        anyhow::bail!("channel id is empty");
    }
    let known: Vec<String> = roster_vec().into_iter().map(|a| a.id).collect();
    {
        let mut chans = channels().lock().expect("channels mutex");
        let ch = chans
            .get_mut(id)
            .with_context(|| format!("unknown channel {id}"))?;
        if let Some(name) = name {
            ch.set_name(name);
        }
        if unset_brief {
            ch.set_brief(None);
        } else if let Some(brief) = brief {
            ch.set_brief(Some(brief));
        }
        if let Some(members) = members {
            ch.set_members(members, &known)?;
        }
    }
    save_state()?;
    Ok(())
}

fn leave_channel(channel: &str, agent: &str) -> anyhow::Result<()> {
    let channel = channel.trim();
    let agent = agent.trim();
    if channel.is_empty() {
        anyhow::bail!("channel id is empty");
    }
    if agent.is_empty() {
        anyhow::bail!("agent id is empty");
    }
    if !known_agent(agent) {
        anyhow::bail!("unknown agent {agent}");
    }
    {
        let mut chans = channels().lock().expect("channels mutex");
        let ch = chans
            .get_mut(channel)
            .with_context(|| format!("unknown channel {channel}"))?;
        let before = ch.members.len();
        ch.members.retain(|m| m != agent);
        if ch.members.len() == before {
            anyhow::bail!("{agent} is not a member of channel {channel}");
        }
    }
    save_state()?;
    Ok(())
}

fn remove_channel(channel: &str) -> anyhow::Result<()> {
    let channel = channel.trim();
    if channel.is_empty() {
        anyhow::bail!("channel id is empty");
    }
    {
        let mut chans = channels().lock().expect("channels mutex");
        if chans.remove(channel).is_none() {
            anyhow::bail!("unknown channel {channel}");
        }
    }
    crate::transcript::drop_channel(channel);
    save_state()?;
    Ok(())
}

fn send_channel(channel: &str, from: &str, text: &str) -> anyhow::Result<()> {
    let channel = channel.trim();
    if channel.is_empty() {
        anyhow::bail!("unknown channel {channel}");
    }
    let ch = {
        let chans = channels().lock().expect("channels mutex");
        chans
            .get(channel)
            .cloned()
            .with_context(|| format!("unknown channel {channel}"))?
    };
    let from = from_id(from);
    if from != "user" && !ch.members.iter().any(|m| m == &from) {
        anyhow::bail!("{from} is not a member of channel {channel}");
    }
    if ch.members.is_empty() {
        anyhow::bail!("channel {channel} has no members");
    }
    let role = if from == "user" {
        Role::User
    } else {
        Role::Assistant
    };
    crate::transcript::push_channel(&ch.id, role, &from, text);
    let stored = crate::transcript::channel_messages(&ch.id);
    let recent_text: Vec<String> = stored
        .iter()
        .map(|m| crate::rows::display_text(m))
        .collect();
    let recent: Vec<_> = stored
        .iter()
        .zip(recent_text.iter())
        .map(|(m, t)| crate::channel_context::WakeLine {
            from: m.from.as_str(),
            text: t.as_str(),
        })
        .collect();
    let envelope = crate::channel_context::wake_text(
        &ch.id,
        &ch.name,
        ch.brief.as_deref(),
        &recent,
        &from,
        text,
    );
    let default_one = from == "user";
    let last = if default_one {
        channel_last_member_speaker(&ch.id, &ch.members)
    } else {
        None
    };
    let mut pool = ch.members.clone();
    if from != "user" {
        pool.retain(|m| m != &from);
    }
    let targets = targeting::channel_wake_targets(
        text,
        &pool,
        &roster_vec(),
        last.as_deref(),
        default_one,
    );
    if targets.is_empty() {
        return Ok(());
    }
    // A bot posting to the room continues whatever chain it is already in; a user
    // post starts a fresh one.
    let parent = if from == "user" { None } else { get_origin(&from) };
    let origin = targeting::inherit_origin(parent.as_ref(), TurnOrigin::channel(&ch.id, &from));
    let mut sent = 0usize;
    let mut last_err: Option<anyhow::Error> = None;
    for to in &targets {
        if from == "user" {
            match apply_user_interrupt(to, text) {
                Ok(false) => {
                    sent += 1;
                    continue;
                }
                Ok(true) => {}
                Err(err) => {
                    last_err = Some(err);
                    continue;
                }
            }
        }
        if ensure_accepts_turn(to).is_err() {
            continue;
        }
        let msg = crate::transcript::push_system(to, &format!("#{channel}"), text);
        match submit_delivery(to, &envelope, true, Some(msg.id), origin.clone()) {
            Ok(()) => sent += 1,
            Err(err) => last_err = Some(err),
        }
    }
    if sent == 0 {
        if let Some(err) = last_err {
            return Err(err);
        }
        anyhow::bail!("no members received the message");
    }
    Ok(())
}

fn channel_last_member_speaker(channel: &str, members: &[String]) -> Option<String> {
    crate::transcript::channel_messages(channel)
        .into_iter()
        .rev()
        .find_map(|m| {
            if m.from == "user" || m.role == Role::User {
                return None;
            }
            members.iter().find(|id| *id == &m.from).cloned()
        })
}

fn known_channel(id: &str) -> bool {
    channels()
        .lock()
        .ok()
        .map(|m| m.contains_key(id))
        .unwrap_or(false)
}

fn on_assistant_sealed(agent: &str, msg: &ChatMessage) {
    if msg.role != Role::Assistant {
        return;
    }
    let text = crate::rows::display_text(msg);
    if text.is_empty() {
        return;
    }
    let Some(origin) = get_origin(agent) else {
        return;
    };
    let targets = targeting::postback_targets(&origin, agent);
    if let Some(channel) = targets.channel {
        if known_channel(&channel) {
            let dup = crate::transcript::channel_messages(&channel)
                .last()
                .map(|m| m.from == agent && m.text.trim() == text)
                .unwrap_or(false);
            if !dup {
                crate::transcript::push_channel(&channel, Role::Assistant, agent, &text);
            }
            if crate::interrupt::looks_like_judgment_question(&text) {
                if let Some(ch_msg) = crate::transcript::channel_messages(&channel).last() {
                    if ch_msg.from == agent {
                        crate::transcript::set_approval(
                            &format!("ch:{channel}"),
                            &ch_msg.id,
                            crate::protocol::ApprovalState::Pending,
                        );
                    }
                }
            }
        }
    }
    if let Some(peer) = targets.agent {
        if known_agent(&peer) {
            crate::transcript::push_handoff(&peer, agent, &text);
        }
    }
    if crate::interrupt::looks_like_judgment_question(&text) {
        crate::transcript::set_approval(agent, &msg.id, crate::protocol::ApprovalState::Pending);
        set_live_status(agent, AgentStatus::Blocked);
    }
}

#[cfg(test)]
mod inbox_tests {
    use super::*;

    #[test]
    fn relay_limit_refuses_the_delivery() {
        let id = "test-relay-cap";
        let origin = TurnOrigin {
            from: "beta".into(),
            hops: targeting::MAX_RELAY_HOPS + 1,
            ..TurnOrigin::default()
        };
        let err = submit_delivery(id, "again?", true, None, origin)
            .expect_err("a spent chain must not start another turn");
        assert!(err.to_string().contains("relay limit"), "{err}");
        let last = crate::transcript::messages(id);
        assert_eq!(last.last().map(|m| m.from.as_str()), Some("crew"));
    }

    #[test]
    fn inbox_is_fifo() {
        let id = "test-inbox-fifo";
        clear_inbox(id);
        enqueue_delivery(id, "a", true, None, TurnOrigin::user()).unwrap();
        enqueue_delivery(id, "b", true, None, TurnOrigin::user()).unwrap();
        let mut map = inbox().lock().unwrap();
        let q = map.get_mut(id).unwrap();
        assert_eq!(q.pop_front().unwrap().text, "a");
        assert_eq!(q.pop_front().unwrap().text, "b");
        drop(map);
        clear_inbox(id);
    }

    #[test]
    fn inbox_caps_at_max() {
        let id = "test-inbox-full";
        clear_inbox(id);
        for i in 0..MAX_INBOX {
            enqueue_delivery(id, &i.to_string(), true, None, TurnOrigin::user()).unwrap();
        }
        let err = enqueue_delivery(id, "overflow", true, None, TurnOrigin::user()).unwrap_err();
        assert!(err.to_string().contains("inbox full"), "{err}");
        clear_inbox(id);
    }

    #[test]
    fn sealed_reply_posts_back_to_origin_channel() {
        let ch = format!(
            "room-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        let speaker = format!("beta-{ch}");
        channels().lock().unwrap().insert(
            ch.clone(),
            crate::config::Channel::new(ch.clone(), ch.clone(), vec![speaker.clone()]).unwrap(),
        );
        configs().lock().unwrap().insert(
            speaker.clone(),
            crate::config::AgentConfig::new(
                speaker.clone(),
                speaker.clone(),
                vec!["cat".into()],
                None,
            ),
        );
        crate::transcript::load_channel(&ch);
        crate::transcript::push_channel(&ch, Role::User, "user", "hello");
        set_origin(&speaker, TurnOrigin::channel(&ch, "user"));
        let reply = ChatMessage {
            id: "r1".into(),
            role: Role::Assistant,
            from: speaker.clone(),
            text: "on it".into(),
            ts: 1,
            queued: false,
            kind: None,
            approval: None,
        };
        on_assistant_sealed(&speaker, &reply);
        let msgs = crate::transcript::channel_messages(&ch);
        let last = msgs.last().expect("channel reply");
        assert_eq!(last.from, speaker);
        assert_eq!(last.role, Role::Assistant);
        assert_eq!(last.text, "on it");
        let kept = get_origin(&speaker).expect("origin stays while the turn is this room");
        assert_eq!(kept.reply_channel.as_deref(), Some(ch.as_str()));
        crate::transcript::drop_channel(&ch);
        channels().lock().unwrap().remove(&ch);
        configs().lock().unwrap().remove(&speaker);
        take_origin(&speaker);
    }

    #[test]
    fn sealed_judgment_marks_channel_approval() {
        let ch = format!(
            "room-ask-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        let speaker = format!("beta-{ch}");
        channels().lock().unwrap().insert(
            ch.clone(),
            crate::config::Channel::new(ch.clone(), ch.clone(), vec![speaker.clone()]).unwrap(),
        );
        configs().lock().unwrap().insert(
            speaker.clone(),
            crate::config::AgentConfig::new(
                speaker.clone(),
                speaker.clone(),
                vec!["cat".into()],
                None,
            ),
        );
        crate::transcript::load_channel(&ch);
        set_origin(&speaker, TurnOrigin::channel(&ch, "user"));
        let reply = ChatMessage {
            id: "ask1".into(),
            role: Role::Assistant,
            from: speaker.clone(),
            text: "이 변경을 실행할까요?".into(),
            ts: 1,
            queued: false,
            kind: None,
            approval: None,
        };
        on_assistant_sealed(&speaker, &reply);
        let ch_last = crate::transcript::channel_messages(&ch)
            .last()
            .cloned()
            .expect("channel ask");
        assert_eq!(
            ch_last.approval,
            Some(crate::protocol::ApprovalState::Pending)
        );
        crate::transcript::drop_channel(&ch);
        channels().lock().unwrap().remove(&ch);
        configs().lock().unwrap().remove(&speaker);
        take_origin(&speaker);
    }

    #[test]
    fn sealed_reply_handoff_to_origin_agent() {
        let peer = format!(
            "alpha-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        let speaker = format!("beta-{peer}");
        configs().lock().unwrap().insert(
            peer.clone(),
            crate::config::AgentConfig::new(peer.clone(), peer.clone(), vec!["cat".into()], None),
        );
        crate::transcript::load_agent(&peer);
        set_origin(&speaker, TurnOrigin::mention_tell(&peer));
        let reply = ChatMessage {
            id: "r2".into(),
            role: Role::Assistant,
            from: speaker.clone(),
            text: "reviewed".into(),
            ts: 1,
            queued: false,
            kind: None,
            approval: None,
        };
        on_assistant_sealed(&speaker, &reply);
        let msgs = crate::transcript::messages(&peer);
        let last = msgs.last().expect("handoff");
        assert_eq!(last.from, speaker);
        assert_eq!(last.kind, Some(crate::protocol::MessageKind::Handoff));
        assert_eq!(last.text, "reviewed");
        crate::transcript::drop_agent(&peer);
        configs().lock().unwrap().remove(&peer);
    }
}
