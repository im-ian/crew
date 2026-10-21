use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use anyhow::Context;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{broadcast, oneshot};

use crate::config::{
    empty_to_none, find_routine_index, parse_hex_color, roster_update_text, write_roster,
    AgentCli, AgentConfig, AvatarShape, Config, Effort, Routine,
};
use crate::cron;
use crate::headless::{self, HeadlessSession};
use crate::paths;
use crate::protocol::{AgentInfo, AgentStatus, ChatMessage, Event, Request, Role};
use crate::pty_agent::{self, PtySession};
use crate::targeting::{self, TurnOrigin};

const DEFAULT_COLS: u16 = 100;
const DEFAULT_ROWS: u16 = 32;
const MAX_INBOX: usize = 32;
const MAX_PENDING_HANDOFFS: usize = 3;

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
static INBOX: OnceLock<Mutex<HashMap<String, VecDeque<PendingDelivery>>>> = OnceLock::new();
static ORIGINS: OnceLock<Mutex<HashMap<String, TurnOrigin>>> = OnceLock::new();
static PENDING_HANDOFFS: OnceLock<Mutex<HashMap<String, Vec<PendingHandoff>>>> = OnceLock::new();
/// Jobs that wait on a bot's turn in progress, then run one at a time in order.
static SERIAL: OnceLock<Mutex<SerialBoard>> = OnceLock::new();

struct PendingDelivery {
    text: String,
    newline: bool,
    msg_id: Option<String>,
    origin: TurnOrigin,
    /// The rest of a chain, waiting on this delivery's turn. It goes on the
    /// bot when the delivery starts: until then a stop or a newer message for
    /// that bot is about the work ahead of it, not this.
    then: VecDeque<SerialJob>,
}

struct PendingHandoff {
    from: String,
    text: String,
}

fn clear_agent_context(id: &str) {
    if let Ok(mut map) = pending_handoffs().lock() {
        map.remove(id);
    }
    clear_serial_after(id);
}

fn pending_handoffs() -> &'static Mutex<HashMap<String, Vec<PendingHandoff>>> {
    PENDING_HANDOFFS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn enqueue_handoff(peer: &str, from: &str, text: &str) {
    let text = crate::protocol::clip_chars(text.trim(), crate::protocol::HANDOFF_CLIP);
    if text.is_empty() || peer == from {
        return;
    }
    if let Ok(mut map) = pending_handoffs().lock() {
        let q = map.entry(peer.to_string()).or_default();
        q.retain(|h| h.from != from);
        q.push(PendingHandoff {
            from: from.to_string(),
            text,
        });
    }
}

/// `enqueue_handoff` keeps one entry per sender, so this is all of them.
fn take_handoff_from(peer: &str, from: &str) -> Option<PendingHandoff> {
    let mut map = pending_handoffs().lock().ok()?;
    let q = map.get_mut(peer)?;
    let at = q.iter().position(|h| h.from == from)?;
    let item = q.remove(at);
    if q.is_empty() {
        map.remove(peer);
    }
    Some(item)
}

fn take_handoffs(agent: &str) -> Vec<PendingHandoff> {
    let mut map = match pending_handoffs().lock() {
        Ok(m) => m,
        Err(_) => return Vec::new(),
    };
    map.remove(agent).unwrap_or_default()
}

fn restore_handoffs(agent: &str, mut items: Vec<PendingHandoff>) {
    if items.is_empty() {
        return;
    }
    if let Ok(mut map) = pending_handoffs().lock() {
        let q = map.entry(agent.to_string()).or_default();
        // A peer that sealed a new reply while the delivery was in flight
        // already replaced its entry. Keeping both would put the superseded
        // text first and spend one of the three kept slots on it.
        items.retain(|old| !q.iter().any(|new| new.from == old.from));
        items.append(q);
        *q = items;
    }
}

fn flush_handoffs(agent: &str, prompt: &str) -> String {
    let items = take_handoffs(agent);
    if items.is_empty() {
        return prompt.to_string();
    }
    crate::protocol::attach_after_marker(prompt, &render_handoffs(&items))
}

fn render_handoffs(items: &[PendingHandoff]) -> String {
    let omitted = items.len().saturating_sub(MAX_PENDING_HANDOFFS);
    let keep = if items.len() > MAX_PENDING_HANDOFFS {
        &items[items.len() - MAX_PENDING_HANDOFFS..]
    } else {
        items
    };
    let mut out = String::new();
    if omitted > 0 {
        let noun = if omitted == 1 { "reply" } else { "replies" };
        out.push_str(&crate::protocol::system_envelope(&format!(
            "{omitted} earlier {noun} omitted"
        )));
        if !out.ends_with('\n') {
            out.push('\n');
        }
    }
    for h in keep {
        out.push_str(&crate::protocol::handoff_envelope(&h.from, &h.text));
        if !out.ends_with('\n') {
            out.push('\n');
        }
    }
    out
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
    then: &mut VecDeque<SerialJob>,
) -> anyhow::Result<()> {
    let mut map = inbox().lock().expect("inbox mutex");
    let q = map.entry(id.to_string()).or_default();
    if q.len() >= MAX_INBOX {
        anyhow::bail!("agent {id} is busy (inbox full)");
    }
    // Marked before anyone can pop it. A turn that ends right after the push
    // starts it and clears the mark, and a mark set after that stayed up.
    if let Some(mid) = msg_id.as_deref() {
        crate::transcript::set_queued(id, mid, true);
    }
    q.push_back(PendingDelivery {
        text: text.to_string(),
        newline,
        msg_id,
        origin,
        then: std::mem::take(then),
    });
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
    let live = map.get(id).with_context(|| format!("unknown agent {id}"))?;
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
    // A stop ends the chain. The members still waiting must not answer it, and
    // the bot that asked is not woken with what was said before the stop.
    clear_serial_after(id);
    take_wake(id);
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
    let closed = crate::transcript::close_pending_choices(id);
    fail_asks(&closed, "interrupted");
    crate::transcript::drop_pending_approval(id);
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
    set_live_status(id, AgentStatus::Idle);
    if allow {
        let origin = get_origin(id).unwrap_or_else(TurnOrigin::user);
        if let Err(err) = submit_delivery(
            id,
            "User allowed this action. Continue.",
            true,
            None,
            origin,
        ) {
            pump_inbox(id);
            return Err(err);
        }
    } else {
        pump_inbox(id);
    }
    Ok(())
}

fn ask_waiters() -> &'static Mutex<HashMap<String, oneshot::Sender<Event>>> {
    static WAITERS: OnceLock<Mutex<HashMap<String, oneshot::Sender<Event>>>> = OnceLock::new();
    WAITERS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn fail_asks(ids: &[String], message: &str) {
    let mut map = match ask_waiters().lock() {
        Ok(m) => m,
        Err(_) => return,
    };
    for id in ids {
        if let Some(tx) = map.remove(id) {
            let _ = tx.send(Event::Error {
                message: message.to_string(),
            });
        }
    }
}

fn take_ask(choice_id: &str) -> Option<oneshot::Sender<Event>> {
    ask_waiters().lock().ok()?.remove(choice_id)
}

fn drop_ask(choice_id: &str) {
    let _ = ask_waiters().lock().ok().map(|mut m| m.remove(choice_id));
}

fn start_ask(
    agent: &str,
    question: &str,
    options: Vec<String>,
    inputs: Vec<String>,
    hint: Option<String>,
) -> anyhow::Result<(String, oneshot::Receiver<Event>)> {
    if !known_agent(agent) {
        anyhow::bail!("unknown agent {agent}");
    }
    let card = crate::choice::card_from_cli(question, &options, &inputs, hint.as_deref())?;
    let msg = crate::transcript::attach_choice(agent, None, card);
    let Some(choice) = msg.choice.clone() else {
        anyhow::bail!("failed to open choice");
    };
    let (tx, rx) = oneshot::channel();
    let id = choice.id.clone();
    ask_waiters()
        .lock()
        .expect("ask waiters")
        .insert(id.clone(), tx);
    Ok((id, rx))
}

fn answer_choice(
    agent: &str,
    message_id: &str,
    answers: Vec<Vec<String>>,
    values: Vec<Vec<String>>,
    closed: bool,
) -> anyhow::Result<()> {
    let Some(msg) = crate::transcript::choice_by_message(agent, message_id) else {
        anyhow::bail!("no choice on that message");
    };
    let Some(card) = msg.choice.as_ref() else {
        anyhow::bail!("no choice on that message");
    };
    if card.state != crate::protocol::ChoiceState::Pending {
        anyhow::bail!("choice already resolved");
    }
    if !closed {
        let mut preview = card.clone();
        crate::choice::apply_answers(&mut preview, &answers, &values, false);
        if !crate::choice::is_complete(&preview) {
            if preview.questions.iter().any(|q| {
                q.fields
                    .iter()
                    .any(|f| f.required && f.value.trim().is_empty())
            }) {
                anyhow::bail!("missing input");
            }
            anyhow::bail!("nothing selected");
        }
    }
    let Some(updated) =
        crate::transcript::resolve_choice(agent, &card.id, &answers, &values, closed)
    else {
        anyhow::bail!("choice not found");
    };
    if let Some(tx) = take_ask(&updated.id) {
        let text = crate::choice::format_answer(&updated);
        let ev = if closed {
            Event::Error {
                message: "choice closed".into(),
            }
        } else {
            Event::Answered { text: text.clone() }
        };
        if tx.send(ev).is_ok() {
            return Ok(());
        }
        if closed {
            return Ok(());
        }
        return send_agent_shown(agent, &crate::choice::format_answer_masked(&updated), &text);
    }
    if closed {
        return Ok(());
    }
    let text = crate::choice::format_answer(&updated);
    if text.trim().is_empty() {
        anyhow::bail!("nothing selected");
    }
    // The picker is for the human. Continue only the bot that asked.
    send_agent_shown(agent, &crate::choice::format_answer_masked(&updated), &text)
}

/// `/compact`, `/context`: a CLI command, which reads as one only when the
/// prompt starts with it. A path is not one.
fn is_slash_command(text: &str) -> bool {
    text.strip_prefix('/')
        .and_then(|rest| rest.split(char::is_whitespace).next())
        .is_some_and(|name| !name.is_empty() && !name.contains('/'))
}

/// `then` goes on the bot with the turn, and stays with the caller when the
/// turn does not start.
fn start_delivery(
    start: Starting,
    text: &str,
    newline: bool,
    origin: TurnOrigin,
    then: &mut VecDeque<SerialJob>,
) -> anyhow::Result<()> {
    let id = start.0.clone();
    let id = id.as_str();
    // Teammates' replies in front of a command turn it into words. They wait
    // for the next prompt instead.
    let pending = if is_slash_command(text) {
        Vec::new()
    } else {
        take_handoffs(id)
    };
    let text = if pending.is_empty() {
        text.to_string()
    } else {
        crate::protocol::attach_after_marker(text, &render_handoffs(&pending))
    };
    let prev_peer = crate::transcript::set_peer(id, asked_by(&origin, id));
    let prev_origin = get_origin(id);
    set_origin(id, origin);
    let started = deliver(id, &text, newline);
    match &started {
        Ok(()) => queue_serial_after(id, std::mem::take(then)),
        Err(_) => {
            restore_handoffs(id, pending);
            crate::transcript::cancel_expect(id);
            // A busy agent is still in the turn these belong to.
            crate::transcript::set_peer(id, prev_peer);
            match prev_origin {
                Some(prev) => set_origin(id, prev),
                None => {
                    take_origin(id);
                }
            }
        }
    }
    drop(start);
    if started.is_ok() {
        crate::transcript::drop_pending_approval(id);
    }
    // Over already, or never begun: what waits here goes on, and a message
    // that queued while this start held the bot begins.
    if !agent_busy(id).unwrap_or(true) {
        pump_inbox(id);
    }
    started
}

fn submit_delivery(
    id: &str,
    text: &str,
    newline: bool,
    msg_id: Option<String>,
    origin: TurnOrigin,
) -> anyhow::Result<()> {
    submit_delivery_then(id, text, newline, msg_id, origin, &mut VecDeque::new())
}

/// `then` is the rest of a chain waiting on this delivery's turn. It is taken
/// when the delivery starts or queues, and left with the caller when it fails.
fn submit_delivery_then(
    id: &str,
    text: &str,
    newline: bool,
    msg_id: Option<String>,
    origin: TurnOrigin,
    then: &mut VecDeque<SerialJob>,
) -> anyhow::Result<()> {
    if targeting::relay_exhausted(&origin) {
        note_relay_stop(id, &origin);
        anyhow::bail!(
            "relay limit reached after {} bot-to-bot hops; waiting for the user",
            targeting::MAX_RELAY_HOPS
        );
    }
    if !agent_busy(id)? {
        if let Some(start) = claim_start(id) {
            match start_delivery(start, text, newline, origin.clone(), then) {
                Err(err) if is_busy_err(&err) => {}
                started => return started,
            }
        }
    }
    enqueue_delivery(id, text, newline, msg_id, origin, then)?;
    // The turn that was in the way, or a start under way, can finish before
    // the push and find nothing to start. Nothing else would start this one.
    pump_inbox_inner(id);
    Ok(())
}

/// Say once, where the user is looking, that a bot-to-bot chain was cut short.
fn note_relay_stop(id: &str, origin: &TurnOrigin) {
    let line = if crate::paths::locale() == "en" {
        "Bots kept handing this back and forth, so it stopped here. Say something to pick it up."
    } else {
        "봇끼리 계속 주고받아서 여기서 멈췄습니다. 말을 걸면 다시 이어집니다."
    };
    crate::transcript::push_system(id, "crew", line, None);
}

/// `id`'s turn is over: what waited on that turn goes on, and the next message
/// for `id` starts. Neither waits on the other.
pub(crate) fn pump_inbox(id: &str) {
    advance_serial(id);
    pump_inbox_inner(id);
}

fn pump_inbox_inner(id: &str) {
    match agent_busy(id) {
        Ok(false) => {}
        _ => return,
    }
    // Claimed before the pop, so two pumps cannot start this bot's queue out
    // of order.
    let Some(start) = claim_start(id) else {
        return;
    };
    let next = {
        let mut map = match inbox().lock() {
            Ok(m) => m,
            Err(_) => return,
        };
        map.get_mut(id).and_then(|q| q.pop_front())
    };
    let Some(mut item) = next else {
        return;
    };
    match start_delivery(
        start,
        &item.text,
        item.newline,
        item.origin.clone(),
        &mut item.then,
    ) {
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
            // The rest of its chain goes on without this bot.
            run_chain(item.then);
            pump_inbox_inner(id);
        }
    }
}

#[cfg(test)]
fn inbox_is_empty(id: &str) -> bool {
    inbox()
        .lock()
        .ok()
        .map(|m| m.get(id).map(|q| q.is_empty()).unwrap_or(true))
        .unwrap_or(true)
}

#[derive(Clone, Debug)]
struct SerialJob {
    to: String,
    kind: SerialKind,
}

#[derive(Clone, Debug)]
enum SerialKind {
    Tell {
        from: String,
        text: String,
        origin: Option<TurnOrigin>,
    },
}

impl SerialJob {
    /// A teammate the user @named in `chat`'s own 1:1.
    fn named_in(&self, chat: &str) -> bool {
        let SerialKind::Tell { from, origin, .. } = &self.kind;
        from == "user" && origin.as_ref().and_then(|o| o.reply_agent.as_deref()) == Some(chat)
    }
}

struct SerialBoard {
    /// What waits on each bot's turn in progress: the teammates its message
    /// named, the tells it ran, and the rest of a chain it is part of.
    queues: HashMap<String, VecDeque<SerialJob>>,
    /// Bots whose next turn is being started. One start at a time per bot: only
    /// the one under way sets the turn's origin and peer, and what waits on the
    /// bot stays put until that turn is up.
    starting: HashSet<String>,
    /// Bumped when an agent's chain is cleared. A tell that observed an older
    /// value belongs to a turn that was stopped.
    epoch: HashMap<String, u64>,
}

fn serial_board() -> &'static Mutex<SerialBoard> {
    SERIAL.get_or_init(|| {
        Mutex::new(SerialBoard {
            queues: HashMap::new(),
            starting: HashSet::new(),
            epoch: HashMap::new(),
        })
    })
}

/// A turn being started on the bot it names. Dropping it lets the next start in.
struct Starting(String);

impl Drop for Starting {
    fn drop(&mut self) {
        if let Ok(mut board) = serial_board().lock() {
            board.starting.remove(&self.0);
        }
    }
}

/// None while another start is under way on `agent`.
fn claim_start(agent: &str) -> Option<Starting> {
    let mut board = serial_board().lock().ok()?;
    board
        .starting
        .insert(agent.to_string())
        .then(|| Starting(agent.to_string()))
}

fn serial_epoch(agent: &str) -> u64 {
    serial_board()
        .lock()
        .ok()
        .and_then(|board| board.epoch.get(agent).copied())
        .unwrap_or(0)
}

fn queue_serial_after(agent: &str, mut jobs: VecDeque<SerialJob>) {
    if agent.is_empty() || jobs.is_empty() {
        return;
    }
    if let Ok(mut board) = serial_board().lock() {
        // This message stays contiguous, ahead of work already waiting here.
        let q = board.queues.entry(agent.to_string()).or_default();
        jobs.append(q);
        *q = jobs;
    }
}

/// A stop: nothing waiting on this turn answers it.
fn clear_serial_after(agent: &str) {
    if let Ok(mut board) = serial_board().lock() {
        board.queues.remove(agent);
        let epoch = board.epoch.entry(agent.to_string()).or_insert(0);
        *epoch = epoch.wrapping_add(1);
    }
}

/// A newer message from the user drops the teammates their last one named
/// that have not started. The tells the bot ran itself, and another chat's
/// chain running on through this bot, are not that message's to drop.
fn drop_mention_followers(agent: &str) {
    if let Ok(mut board) = serial_board().lock() {
        if let Some(q) = board.queues.get_mut(agent) {
            q.retain(|job| !job.named_in(agent));
        }
    }
}

/// A tell from a bot that is still answering. If `to` is already in that bot's
/// chain, keep the single slot (and use this text). Otherwise append it.
/// Returns false when `epoch` is stale, so a stop that already cleared the
/// chain does not put the tell back.
fn defer_tell_if_epoch(
    anchor: &str,
    epoch: u64,
    to: &str,
    from: &str,
    text: &str,
    origin: Option<TurnOrigin>,
) -> bool {
    let Ok(mut board) = serial_board().lock() else {
        return false;
    };
    if board.epoch.get(anchor).copied().unwrap_or(0) != epoch {
        return false;
    }
    if let Some(q) = board.queues.get_mut(anchor) {
        for job in q.iter_mut() {
            if job.to != to {
                continue;
            }
            if let SerialKind::Tell {
                from: slot_from,
                text: slot_text,
                origin: slot_origin,
            } = &mut job.kind
            {
                *slot_from = from.to_string();
                *slot_text = text.to_string();
                *slot_origin = origin;
            }
            return true;
        }
    }
    board
        .queues
        .entry(anchor.to_string())
        .or_default()
        .push_back(SerialJob {
            to: to.to_string(),
            kind: SerialKind::Tell {
                from: from.to_string(),
                text: text.to_string(),
                origin,
            },
        });
    true
}

fn tells_after(anchor: &str, to: &str) -> bool {
    serial_board()
        .lock()
        .ok()
        .and_then(|board| {
            board
                .queues
                .get(anchor)
                .map(|q| q.iter().any(|j| j.to == to))
        })
        .unwrap_or(false)
}

fn defer_tell(anchor: &str, to: &str, from: &str, text: &str, origin: Option<TurnOrigin>) {
    let epoch = serial_epoch(anchor);
    let _ = defer_tell_if_epoch(anchor, epoch, to, from, text, origin);
}

/// What waits on `agent`'s turn, unless a turn is still being started there.
fn take_followers(agent: &str) -> VecDeque<SerialJob> {
    let Ok(mut board) = serial_board().lock() else {
        return VecDeque::new();
    };
    if board.starting.contains(agent) {
        return VecDeque::new();
    }
    board.queues.remove(agent).unwrap_or_default()
}

/// `start`'s turn is over: what waited on it goes on, one at a time.
fn advance_serial(start: &str) {
    if matches!(
        live_status(start),
        Ok(AgentStatus::Working | AgentStatus::Blocked)
    ) {
        return;
    }
    run_chain(take_followers(start));
}

/// Deliver the head. The rest rides with that delivery and goes on when its
/// turn ends, so the chain stays A, then B, then C. A head that cannot be
/// delivered is skipped.
fn run_chain(mut chain: VecDeque<SerialJob>) {
    while let Some(job) = chain.pop_front() {
        let SerialKind::Tell { from, text, origin } = &job.kind;
        match tell_agent_origin(from, &job.to, text, origin.clone(), false, &mut chain) {
            Ok(()) => return,
            Err(err) => eprintln!("[crew] serial -> {}: {err:#}", job.to),
        }
    }
}

fn roster_vec() -> Vec<AgentConfig> {
    let cfgs = configs().lock().expect("configs mutex");
    let mut v: Vec<AgentConfig> = cfgs.values().cloned().collect();
    v.sort_by(|a, b| a.id.cmp(&b.id));
    v
}

fn save_state() -> anyhow::Result<()> {
    let agents = roster_vec();
    Config {
        agents: agents.clone(),
    }
    .save()?;
    let _ = write_roster(&agents);
    Ok(())
}

fn snapshot_event() -> Event {
    Event::Agents {
        agents: list_agents(),
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
    let Event::Frame { agent, status, .. } = ev else {
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
    // A bot waiting on this turn is woken with the reply and finishes in its
    // own chat. Without that wake, this finish is the user's only notice.
    let waited = get_origin(agent)
        .and_then(|o| owed_wake(&o, agent))
        .is_some_and(|(asker, wake)| known_agent(&asker) && !targeting::relay_exhausted(&wake));
    let interrupted = agent_interrupted(agent);
    crate::notify::maybe_status_notify(agent, &name, prev, *status, interrupted || waited);
}

/// The bot that asked for this turn, when the reply is copied into its chat.
/// The turn is that chat's news, not this one's.
fn asked_by(origin: &TurnOrigin, agent: &str) -> Option<String> {
    targeting::postback_targets(origin, agent).agent
}

/// The wake `id`'s turn still owes: the bot that ran `crew tell` and is
/// waiting, and the origin the reply reaches it with. The wake is a hop.
fn owed_wake(origin: &TurnOrigin, id: &str) -> Option<(String, TurnOrigin)> {
    if origin.wake_spent {
        return None;
    }
    let asker = targeting::waiting_asker(origin, id)?;
    let wake = TurnOrigin {
        from: id.to_string(),
        hops: origin.hops + 1,
        ..TurnOrigin::default()
    };
    Some((asker, wake))
}

/// Use up the wake `id`'s turn owes, and say what it was.
fn take_wake(id: &str) -> Option<(String, TurnOrigin)> {
    let mut map = origins().lock().ok()?;
    let origin = map.get_mut(id)?;
    let owed = owed_wake(origin, id);
    origin.wake_spent = true;
    owed
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
            tool: m.kind == Some(crate::protocol::MessageKind::Tool),
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

/// Boot reads back what every configured bot already owns on disk. Creating a
/// bot drops that id's transcript first, so a freed id cannot open onto the
/// old conversation.
fn restore_transcripts(cfg: &Config) {
    for agent_cfg in &cfg.agents {
        crate::transcript::load_agent(&agent_cfg.id);
    }
}

/// Two readings in a row before acting, because one `stat` can fail for
/// reasons that are not a theft and what follows is ending the process.
/// Returns whether it is time to go.
fn note_loss(strikes: &mut u8, lost: bool) -> bool {
    *strikes = if lost { strikes.saturating_add(1) } else { 0 };
    *strikes >= 2
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
        }
    }
    restore_transcripts(&cfg);
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
    let _ = write_roster(&cfg.agents);

    let listener = UnixListener::bind(paths::socket_path())
        .with_context(|| format!("bind {}", paths::socket_path().display()))?;
    // Immediately, before anything else can run: a theft landing between the
    // bind and this read would record the thief's socket as ours and leave the
    // check below comparing it against itself forever. And one statement after
    // a successful bind there is only one way to find nothing there — somebody
    // has already unlinked it — so that is not a reason to stop looking, it is
    // the answer.
    let bound = match paths::socket_identity() {
        Some(bound) => bound,
        None => anyhow::bail!(
            "{} was taken before this daemon could claim it",
            paths::socket_path().display()
        ),
    };
    paths::write_pid(std::process::id())?;
    paths::write_daemon_version(env!("CARGO_PKG_VERSION"))?;
    eprintln!(
        "[crew] daemon listening on {}",
        paths::socket_path().display()
    );

    let (shutdown_tx, mut shutdown_rx) = tokio::sync::watch::channel(false);
    spawn_status_ticker();
    spawn_transcript_ticker();
    spawn_routine_ticker();

    // Another daemon can unlink this socket and bind its own at the same path
    // (issue #25). The daemon that was unlinked has no other way to find out:
    // its listener still works, nothing ever connects, and it would sit here
    // for the life of the machine with its tickers flushing the transcripts
    // the reachable daemon now owns.
    let mut still_ours = tokio::time::interval(Duration::from_secs(1));
    // Ticks missed while this loop was busy are not evidence; without this
    // they arrive back to back and the two readings below become one.
    still_ours.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut strikes = 0u8;
    loop {
        tokio::select! {
            _ = still_ours.tick() => {
                let now = paths::socket_identity();
                if note_loss(&mut strikes, now != Some(bound)) {
                    eprintln!(
                        "[crew] {} {}; this daemon is unreachable. exiting",
                        paths::socket_path().display(),
                        if now.is_none() { "is gone" } else { "is a different socket now" }
                    );
                    // Reap what is in flight first. `interrupt` bumps the
                    // turn's generation, so `run_turn` returns at its
                    // staleness check — before the arm that calls
                    // `clear_session` on the ids this exit exists to leave
                    // alone. Without it the turn's CLI child outlives us and
                    // keeps writing the session the reachable daemon resumes.
                    let live: Vec<LiveAgent> = match agents().lock() {
                        Ok(map) => map.values().cloned().collect(),
                        Err(_) => Vec::new(),
                    };
                    for agent in live {
                        if let LiveAgent::Headless(session) = agent {
                            headless::interrupt(&session);
                        }
                    }
                    // Then only exit. The socket, pid and version name whoever
                    // has the path now, and `shutdown_agents` would unlink
                    // `cli-sessions/<id>`. The pty children end with us.
                    std::process::exit(1);
                }
            }
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
                    let idle = session
                        .inner
                        .lock()
                        .map(|inner| {
                            matches!(inner.status, AgentStatus::Idle | AgentStatus::Exited)
                        })
                        .unwrap_or(false);
                    let id = session.id.clone();
                    emit_frame(&session);
                    if idle {
                        // Before the chain moves on: the next turn replaces this origin.
                        turn_ended(&id);
                        pump_inbox(&id);
                    }
                }
            }
        })
        .expect("status ticker");
}

fn spawn_transcript_ticker() {
    std::thread::Builder::new()
        .name("crew-transcript".into())
        .spawn(|| loop {
            std::thread::sleep(Duration::from_millis(150));
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
    let mut due: Vec<(String, String, String, String)> = Vec::new();
    {
        let cfgs = match configs().lock() {
            Ok(c) => c,
            Err(_) => return,
        };
        for cfg in cfgs.values() {
            for r in &cfg.routines {
                if r.is_due(&now) {
                    due.push((
                        cfg.id.clone(),
                        r.id.clone(),
                        r.name.clone(),
                        r.prompt.clone(),
                    ));
                }
            }
        }
    }
    let key = now.minute_key();
    for (target, rid, name, prompt) in due {
        let exited = {
            let map = match agents().lock() {
                Ok(m) => m,
                Err(_) => return,
            };
            match map.get(&target) {
                Some(live) => live.status() == AgentStatus::Exited,
                None => continue,
            }
        };
        // The minute is spent either way. Marking only on success let the 15s ticker
        // retry a failing routine four times inside the same minute.
        if let Err(err) = mark_routine_run(&target, &rid, &key) {
            eprintln!("[crew] routine last_run {target}/{name}: {err:#}");
        }
        let fired = if exited {
            Err(anyhow::anyhow!("agent {target} has exited"))
        } else {
            fire_routine(&target, &name, &prompt)
        };
        match fired {
            Ok(()) => {
                let _ = crate::routine_log::record(&target, &rid, true, "ok");
            }
            Err(err) => {
                let _ = crate::routine_log::record(&target, &rid, false, &err.to_string());
                crate::notify::routine_failed(&target, &name);
                eprintln!("[crew] routine {target}/{name}: {err:#}");
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

fn mark_routine_run(target: &str, key: &str, minute_key: &str) -> anyhow::Result<()> {
    let mut routines = read_routines(target)?;
    let idx = find_routine_index(&routines, key)
        .ok_or_else(|| anyhow::anyhow!("unknown routine {key}"))?;
    routines[idx].last_run = Some(minute_key.to_string());
    write_routines(target, routines)
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
                if let Request::Ask {
                    agent,
                    question,
                    options,
                    inputs,
                    hint,
                } = req
                {
                    match start_ask(&agent, &question, options, inputs, hint) {
                        Err(err) => {
                            write_event(
                                &mut write,
                                &Event::Error {
                                    message: err.to_string(),
                                },
                            )
                            .await?;
                        }
                        Ok((choice_id, rx)) => {
                            tokio::select! {
                                ev = rx => {
                                    let ev = ev.unwrap_or_else(|_| Event::Error {
                                        message: "ask cancelled".into(),
                                    });
                                    if write_event(&mut write, &ev).await.is_err() {
                                        if let Event::Answered { text } = ev {
                                            let _ = send_agent(&agent, &text);
                                        }
                                    }
                                }
                                _ = lines.next_line() => {
                                    drop_ask(&choice_id);
                                }
                            }
                        }
                    }
                    continue;
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
        Request::Ask { .. } => vec![Event::Error {
            message: "ask waits on the calling connection".into(),
        }],
        Request::AnswerChoice {
            agent,
            message_id,
            answers,
            values,
            closed,
        } => match answer_choice(&agent, &message_id, answers, values, closed) {
            Ok(()) => vec![Event::Ok],
            Err(err) => vec![Event::Error {
                message: err.to_string(),
            }],
        },
        Request::Search { query } => vec![Event::Search {
            hits: search_corpus(&query),
        }],
        Request::Tell { from, to, text } => match tell_agent(&from, &to, &text) {
            Ok(()) => vec![Event::Told {
                from: from_id(&from),
                to,
            }],
            Err(err) => vec![Event::Error {
                message: err.to_string(),
            }],
        },
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
        Request::SetCli { id, cli } => match set_cli(&id, &cli) {
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
            notify,
        } => match set_routine_enabled(&agent, &key, enabled) {
            Ok(moved) => {
                if let (true, Some(name)) = (notify, moved) {
                    note_routine_switch(&agent, &name, enabled);
                }
                vec![Event::Ok, snapshot_event()]
            }
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
    send_agent_shown(id, text, text)
}

fn send_agent_shown(id: &str, shown: &str, text: &str) -> anyhow::Result<()> {
    let proceed = apply_user_interrupt(id, text)?;
    if !proceed {
        crate::transcript::push_user(id, "user", shown);
        return Ok(());
    }
    ensure_accepts_turn(id)?;
    let roster = roster_vec();
    let msg = crate::transcript::push_user(id, "user", shown);
    // The teammates named here answer after this message's turn, so they ride
    // with it instead of waiting on whatever the bot is doing now.
    let mut named: VecDeque<SerialJob> =
        targeting::one_on_one_tell_targets(crate::rows::reply_body(text), id, &roster)
            .into_iter()
            .map(|to| SerialJob {
                to,
                kind: SerialKind::Tell {
                    from: "user".into(),
                    text: text.to_string(),
                    origin: Some(TurnOrigin::mention_tell(id)),
                },
            })
            .collect();
    let delivered = crate::config::with_mention_hint(text, id, &roster);
    drop_mention_followers(id);
    let started = submit_delivery_then(
        id,
        &delivered,
        true,
        Some(msg.id),
        TurnOrigin::user(),
        &mut named,
    );
    // Not delivered: the named teammates still answer, in order, instead of
    // the chain dying with this bot.
    run_chain(named);
    started
}

fn ensure_accepts_turn(id: &str) -> anyhow::Result<()> {
    let map = agents().lock().expect("agents mutex");
    let live = map.get(id).with_context(|| format!("unknown agent {id}"))?;
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
    tell_agent_origin(from, to, text, None, true, &mut VecDeque::new())
}

/// `then` is the rest of a chain that waits on this tell's turn.
fn tell_agent_origin(
    from: &str,
    to: &str,
    text: &str,
    origin: Option<TurnOrigin>,
    allow_defer: bool,
    then: &mut VecDeque<SerialJob>,
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
    if from != "user" && from != to {
        take_handoff_from(to, &from);
    }
    ensure_accepts_turn(to)?;
    // Hold this tell until the sender is idle so it does not overlap that turn.
    if allow_defer && from != "user" && from != to {
        let epoch = serial_epoch(&from);
        if agent_busy(&from).unwrap_or(false) {
            if defer_tell_if_epoch(&from, epoch, to, &from, text, origin.clone())
                && !matches!(
                    live_status(&from),
                    Ok(AgentStatus::Working | AgentStatus::Blocked)
                )
            {
                pump_inbox(&from);
            }
            return Ok(());
        }
        if agent_interrupted(&from) {
            return Ok(());
        }
    }
    let mention_owner = origin.as_ref().and_then(|o| {
        if o.from == "user" {
            o.reply_agent.clone()
        } else {
            None
        }
    });
    let envelope = crate::protocol::envelope(&from, text);
    let parsed = targeting::origin_from_envelope(&envelope);
    let parent = origin.or_else(|| get_origin(&from));
    let origin = targeting::inherit_origin(parent.as_ref(), parsed);
    let msg = crate::transcript::push_system(to, &from, text, asked_by(&origin, to));
    submit_delivery_then(to, &envelope, true, Some(msg.id), origin, then)?;
    if from != "user" && from != to {
        let known = agents()
            .lock()
            .ok()
            .map(|map| map.contains_key(&from))
            .unwrap_or(false);
        if known {
            // Sent from a turn another bot asked for, it is part of that exchange.
            let peer = parent.as_ref().and_then(|p| asked_by(p, &from));
            crate::transcript::push_notice(&from, &format!("to:{to}"), text, peer);
        }
    } else if let Some(owner) = mention_owner.as_deref() {
        if owner != to {
            let known = agents()
                .lock()
                .ok()
                .map(|map| map.contains_key(owner))
                .unwrap_or(false);
            if known {
                crate::transcript::push_notice(owner, &format!("to:{to}"), text, None);
            }
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
        LiveAgent::Pty(_) => {
            // Only a terminal types the prompt back. A headless CLI streams its
            // reply alone, and an echo armed there ate any reply that opened
            // like the prompt: "반가워" got back "워요.".
            crate::transcript::expect_echo(id, text);
            write_pty(id, text, newline)
        }
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

fn insert_spawned_agent(mut cfg: AgentConfig) -> anyhow::Result<()> {
    cfg.id = cfg.id.trim().to_string();
    if cfg.cmd.is_empty() {
        anyhow::bail!("cmd is empty");
    }
    // Minted ids are always in range; the CLI takes one verbatim. An id the
    // filesystem folds (`춘식이` and `죠르디` both become `___`) would share
    // one transcript, and one starting with `ch:` decodes as a room.
    if !crate::config::valid_agent_id(&cfg.id) {
        anyhow::bail!("{}", crate::config::id_rule(&cfg.id));
    }
    {
        let map = agents().lock().expect("agents mutex");
        if map.contains_key(&cfg.id) {
            anyhow::bail!("agent {} already exists", cfg.id);
        }
    }
    // An agent whose `open_agent` failed at startup is logged and skipped, so
    // it holds a config with no live session. It still owns its id and its
    // transcript, and the check above would not see it.
    if configs()
        .lock()
        .expect("configs mutex")
        .contains_key(&cfg.id)
    {
        anyhow::bail!("agent {} already exists", cfg.id);
    }
    if let Some(ref cwd) = cfg.cwd {
        paths::create_cwd(&paths::expand_tilde(cwd))?;
    }
    let id = cfg.id.clone();
    let mut roster = roster_vec();
    if !roster.iter().any(|a| a.id == cfg.id) {
        roster.push(cfg.clone());
    }
    // The id is new, so nothing on disk belongs to it. Clear both before
    // opening: `open_agent` resumes `cli-sessions/<id>` when it exists, which
    // would answer with a dead bot's context that the user cannot even see.
    crate::transcript::drop_agent(&id);
    crate::headless::clear_session(&id);
    crate::headless::clear_recap(&id);
    let live = open_agent(&cfg, DEFAULT_COLS, DEFAULT_ROWS, false, &roster)?;
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
    crate::headless::clear_session(id);
    crate::headless::clear_recap(id);
    clear_inbox(id);
    clear_agent_context(id);
    session.kill();
    // After the kill: an in-flight headless turn persists through
    // `push_tool`, which would write the file back moments after we unlink it.
    crate::transcript::drop_agent(id);
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

/// Moves a bot to another CLI in place: each turn builds its command and picks
/// its parser from the config. The old CLI's session cannot follow, so the
/// chat as it stands is saved for the new CLI's first turn.
fn set_cli(id: &str, cli: &str) -> anyhow::Result<()> {
    let cli = AgentCli::from_key(cli)?;
    let mut cfg = clone_agent_cfg(id)?;
    if AgentCli::from_cmd(&cfg.cmd) == Some(cli) {
        return Ok(());
    }
    let session = {
        let map = agents().lock().expect("agents mutex");
        match map.get(id) {
            Some(LiveAgent::Headless(session)) => session.clone(),
            Some(LiveAgent::Pty(_)) => anyhow::bail!("agent {id} runs its own command, not a CLI"),
            None => anyhow::bail!("unknown agent {id}"),
        }
    };
    // Forgotten before the config moves, so a failed save below leaves the old
    // CLI on a fresh session that reads the recap: still a working bot.
    // ponytail: a turn that starts between here and persist_config runs on the
    // old CLI and takes the recap; a per-agent config lock would close that.
    headless::forget_session(&session)?;
    headless::clear_recap(id);
    if let Some(recap) = crate::transcript::recap(id) {
        headless::save_recap(id, &recap)?;
    }
    cfg.cmd = cli.default_cmd();
    // Model names belong to the old CLI.
    cfg.model = None;
    persist_config(&cfg)?;
    emit_agent_frame(id);
    Ok(())
}

fn read_routines(agent: &str) -> anyhow::Result<Vec<Routine>> {
    Ok(clone_agent_cfg(agent)?.routines)
}

fn write_routines(agent: &str, routines: Vec<Routine>) -> anyhow::Result<()> {
    let mut cfg = clone_agent_cfg(agent)?;
    cfg.routines = routines;
    persist_config(&cfg)
}

fn clone_agent_cfg(id: &str) -> anyhow::Result<AgentConfig> {
    let cfgs = configs().lock().expect("configs mutex");
    cfgs.get(id)
        .cloned()
        .with_context(|| format!("unknown agent {id}"))
}

fn add_routine(target: &str, name: String, schedule: String, prompt: String) -> anyhow::Result<()> {
    let (name, schedule, prompt) =
        crate::nl_routine::resolve_routine_fields(name, schedule, prompt)?;
    let mut routines = read_routines(target)?;
    routines.push(Routine::new(name, schedule, prompt)?);
    write_routines(target, routines)
}

fn edit_routine(
    target: &str,
    key: &str,
    name: Option<String>,
    schedule: Option<String>,
    prompt: Option<String>,
) -> anyhow::Result<()> {
    let mut routines = read_routines(target)?;
    let idx = find_routine_index(&routines, key)
        .ok_or_else(|| anyhow::anyhow!("unknown routine {key}"))?;
    routines[idx].edit(name, schedule, prompt)?;
    write_routines(target, routines)
}

fn remove_routine(target: &str, key: &str) -> anyhow::Result<()> {
    let mut routines = read_routines(target)?;
    let idx = find_routine_index(&routines, key)
        .ok_or_else(|| anyhow::anyhow!("unknown routine {key}"))?;
    routines.remove(idx);
    write_routines(target, routines)
}

/// The routine's name when the switch actually moved.
fn set_routine_enabled(target: &str, key: &str, enabled: bool) -> anyhow::Result<Option<String>> {
    let mut routines = read_routines(target)?;
    let idx = find_routine_index(&routines, key)
        .ok_or_else(|| anyhow::anyhow!("unknown routine {key}"))?;
    if routines[idx].enabled == enabled {
        return Ok(None);
    }
    routines[idx].enabled = enabled;
    let name = routines[idx].name.clone();
    write_routines(target, routines)?;
    Ok(Some(name))
}

/// A switch flipped in the routine sheet happens outside the chat. Note it in
/// the thread and give the bot a turn to acknowledge it, so the conversation
/// knows what the sheet knows. The bot's own `crew routine pause` never comes
/// here: its reply already says so.
fn note_routine_switch(id: &str, name: &str, enabled: bool) {
    let line = match (crate::paths::locale() == "en", enabled) {
        (true, true) => format!("Turned on the “{name}” routine."),
        (true, false) => format!("Turned off the “{name}” routine."),
        (false, true) => format!("‘{name}’ 루틴을 켰습니다."),
        (false, false) => format!("‘{name}’ 루틴을 껐습니다."),
    };
    let msg = crate::transcript::push_system(id, "crew", &line, None);
    let note = crate::protocol::system_envelope(&format!(
        "The user turned {} your routine \"{name}\" in the routine sheet. Acknowledge it in one short sentence. Do not run crew routine.",
        if enabled { "on" } else { "off" }
    ));
    let started = ensure_accepts_turn(id)
        .and_then(|()| submit_delivery(id, &note, true, Some(msg.id), TurnOrigin::user()));
    if let Err(err) = started {
        eprintln!("[crew] routine switch note for {id}: {err:#}");
    }
}

fn run_routine(target: &str, key: &str) -> anyhow::Result<()> {
    let routines = read_routines(target)?;
    let idx = find_routine_index(&routines, key)
        .ok_or_else(|| anyhow::anyhow!("unknown routine {key}"))?;
    let r = &routines[idx];
    let name = r.name.clone();
    let prompt = r.prompt.clone();
    let rid = r.id.clone();
    match fire_routine(target, &name, &prompt) {
        Ok(()) => {
            let _ = crate::routine_log::record(target, &rid, true, "ok");
        }
        Err(err) => {
            let _ = crate::routine_log::record(target, &rid, false, &err.to_string());
            return Err(err);
        }
    }
    let minute_key = cron::now_local()
        .map(|t| t.minute_key())
        .unwrap_or_else(|_| paths::utc_timestamp());
    mark_routine_run(target, &rid, &minute_key)
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
    crate::headless::clear_recap(id);
    clear_inbox(id);
    clear_agent_context(id);
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

fn known_agent(id: &str) -> bool {
    configs()
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
    if text.is_empty() && msg.choice.is_none() {
        return;
    }
    let Some(origin) = get_origin(agent) else {
        return;
    };
    let targets = targeting::postback_targets(&origin, agent);
    if let Some(peer) = targets.agent {
        if known_agent(&peer) && !text.is_empty() && msg.choice.is_none() {
            crate::transcript::push_handoff(&peer, agent, &text);
            enqueue_handoff(&peer, agent, &text);
        }
    }
    // A reply the user cut off with a stop is not a question waiting on them.
    if crate::interrupt::looks_like_judgment_question(&text) && !agent_interrupted(agent) {
        crate::transcript::set_approval(agent, &msg.id, crate::protocol::ApprovalState::Pending);
        set_live_status(agent, AgentStatus::Blocked);
    }
}

/// `id`'s turn is over: wake the bot waiting on its answer, and stop tagging
/// the rows that come after with the bot that asked for the turn.
pub(crate) fn turn_ended(id: &str) {
    // A reply waiting on the user's approval is not the answer yet. The turn
    // goes on once they answer, and ends after that.
    if matches!(live_status(id), Ok(AgentStatus::Blocked)) {
        return;
    }
    wake_asker(id);
    crate::transcript::set_peer(id, None);
}

/// A bot that asked `id` with `crew tell` is waiting on the answer, so the
/// reply becomes that bot's next turn instead of sitting until the user talks
/// to it again. A user's @mention leaves the reply for the next prompt. Each
/// wake is a hop, so two bots cannot go on forever, and a turn wakes once, so
/// output it leaves behind cannot wake the asker again.
fn wake_asker(id: &str) {
    let Some((asker, wake)) = take_wake(id) else {
        return;
    };
    if !known_agent(&asker) {
        return;
    }
    // It also ran `crew tell` back. That tell drops this reply on arrival, so
    // it is the one turn the asker gets.
    if tells_after(id, &asker) {
        return;
    }
    let Some(reply) = take_handoff_from(&asker, id) else {
        return;
    };
    let text = crate::protocol::handoff_envelope(id, &reply.text);
    if submit_delivery(&asker, &text, true, None, wake).is_err() {
        restore_handoffs(&asker, vec![reply]);
    }
}

#[cfg(test)]
mod daemon_tests {
    use super::*;

    /// A per-test id. The agent and pending-handoff maps are process-wide,
    /// so two tests sharing a key drain each other's state under the
    /// parallel harness — which is how CI failed here.
    fn test_id(prefix: &str) -> String {
        format!(
            "{prefix}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        )
    }

    /// Boot reads a bot's transcript back. Creating a bot drops the file
    /// first, so this path must not.
    #[test]
    fn boot_keeps_the_messages_a_bot_already_has() {
        paths::testing::with_home("daemon-restore", || {
            let bot = test_id("bot");
            crate::transcript::push_user(&bot, "user", "어제 시킨 일");
            let bot_path = paths::transcript_path(&bot);
            assert!(bot_path.exists(), "should persist");

            let cfg = Config {
                agents: vec![AgentConfig::new(
                    bot.clone(),
                    bot.clone(),
                    vec!["cat".into()],
                    None,
                )],
            };
            restore_transcripts(&cfg);

            assert!(bot_path.exists(), "boot must not unlink a bot's transcript");
            assert_eq!(crate::transcript::messages(&bot).len(), 1);
            crate::transcript::drop_agent(&bot);
        });
    }

    /// A bot that moves CLI keeps its chat for the new one to read; the old
    /// CLI's session and model do not follow it.
    #[test]
    fn switching_cli_leaves_the_chat_for_the_new_one() {
        paths::testing::with_home("set-cli", || {
            let bot = test_id("cli");
            let mut cfg = AgentConfig::new(
                bot.clone(),
                bot.clone(),
                AgentCli::Claude.default_cmd(),
                Some("/tmp/crew-demo/set-cli".into()),
            );
            cfg.model = Some("opus".into());
            insert_spawned_agent(cfg).unwrap();
            crate::transcript::push_user(&bot, "user", "어제 시킨 일");
            let Some(LiveAgent::Headless(session)) = agents().lock().unwrap().get(&bot).cloned()
            else {
                panic!("claude runs headless");
            };
            session.inner.lock().unwrap().session_id = Some("claude-session".into());
            headless::save_session(&bot, "claude-session").unwrap();

            session.inner.lock().unwrap().status = AgentStatus::Working;
            assert!(set_cli(&bot, "codex").unwrap_err().to_string().contains("working"));
            assert_eq!(headless::load_session(&bot).as_deref(), Some("claude-session"));
            session.inner.lock().unwrap().status = AgentStatus::Idle;

            set_cli(&bot, "codex").unwrap();

            let cfg = clone_agent_cfg(&bot).unwrap();
            assert_eq!(AgentCli::from_cmd(&cfg.cmd), Some(AgentCli::Codex));
            assert_eq!(cfg.model, None);
            assert_eq!(headless::load_session(&bot), None);
            assert_eq!(session.inner.lock().unwrap().session_id, None);
            let recap = fs::read_to_string(paths::cli_recap_path(&bot)).unwrap();
            assert!(recap.contains("user: 어제 시킨 일"), "{recap}");

            remove_agent(&bot).unwrap();
            assert!(!paths::cli_recap_path(&bot).exists());
        });
    }

    #[test]
    fn one_reading_is_not_enough_to_leave() {
        let mut strikes = 0;
        assert!(!note_loss(&mut strikes, true), "one is a maybe");
        assert!(note_loss(&mut strikes, true), "two in a row is an answer");

        // A reading that finds it again clears what came before.
        let mut strikes = 0;
        assert!(!note_loss(&mut strikes, true));
        assert!(!note_loss(&mut strikes, false), "found it again");
        assert!(!note_loss(&mut strikes, true), "counting starts over");
        assert!(note_loss(&mut strikes, true));
    }

    /// The bot's own `crew routine pause` must stay quiet, or the bot would
    /// answer its own pause.
    #[test]
    fn only_a_switch_flipped_in_the_sheet_is_said_in_the_chat() {
        paths::testing::with_home("routine-switch", || {
            let bot = test_id("switch");
            let mut cfg = AgentConfig::new(bot.clone(), bot.clone(), vec!["cat".into()], None);
            cfg.routines
                .push(Routine::new("아침".into(), "0 8 * * *".into(), "브리핑".into()).unwrap());
            persist_config(&cfg).unwrap();
            let (shutdown, _) = tokio::sync::watch::channel(false);
            let flip = |enabled, notify| {
                let req = Request::SetRoutineEnabled {
                    agent: bot.clone(),
                    key: "아침".into(),
                    enabled,
                    notify,
                };
                let out = dispatch(req, &shutdown);
                assert!(matches!(out[0], Event::Ok), "{:?}", out[0].to_line());
            };
            let said = || -> Vec<String> {
                crate::transcript::messages(&bot)
                    .into_iter()
                    .filter(|m| m.from == "crew")
                    .map(|m| m.text)
                    .collect()
            };

            flip(false, false);
            assert!(said().is_empty(), "a CLI pause says nothing");
            flip(true, true);
            flip(true, true); // already on, so nothing moved
            assert_eq!(said(), ["‘아침’ 루틴을 켰습니다."]);

            configs().lock().unwrap().remove(&bot);
            crate::transcript::drop_agent(&bot);
        });
    }

    #[test]
    fn routines_on_an_unknown_host_are_an_error() {
        assert!(read_routines("definitely-missing-bot").is_err());
    }

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
        enqueue_delivery(
            id,
            "a",
            true,
            None,
            TurnOrigin::user(),
            &mut VecDeque::new(),
        )
        .unwrap();
        enqueue_delivery(
            id,
            "b",
            true,
            None,
            TurnOrigin::user(),
            &mut VecDeque::new(),
        )
        .unwrap();
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
            enqueue_delivery(
                id,
                &i.to_string(),
                true,
                None,
                TurnOrigin::user(),
                &mut VecDeque::new(),
            )
            .unwrap();
        }
        let err = enqueue_delivery(
            id,
            "overflow",
            true,
            None,
            TurnOrigin::user(),
            &mut VecDeque::new(),
        )
        .unwrap_err();
        assert!(err.to_string().contains("inbox full"), "{err}");
        clear_inbox(id);
    }

    #[test]
    fn sealed_reply_handoff_to_origin_agent() {
        let peer = test_id("alpha");
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
            peer: None,
            kind: None,
            approval: None,
            choice: None,
        };
        on_assistant_sealed(&speaker, &reply);
        let msgs = crate::transcript::messages(&peer);
        let last = msgs.last().expect("handoff");
        assert_eq!(last.from, speaker);
        assert_eq!(last.kind, Some(crate::protocol::MessageKind::Handoff));
        assert_eq!(last.text, "reviewed");
        let next = flush_handoffs(&peer, "please continue");
        assert!(next.starts_with("[crew handoff from:"), "{next}");
        assert!(next.contains("reviewed"), "{next}");
        assert!(next.contains("please continue"), "{next}");
        assert_eq!(flush_handoffs(&peer, "please continue"), "please continue");
        crate::transcript::drop_agent(&peer);
        configs().lock().unwrap().remove(&peer);
        clear_agent_context(&peer);
    }

    #[test]
    fn an_id_the_filesystem_would_fold_is_refused_by_add() {
        let cfg = crate::config::AgentConfig::new(
            "춘식이".into(),
            "춘식이".into(),
            vec!["cat".into()],
            Some("/tmp/crew-demo/fold".into()),
        );
        let err = insert_spawned_agent(cfg).unwrap_err().to_string();
        assert!(err.contains("must be 1-64 of a-z"), "{err}");
        // macOS folds case, so an uppercase id is a second agent on one file.
        let up = crate::config::AgentConfig::new(
            "Grok".into(),
            "Grok".into(),
            vec!["cat".into()],
            Some("/tmp/crew-demo/fold".into()),
        );
        let err = insert_spawned_agent(up).unwrap_err().to_string();
        assert!(err.contains("must be 1-64 of a-z"), "{err}");
        let ch = crate::config::AgentConfig::new(
            "ch:general".into(),
            "room".into(),
            vec!["cat".into()],
            Some("/tmp/crew-demo/fold".into()),
        );
        let err = insert_spawned_agent(ch).unwrap_err().to_string();
        assert!(err.contains("must be 1-64 of a-z"), "{err}");
    }

    /// 춘식이 ran `crew tell 빵셔틀`, 빵셔틀 answered "보", and 춘식이 sat
    /// there until the user spoke again.
    #[test]
    fn a_bot_that_asked_gets_the_answer_as_a_turn() {
        paths::testing::with_home("wake-asker", || {
            let asker = test_id("asker");
            let speaker = format!("rival-{asker}");
            insert_spawned_agent(AgentConfig::new(
                asker.clone(),
                asker.clone(),
                AgentCli::Claude.default_cmd(),
                None,
            ))
            .unwrap();
            let Some(LiveAgent::Headless(session)) = agents().lock().unwrap().get(&asker).cloned()
            else {
                panic!("claude runs headless");
            };
            // Busy, so the wake waits in the inbox instead of starting a CLI.
            session.inner.lock().unwrap().status = AgentStatus::Working;
            enqueue_handoff(&asker, &speaker, "보");

            set_origin(&speaker, TurnOrigin::mention_tell(&asker));
            wake_asker(&speaker);
            assert!(
                inbox_is_empty(&asker),
                "the user's @mention does not wake the bot"
            );

            let asked = TurnOrigin {
                from: asker.clone(),
                ..TurnOrigin::default()
            };
            let turn = targeting::inherit_origin(Some(&TurnOrigin::user()), asked);
            set_origin(&speaker, turn.clone());
            // 빵셔틀 answered and also ran `crew tell` back with "보".
            defer_tell(&speaker, &asker, &speaker, "보", None);
            wake_asker(&speaker);
            assert!(inbox_is_empty(&asker), "its own tell is the one turn");
            clear_serial_after(&speaker);

            set_origin(&speaker, turn);
            wake_asker(&speaker);
            let item = inbox()
                .lock()
                .unwrap()
                .get_mut(&asker)
                .and_then(|q| q.pop_front())
                .expect("the asker is woken");
            assert_eq!(item.text, format!("[crew handoff from:{speaker}]\n보"));
            assert_eq!(item.origin.from, speaker);
            assert_eq!(item.origin.reply_agent, None);
            assert_eq!(item.origin.hops, 2);
            assert!(
                take_handoffs(&asker).is_empty(),
                "not again on the next prompt"
            );
            // A terminal printing after its turn ended is not another answer.
            enqueue_handoff(&asker, &speaker, "또");
            wake_asker(&speaker);
            assert!(inbox_is_empty(&asker), "a turn wakes its asker once");
            take_handoffs(&asker);

            take_origin(&speaker);
            session.inner.lock().unwrap().status = AgentStatus::Idle;
            remove_agent(&asker).unwrap();
        });
    }

    /// A bot's tell lands in the teammate's chat without lighting it up. The
    /// user's own tell does.
    #[test]
    fn a_tell_from_a_bot_does_not_make_the_chat_unread() {
        paths::testing::with_home("quiet-tell", || {
            let peer = test_id("peer");
            insert_spawned_agent(AgentConfig::new(
                peer.clone(),
                peer.clone(),
                AgentCli::Claude.default_cmd(),
                None,
            ))
            .unwrap();
            let Some(LiveAgent::Headless(session)) = agents().lock().unwrap().get(&peer).cloned()
            else {
                panic!("claude runs headless");
            };
            // Busy, so each tell waits in the inbox instead of starting a CLI.
            session.inner.lock().unwrap().status = AgentStatus::Working;

            tell_agent_origin(
                "rival",
                &peer,
                "가위바위보 한 판",
                None,
                false,
                &mut VecDeque::new(),
            )
            .unwrap();
            assert_eq!(crate::transcript::last_ts(&peer), 0);

            tell_agent_origin(
                "user",
                &peer,
                "누가 이겼어?",
                None,
                false,
                &mut VecDeque::new(),
            )
            .unwrap();
            assert!(crate::transcript::last_ts(&peer) > 0);

            session.inner.lock().unwrap().status = AgentStatus::Idle;
            remove_agent(&peer).unwrap();
        });
    }

    /// 빵셔틀 asked the user to approve before answering 춘식이. That question
    /// is not the answer, so 춘식이 is woken only once the turn is done.
    #[test]
    fn a_turn_waiting_on_approval_does_not_wake_its_asker() {
        paths::testing::with_home("wake-blocked", || {
            let asker = test_id("asker");
            let speaker = format!("rival-{asker}");
            for id in [&asker, &speaker] {
                insert_spawned_agent(AgentConfig::new(
                    id.clone(),
                    id.clone(),
                    AgentCli::Claude.default_cmd(),
                    None,
                ))
                .unwrap();
            }
            let set_status = |id: &str, to: AgentStatus| match agents().lock().unwrap().get(id) {
                Some(LiveAgent::Headless(s)) => s.inner.lock().unwrap().status = to,
                _ => panic!("claude runs headless"),
            };
            // Busy, so the wake waits in the inbox instead of starting a CLI.
            set_status(&asker, AgentStatus::Working);
            set_status(&speaker, AgentStatus::Blocked);
            let asked = TurnOrigin {
                from: asker.clone(),
                ..TurnOrigin::default()
            };
            set_origin(
                &speaker,
                targeting::inherit_origin(Some(&TurnOrigin::user()), asked),
            );
            enqueue_handoff(&asker, &speaker, "가위로 낼까요?");
            turn_ended(&speaker);
            assert!(
                inbox_is_empty(&asker),
                "a question for the user is not the answer"
            );

            set_status(&speaker, AgentStatus::Idle);
            enqueue_handoff(&asker, &speaker, "보");
            turn_ended(&speaker);
            let item = inbox()
                .lock()
                .unwrap()
                .get_mut(&asker)
                .and_then(|q| q.pop_front())
                .expect("woken once the turn is done");
            assert_eq!(item.text, format!("[crew handoff from:{speaker}]\n보"));

            take_origin(&speaker);
            for id in [&asker, &speaker] {
                set_status(id, AgentStatus::Idle);
                remove_agent(id).unwrap();
            }
        });
    }

    /// A stand-in `claude` in the test home, so a turn runs without the real
    /// CLI. It keeps the prompt it got in `prompt` beside it, then runs `body`.
    /// Notifications go off first: a turn's finish would post a real one.
    fn fake_claude(body: &str) -> String {
        use std::os::unix::fs::PermissionsExt;
        paths::write_notifications_enabled(false);
        let dir = paths::home_dir();
        let bin = dir.join("claude");
        let script = format!(
            "#!/bin/sh\nfor arg; do last=$arg; done\nprintf '%s' \"$last\" > '{}'\n{body}\n",
            dir.join("prompt").display()
        );
        fs::write(&bin, script).unwrap();
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
        bin.display().to_string()
    }

    /// A bot on `fake_claude` that prints `lines` as its turn.
    fn fake_bot(id: &str, lines: &str) {
        fake_bot_running(id, &format!("cat <<'EOF'\n{lines}\nEOF"));
    }

    fn fake_bot_running(id: &str, body: &str) {
        let cwd = paths::home_dir().display().to_string();
        insert_spawned_agent(AgentConfig::new(
            id.into(),
            id.into(),
            vec![fake_claude(body)],
            Some(cwd),
        ))
        .unwrap();
    }

    fn wait_idle(id: &str) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while agent_busy(id).unwrap_or(false) {
            assert!(Instant::now() < deadline, "{id} never finished its turn");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn eventually(within: Duration, what: &str, done: impl Fn() -> bool) {
        let deadline = Instant::now() + within;
        while !done() {
            assert!(Instant::now() < deadline, "{what}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn told(id: &str, text: &str) -> bool {
        crate::transcript::messages(id)
            .iter()
            .any(|m| m.text == text)
    }

    /// A reply that asks "진행할까요?" waits on allow / deny. A user who
    /// answers in words instead starts a new turn, and the card has nothing
    /// left to hold back: a click on it later flipped the bot to idle in the
    /// middle of that turn and sent "Continue." after it.
    #[test]
    fn talking_to_a_blocked_bot_takes_its_card_down() {
        paths::testing::with_home("blocked-talk", || {
            let bot = test_id("blocked");
            fake_bot(&bot, "");
            crate::transcript::begin_turn(&bot);
            crate::transcript::on_assistant_delta(&bot, "이대로 진행할까요?");
            crate::transcript::end_turn(&bot);
            let ask = crate::transcript::messages(&bot).pop().unwrap();
            crate::transcript::set_approval(&bot, &ask.id, crate::protocol::ApprovalState::Pending);
            set_live_status(&bot, AgentStatus::Blocked);

            send_agent(&bot, "응, 진행해").unwrap();
            assert!(crate::transcript::pending_approval(&bot).is_none());
            wait_idle(&bot);
            assert!(
                approve_agent(&bot, true).is_err(),
                "nothing left to approve"
            );
            remove_agent(&bot).unwrap();
        });
    }

    /// `/compact` reads as a command only when the prompt starts with it. A
    /// teammate's reply waiting for the next prompt went in front of it, and
    /// the CLI took the command for words.
    #[test]
    fn a_slash_command_goes_out_alone() {
        assert!(is_slash_command("/compact keep the API notes"));
        assert!(!is_slash_command("/Users/me/shot.png 이거 봐줘"));
        assert!(!is_slash_command("/ 안녕"));
        assert!(!is_slash_command("이거 /compact"));
        paths::testing::with_home("slash", || {
            let bot = test_id("slash");
            fake_bot(
                &bot,
                r#"{"type":"user","message":{"role":"user","content":"<local-command-stdout>Compacted </local-command-stdout>"}}
{"type":"result","subtype":"success","is_error":false,"result":""}"#,
            );
            enqueue_handoff(&bot, "peer", "their answer");

            send_agent(&bot, "/compact").unwrap();
            wait_idle(&bot);
            let prompt = fs::read_to_string(paths::home_dir().join("prompt")).unwrap();
            assert_eq!(prompt, "/compact");
            let last = crate::transcript::messages(&bot).pop().unwrap();
            assert_eq!(
                (last.role, last.text.as_str()),
                (Role::Assistant, "Compacted")
            );
            let next = flush_handoffs(&bot, "hi");
            assert!(
                next.contains("their answer"),
                "it rides the next prompt: {next}"
            );
            remove_agent(&bot).unwrap();
        });
    }

    /// "멈춰" kills the CLI, but what it printed on its way out is still read
    /// from the pipe. It came back as a reply under "멈춰", or at the front of
    /// the answer to a message that was waiting.
    #[test]
    fn a_stopped_cli_gets_no_last_word() {
        paths::testing::with_home("stop-tail", || {
            let bot = test_id("tail");
            // The writer leaves the process group, so it outlives the stop: it
            // stands in for output that was still in the pipe when the CLI died.
            fake_bot_running(
                &bot,
                r#"perl -e 'setpgrp(0, 0); select(undef, undef, undef, 1); print qq({"type":"assistant","message":{"content":[{"type":"text","text":"late"}]}}\n)' &
cat <<'EOF'
{"type":"assistant","message":{"content":[{"type":"text","text":"early"}]}}
EOF
exec sleep 5"#,
            );
            send_agent(&bot, "go").unwrap();
            let deadline = Instant::now() + Duration::from_secs(5);
            while !crate::transcript::messages(&bot)
                .iter()
                .any(|m| m.text == "early")
            {
                assert!(Instant::now() < deadline, "the turn never spoke");
                std::thread::sleep(Duration::from_millis(10));
            }
            send_agent(&bot, "멈춰").unwrap();
            std::thread::sleep(Duration::from_millis(1500));
            let rows = crate::transcript::messages(&bot);
            let stop = rows.iter().position(|m| m.text == "멈춰").unwrap();
            assert!(
                rows[stop..].iter().all(|m| m.role != Role::Assistant),
                "{:?}",
                rows.iter()
                    .map(|m| (m.role, m.text.as_str()))
                    .collect::<Vec<_>>()
            );
            remove_agent(&bot).unwrap();
        });
    }

    /// npm's codex is a node launcher, and a stop killed only the launcher: the
    /// CLI under it kept working, on the session the next turn resumes.
    #[test]
    fn a_stop_ends_the_whole_cli() {
        paths::testing::with_home("stop-group", || {
            let bot = test_id("group");
            let home = paths::home_dir();
            let (armed, outlived) = (home.join("armed"), home.join("outlived"));
            fake_bot_running(
                &bot,
                &format!(
                    "( sleep 1; touch '{}' ) &\ntouch '{}'\nexec sleep 5",
                    outlived.display(),
                    armed.display()
                ),
            );
            send_agent(&bot, "go").unwrap();
            eventually(Duration::from_secs(5), "the CLI never started", || {
                armed.exists()
            });
            interrupt_turn(&bot).unwrap();
            std::thread::sleep(Duration::from_millis(1500));
            assert!(!outlived.exists(), "part of the CLI outlived the stop");
            wait_idle(&bot);
            remove_agent(&bot).unwrap();
        });
    }

    /// npm's codex is a node launcher whose native child keeps the output pipe
    /// after a stop. When the pipe closed, the stopped turn's reader waited,
    /// holding the bot's lock, on whatever child was there: the next turn's.
    /// Everything that looked at the bot hung with it.
    #[test]
    fn a_stopped_turn_does_not_wait_on_the_next_one() {
        paths::testing::with_home("stale-wait", || {
            let bot = test_id("launcher");
            let armed = paths::home_dir().join("armed");
            // The writer leaves the process group, so no stop reaches it.
            fake_bot_running(
                &bot,
                &format!(
                    r#"case "$last" in *next*) exec sleep 3 ;; esac
perl -e 'setpgrp(0, 0); select(undef, undef, undef, 0.5)' &
touch '{}'
exec sleep 5"#,
                    armed.display()
                ),
            );
            send_agent(&bot, "first").unwrap();
            eventually(Duration::from_secs(5), "the writer never started", || {
                armed.exists()
            });
            send_agent(&bot, "next please").unwrap();
            interrupt_turn(&bot).unwrap();
            // The writer lets go at 0.5s, and the next turn runs until 3s.
            std::thread::sleep(Duration::from_secs(1));
            let asked = Instant::now();
            let _ = live_status(&bot);
            assert!(
                asked.elapsed() < Duration::from_millis(500),
                "the stopped turn held the bot"
            );
            interrupt_turn(&bot).unwrap();
            wait_idle(&bot);
            remove_agent(&bot).unwrap();
        });
    }

    /// Two callers can find a bot idle at once, and only one turn starts. The
    /// other undid the winner's origin and peer on its way out.
    #[test]
    fn a_start_under_way_makes_another_wait() {
        paths::testing::with_home("one-start", || {
            paths::write_notifications_enabled(false);
            let bot = test_id("contended");
            insert_spawned_agent(AgentConfig::new(
                bot.clone(),
                bot.clone(),
                AgentCli::Claude.default_cmd(),
                None,
            ))
            .unwrap();
            let running = TurnOrigin::mention_tell("asker");
            set_origin(&bot, running.clone());
            let start = claim_start(&bot).expect("nothing is starting");
            assert!(claim_start(&bot).is_none(), "one start at a time");
            submit_delivery(&bot, "second", true, None, TurnOrigin::user()).unwrap();
            assert_eq!(get_origin(&bot), Some(running));
            assert!(!inbox_is_empty(&bot), "it waits for the start under way");
            drop(start);
            clear_inbox(&bot);
            take_origin(&bot);
            remove_agent(&bot).unwrap();
        });
    }

    #[test]
    fn a_stop_takes_the_approval_card_down() {
        paths::testing::with_home("blocked-stop", || {
            paths::write_notifications_enabled(false);
            let bot = test_id("blocked");
            insert_spawned_agent(AgentConfig::new(
                bot.clone(),
                bot.clone(),
                AgentCli::Claude.default_cmd(),
                None,
            ))
            .unwrap();
            let ask = crate::transcript::push_system(&bot, "crew", "삭제할까요?", None);
            crate::transcript::set_approval(&bot, &ask.id, crate::protocol::ApprovalState::Pending);
            set_live_status(&bot, AgentStatus::Blocked);

            interrupt_turn(&bot).unwrap();
            assert!(crate::transcript::pending_approval(&bot).is_none());
            assert_eq!(live_status(&bot).unwrap(), AgentStatus::Idle);
            remove_agent(&bot).unwrap();
        });
    }

    /// The stop seals what the reply got to. Read as a question, the cut-off
    /// words left the bot blocked on a card right after the user stopped it.
    #[test]
    fn a_reply_cut_off_by_a_stop_is_not_a_question() {
        paths::testing::with_home("stopped-ask", || {
            paths::write_notifications_enabled(false);
            let bot = test_id("stopped");
            insert_spawned_agent(AgentConfig::new(
                bot.clone(),
                bot.clone(),
                AgentCli::Claude.default_cmd(),
                None,
            ))
            .unwrap();
            let Some(LiveAgent::Headless(session)) = agents().lock().unwrap().get(&bot).cloned()
            else {
                panic!("claude runs headless");
            };
            set_origin(&bot, TurnOrigin::user());
            headless::interrupt(&session);
            let cut = crate::transcript::push_system(&bot, "crew", "x", None);
            let reply = ChatMessage {
                role: Role::Assistant,
                text: "파일을 지우기 전에 확인해도 될까".into(),
                ..cut
            };
            on_assistant_sealed(&bot, &reply);
            assert!(crate::transcript::pending_approval(&bot).is_none());
            assert_eq!(live_status(&bot).unwrap(), AgentStatus::Idle);
            take_origin(&bot);
            remove_agent(&bot).unwrap();
        });
    }

    /// A delivery that does not go out leaves the turn already running as it
    /// was: where its reply goes, and which bot its rows belong to.
    #[test]
    fn a_failed_delivery_keeps_the_running_turn() {
        let id = test_id("unknown");
        let running = TurnOrigin::mention_tell("asker");
        set_origin(&id, running.clone());
        crate::transcript::set_peer(&id, Some("asker".into()));
        assert!(start_delivery(
            claim_start(&id).unwrap(),
            "hi",
            true,
            TurnOrigin::user(),
            &mut VecDeque::new()
        )
        .is_err());
        assert_eq!(get_origin(&id), Some(running));
        assert_eq!(
            crate::transcript::set_peer(&id, None).as_deref(),
            Some("asker")
        );
        take_origin(&id);
        crate::transcript::drop_agent(&id);
    }

    #[test]
    fn a_direct_tell_drops_that_peer_pending_handoff() {
        let caller = test_id("drop-pending");
        enqueue_handoff(&caller, "review", "stale review");
        enqueue_handoff(&caller, "impl", "still relevant");
        take_handoff_from(&caller, "review");
        let next = flush_handoffs(&caller, "hello");
        assert!(next.contains("hello"), "the prompt must survive: {next}");
        assert!(!next.contains("stale review"), "{next}");
        assert!(next.contains("still relevant"), "{next}");
    }

    #[test]
    fn a_restored_handoff_yields_to_the_reply_that_replaced_it() {
        let caller = format!(
            "restore-pending-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        enqueue_handoff(&caller, "review", "old text");
        // The delivery drains the queue, then fails.
        let in_flight = take_handoffs(&caller);
        // While it was out, that peer sealed a newer reply.
        enqueue_handoff(&caller, "review", "new text");
        restore_handoffs(&caller, in_flight);
        let next = flush_handoffs(&caller, "go");
        assert!(next.contains("new text"), "{next}");
        assert!(
            !next.contains("old text"),
            "the superseded copy must go: {next}"
        );
    }

    #[test]
    fn a_restored_handoff_keeps_a_different_peer() {
        let caller = format!(
            "restore-other-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        enqueue_handoff(&caller, "review", "from review");
        let in_flight = take_handoffs(&caller);
        enqueue_handoff(&caller, "impl", "from impl");
        restore_handoffs(&caller, in_flight);
        let next = flush_handoffs(&caller, "go");
        assert!(next.contains("from review"), "{next}");
        assert!(next.contains("from impl"), "{next}");
    }

    #[test]
    fn one_omitted_handoff_reads_as_one_reply() {
        let caller = format!(
            "one-omitted-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        for i in 0..(MAX_PENDING_HANDOFFS + 1) {
            enqueue_handoff(&caller, &format!("bot{i}"), &format!("reply {i}"));
        }
        let next = flush_handoffs(&caller, "go");
        assert!(next.contains("1 earlier reply omitted"), "{next}");
    }

    #[test]
    fn extra_pending_handoffs_are_omitted() {
        let caller = test_id("omit-pending");
        for i in 0..5 {
            enqueue_handoff(&caller, &format!("bot{i}"), &format!("reply {i}"));
        }
        let next = flush_handoffs(&caller, "go");
        assert!(next.contains("go"), "the prompt must survive: {next}");
        assert!(next.contains("2 earlier replies omitted"), "{next}");
        assert!(!next.contains("reply 0"), "{next}");
        assert!(next.contains("reply 4"), "{next}");
    }

    fn tell_job(to: &str, text: &str) -> SerialJob {
        SerialJob {
            to: to.to_string(),
            kind: SerialKind::Tell {
                from: "user".into(),
                text: text.to_string(),
                origin: None,
            },
        }
    }

    /// "@B @C" in A's chat: A answers, then B, then C, one at a time.
    #[test]
    fn a_chain_answers_a_then_b_then_c() {
        paths::testing::with_home("chain", || {
            let order = paths::home_dir().join("order");
            let body = format!("echo \"$CREW_AGENT_ID\" >> '{}'", order.display());
            let [a, b, c] = ["chain-a", "chain-b", "chain-c"].map(test_id);
            for id in [&a, &b, &c] {
                fake_bot_running(id, &body);
            }
            send_agent(&a, &format!("@{b} @{c} 봐줘")).unwrap();
            let ran = || fs::read_to_string(&order).unwrap_or_default();
            eventually(Duration::from_secs(10), "the chain stopped short", || {
                ran().lines().count() == 3
            });
            let ran = ran();
            assert_eq!(
                ran.lines().collect::<Vec<_>>(),
                [a.as_str(), b.as_str(), c.as_str()]
            );
            for id in [&a, &b, &c] {
                wait_idle(id);
                remove_agent(id).unwrap();
            }
        });
    }

    /// "@B @C" from A's chat while B is busy with other work: B's turn queues,
    /// and C waits on that turn. Talking to B, or stopping what B was doing,
    /// is about the other work: C still answers once B has.
    #[test]
    fn the_rest_of_a_chain_waits_with_its_queued_turn() {
        paths::testing::with_home("chain-tail", || {
            let [a, b, c] = ["tail-a", "tail-b", "tail-c"].map(test_id);
            for id in [&b, &c] {
                fake_bot(id, "");
            }
            match agents().lock().unwrap().get(&b) {
                Some(LiveAgent::Headless(s)) => {
                    s.inner.lock().unwrap().status = AgentStatus::Working
                }
                _ => panic!("fake claude runs headless"),
            }
            let ask = |to: &str| SerialJob {
                to: to.into(),
                kind: SerialKind::Tell {
                    from: "user".into(),
                    text: "같이 봐줘".into(),
                    origin: Some(TurnOrigin::mention_tell(&a)),
                },
            };
            queue_serial_after(&a, VecDeque::from([ask(&b), ask(&c)]));
            advance_serial(&a);
            assert!(!inbox_is_empty(&b), "B is busy, so its turn queues");

            send_agent(&b, "다른 얘기").unwrap();
            interrupt_turn(&b).unwrap();
            eventually(
                Duration::from_secs(10),
                "C was dropped with B's other work",
                || told(&c, "같이 봐줘"),
            );
            for id in [&b, &c] {
                wait_idle(id);
                remove_agent(id).unwrap();
            }
        });
    }

    /// A tell the bot ran goes out when that turn ends. The user asking how it
    /// is going does not take it back, and the message waiting behind the turn
    /// can take as long as it likes.
    #[test]
    fn a_tell_goes_out_when_its_turn_ends() {
        paths::testing::with_home("tell-first", || {
            let [bot, builder] = ["teller", "builder"].map(test_id);
            let body = "case \"$last\" in *slow*) exec sleep 5 ;; *first*) sleep 0.5 ;; esac";
            fake_bot_running(&bot, body);
            fake_bot_running(&builder, body);
            send_agent(&bot, "first").unwrap();
            tell_agent(&bot, &builder, "구현해줘").unwrap();
            send_agent(&bot, "slow one, and how is it going?").unwrap();
            // The slow one takes five seconds; the tell does not wait for it,
            // and it still runs.
            let within = Duration::from_secs(3);
            eventually(within, "the tell waited on the next message", || {
                told(&builder, "구현해줘")
            });
            eventually(within, "the next message did not start", || {
                agent_busy(&bot).unwrap_or(false)
            });
            interrupt_turn(&bot).unwrap();
            for id in [&bot, &builder] {
                wait_idle(id);
                remove_agent(id).unwrap();
            }
        });
    }

    #[test]
    fn a_busy_tell_keeps_its_place_in_the_chain() {
        let anchor = test_id("serial-upgrade");
        let [a, b, c] = ["up-a", "up-b", "up-c"].map(test_id);
        queue_serial_after(
            &anchor,
            VecDeque::from([
                tell_job(&a, "user text"),
                tell_job(&b, "b"),
                tell_job(&c, "c"),
            ]),
        );
        defer_tell(&anchor, &b, &anchor, "from the bot", None);
        let chain: Vec<(String, String)> = take_followers(&anchor)
            .into_iter()
            .map(|job| {
                let SerialKind::Tell { text, .. } = job.kind;
                (job.to, text)
            })
            .collect();
        assert_eq!(
            chain,
            [
                (a, "user text".to_string()),
                (b, "from the bot".to_string()),
                (c, "c".to_string()),
            ]
        );
    }

    /// Only the teammates named in this bot's own chat are a newer message
    /// there's to drop.
    #[test]
    fn a_newer_message_drops_only_whom_its_chat_named() {
        let bot = test_id("named");
        let named = |chat: &str, to: &str| SerialJob {
            to: to.into(),
            kind: SerialKind::Tell {
                from: "user".into(),
                text: "봐줘".into(),
                origin: Some(TurnOrigin::mention_tell(chat)),
            },
        };
        queue_serial_after(
            &bot,
            VecDeque::from([named(&bot, "reviewer"), named("other-chat", "tester")]),
        );
        defer_tell(&bot, "builder", &bot, "구현해줘", None);
        drop_mention_followers(&bot);
        let left: Vec<String> = take_followers(&bot).into_iter().map(|j| j.to).collect();
        assert_eq!(left, ["tester", "builder"]);
    }

    /// A turn still being started there keeps what waits on it in place.
    #[test]
    fn followers_stay_while_their_turn_is_being_started() {
        let anchor = test_id("serial-arming");
        queue_serial_after(&anchor, VecDeque::from([tell_job("someone", "x")]));
        let start = claim_start(&anchor);
        assert!(take_followers(&anchor).is_empty());
        drop(start);
        assert_eq!(take_followers(&anchor).len(), 1);
    }

    #[test]
    fn a_new_chain_runs_before_jobs_already_waiting() {
        let anchor = test_id("serial-prepend");
        let old = test_id("prepend-old");
        let new_to = test_id("prepend-new");
        queue_serial_after(&anchor, VecDeque::from([tell_job(&old, "old")]));
        queue_serial_after(&anchor, VecDeque::from([tell_job(&new_to, "new")]));
        let chain: Vec<String> = take_followers(&anchor).into_iter().map(|j| j.to).collect();
        assert_eq!(chain, [new_to, old]);
    }

    #[test]
    fn a_cleared_chain_drops_a_tell_that_arrives_late() {
        let anchor = test_id("serial-epoch");
        let b = test_id("epoch-b");
        let seen = serial_epoch(&anchor);
        clear_serial_after(&anchor);
        assert!(!defer_tell_if_epoch(
            &anchor, seen, &b, &anchor, "late", None
        ));
        assert!(take_followers(&anchor).is_empty());
        let seen = serial_epoch(&anchor);
        assert!(defer_tell_if_epoch(
            &anchor, seen, &b, &anchor, "kept", None
        ));
        let job = take_followers(&anchor).pop_front().expect("kept");
        assert_eq!(job.to, b);
        let SerialKind::Tell { text, .. } = job.kind;
        assert_eq!(text, "kept");
    }
}
