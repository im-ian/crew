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
use crate::protocol::{AgentInfo, AgentStatus, ChannelInfo, Event, Request, Role};
use crate::pty_agent::{self, PtySession};

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

struct PendingDelivery {
    text: String,
    newline: bool,
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

fn enqueue_delivery(id: &str, text: &str, newline: bool) -> anyhow::Result<()> {
    let mut map = inbox().lock().expect("inbox mutex");
    let q = map.entry(id.to_string()).or_default();
    if q.len() >= MAX_INBOX {
        anyhow::bail!("agent {id} is busy (inbox full)");
    }
    q.push_back(PendingDelivery {
        text: text.to_string(),
        newline,
    });
    Ok(())
}

fn is_busy_err(err: &anyhow::Error) -> bool {
    err.to_string().contains("is working")
}

fn agent_busy(id: &str) -> anyhow::Result<bool> {
    let map = agents().lock().expect("agents mutex");
    let live = map
        .get(id)
        .with_context(|| format!("unknown agent {id}"))?;
    match live {
        LiveAgent::Headless(session) => {
            let inner = session.inner.lock().expect("headless inner");
            Ok(inner.status == AgentStatus::Working || inner.child.is_some())
        }
        LiveAgent::Pty(session) => {
            let inner = session.inner.lock().expect("pty inner");
            if inner.status == AgentStatus::Exited {
                anyhow::bail!("agent {id} has exited");
            }
            Ok(false)
        }
    }
}

fn start_delivery(id: &str, text: &str, newline: bool) -> anyhow::Result<()> {
    crate::transcript::expect_echo(id, text);
    match deliver(id, text, newline) {
        Ok(()) => Ok(()),
        Err(err) => {
            crate::transcript::cancel_expect(id);
            Err(err)
        }
    }
}

fn submit_delivery(id: &str, text: &str, newline: bool) -> anyhow::Result<()> {
    if agent_busy(id)? {
        return enqueue_delivery(id, text, newline);
    }
    match start_delivery(id, text, newline) {
        Ok(()) => Ok(()),
        Err(err) if is_busy_err(&err) => enqueue_delivery(id, text, newline),
        Err(err) => Err(err),
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
    if let Err(err) = start_delivery(id, &item.text, item.newline) {
        if is_busy_err(&err) {
            if let Ok(mut map) = inbox().lock() {
                map.entry(id.to_string())
                    .or_default()
                    .push_front(item);
            }
            return;
        }
        eprintln!("[crew] inbox {id}: {err:#}");
        pump_inbox(id);
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
    let _ = events().send(ev);
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
        {
            let map = match agents().lock() {
                Ok(m) => m,
                Err(_) => return,
            };
            match map.get(&agent) {
                Some(live) => {
                    if live.status() == AgentStatus::Exited {
                        continue;
                    }
                }
                None => continue,
            }
        }
        match fire_routine(&agent, &name, &prompt) {
            Ok(()) => {
                if let Err(err) = mark_routine_run(&agent, &rid, &key) {
                    eprintln!("[crew] routine last_run {agent}/{name}: {err:#}");
                }
            }
            Err(err) => {
                eprintln!("[crew] routine {agent}/{name}: {err:#}");
            }
        }
    }
}

fn fire_routine(agent: &str, name: &str, prompt: &str) -> anyhow::Result<()> {
    ensure_accepts_turn(agent)?;
    crate::transcript::push_system(agent, name, prompt);
    let envelope = crate::protocol::routine_envelope(name, prompt);
    submit_delivery(agent, &envelope, true)?;
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
                cwd: s.cwd().display().to_string(),
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
            }
        })
        .collect();
    list.sort_by(|a, b| a.id.cmp(&b.id));
    for a in &mut list {
        a.preview = crate::transcript::preview(&a.id);
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

fn send_agent(id: &str, text: &str) -> anyhow::Result<()> {
    ensure_accepts_turn(id)?;
    crate::transcript::push_user(id, "user", text);
    let delivered = crate::config::with_mention_hint(text, id, &roster_vec());
    submit_delivery(id, &delivered, true)
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
    crate::transcript::push_system(to, &from, text);
    let envelope = crate::protocol::envelope(&from, text);
    submit_delivery(to, &envelope, true)?;
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
    let mut cfg = clone_agent_cfg(agent)?;
    cfg.routines.push(Routine::new(name, schedule, prompt)?);
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
    fire_routine(agent, &name, &prompt)?;
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
            preview: crate::transcript::channel_preview(&c.id),
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
    let envelope = crate::protocol::channel_envelope(&ch.id, &from, text);
    let targets: Vec<String> = if from == "user" {
        ch.members.clone()
    } else {
        ch.members.iter().filter(|m| *m != &from).cloned().collect()
    };
    if targets.is_empty() {
        return Ok(());
    }
    let mut sent = 0usize;
    let mut last_err: Option<anyhow::Error> = None;
    for to in &targets {
        if ensure_accepts_turn(to).is_err() {
            continue;
        }
        crate::transcript::push_system(to, &format!("#{channel}"), text);
        match submit_delivery(to, &envelope, true) {
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

#[cfg(test)]
mod inbox_tests {
    use super::*;

    #[test]
    fn inbox_is_fifo() {
        let id = "test-inbox-fifo";
        clear_inbox(id);
        enqueue_delivery(id, "a", true).unwrap();
        enqueue_delivery(id, "b", true).unwrap();
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
            enqueue_delivery(id, &i.to_string(), true).unwrap();
        }
        let err = enqueue_delivery(id, "overflow", true).unwrap_err();
        assert!(err.to_string().contains("inbox full"), "{err}");
        clear_inbox(id);
    }
}
