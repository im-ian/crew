use std::collections::{HashMap, VecDeque};
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
    AgentConfig, AvatarShape, Config, Effort, Routine,
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
/// Jobs that wait until `agent` is idle, then run one at a time in order.
static SERIAL: OnceLock<Mutex<SerialBoard>> = OnceLock::new();

struct PendingDelivery {
    text: String,
    newline: bool,
    msg_id: Option<String>,
    origin: TurnOrigin,
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

fn drop_pending_from(peer: &str, from: &str) {
    if let Ok(mut map) = pending_handoffs().lock() {
        if let Some(q) = map.get_mut(peer) {
            q.retain(|h| h.from != from);
            if q.is_empty() {
                map.remove(peer);
            }
        }
    }
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
    // A stop ends the chain. The members still waiting must not answer it.
    clear_serial_after(id);
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
            advance_serial(id);
            return Err(err);
        }
    } else {
        advance_serial(id);
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

fn start_delivery(id: &str, text: &str, newline: bool, origin: TurnOrigin) -> anyhow::Result<()> {
    let pending = take_handoffs(id);
    let text = if pending.is_empty() {
        text.to_string()
    } else {
        crate::protocol::attach_after_marker(text, &render_handoffs(&pending))
    };
    crate::transcript::expect_echo(id, &text);
    set_origin(id, origin);
    match deliver(id, &text, newline) {
        Ok(()) => Ok(()),
        Err(err) => {
            restore_handoffs(id, pending);
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
    crate::transcript::push_system(id, "crew", line);
}

pub(crate) fn pump_inbox(id: &str) {
    pump_inbox_inner(id, true);
}

fn pump_inbox_inner(id: &str, then_serial: bool) {
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
        if then_serial {
            advance_serial(id);
        }
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
            pump_inbox_inner(id, then_serial);
        }
    }
}

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

struct SerialBoard {
    queues: HashMap<String, VecDeque<SerialJob>>,
    /// Callers currently attaching followers. A count, so one caller finishing
    /// does not expose the tail while another is still attaching it.
    arming: HashMap<String, u32>,
    /// Bumped when an agent's chain is cleared. A tell that observed an older
    /// value belongs to a turn the user already replaced or stopped.
    epoch: HashMap<String, u64>,
}

fn serial_board() -> &'static Mutex<SerialBoard> {
    SERIAL.get_or_init(|| {
        Mutex::new(SerialBoard {
            queues: HashMap::new(),
            arming: HashMap::new(),
            epoch: HashMap::new(),
        })
    })
}

fn mark_serial_arming(agent: &str) {
    if agent.is_empty() {
        return;
    }
    if let Ok(mut board) = serial_board().lock() {
        *board.arming.entry(agent.to_string()).or_insert(0) += 1;
    }
}

fn unmark_serial_arming(agent: &str) {
    if let Ok(mut board) = serial_board().lock() {
        let done = match board.arming.get_mut(agent) {
            Some(n) if *n > 1 => {
                *n -= 1;
                false
            }
            Some(_) => true,
            None => false,
        };
        if done {
            board.arming.remove(agent);
        }
    }
}

fn is_serial_arming(agent: &str) -> bool {
    serial_board()
        .lock()
        .ok()
        .map(|board| board.arming.contains_key(agent))
        .unwrap_or(false)
}

fn serial_epoch(agent: &str) -> u64 {
    serial_board()
        .lock()
        .ok()
        .and_then(|board| board.epoch.get(agent).copied())
        .unwrap_or(0)
}

fn queue_serial_after(agent: &str, jobs: Vec<SerialJob>) {
    if agent.is_empty() || jobs.is_empty() {
        return;
    }
    if let Ok(mut board) = serial_board().lock() {
        // This message stays contiguous, ahead of work already waiting here.
        let q = board.queues.entry(agent.to_string()).or_default();
        let mut combined = VecDeque::from(jobs);
        combined.append(q);
        *q = combined;
    }
}

fn clear_serial_after(agent: &str) {
    if let Ok(mut board) = serial_board().lock() {
        board.queues.remove(agent);
        let epoch = board.epoch.entry(agent.to_string()).or_insert(0);
        *epoch = epoch.wrapping_add(1);
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

fn defer_tell(anchor: &str, to: &str, from: &str, text: &str, origin: Option<TurnOrigin>) {
    let epoch = serial_epoch(anchor);
    let _ = defer_tell_if_epoch(anchor, epoch, to, from, text, origin);
}

fn park_tail(
    queues: &mut HashMap<String, VecDeque<SerialJob>>,
    next_to: &str,
    mut rest: VecDeque<SerialJob>,
) {
    if rest.is_empty() {
        return;
    }
    let dest = queues.entry(next_to.to_string()).or_default();
    let mut combined = VecDeque::new();
    combined.append(&mut rest);
    combined.append(dest);
    *dest = combined;
}

/// Pop the next job waiting on `finished` and leave the rest waiting on that
/// job's agent, so the chain stays A, then B, then C.
fn take_next_serial(finished: &str) -> Option<SerialJob> {
    let mut board = serial_board().lock().ok()?;
    let mut q = board.queues.remove(finished)?;
    let next = q.pop_front()?;
    park_tail(&mut board.queues, &next.to, q);
    Some(next)
}

/// Same handoff as `take_next_serial`, and the next agent is arming before the
/// lock is released. A turn that ends in that window cannot start the follower
/// until `unmark_serial_arming`.
fn claim_next_serial(finished: &str) -> Option<SerialJob> {
    let mut board = serial_board().lock().ok()?;
    if board.arming.contains_key(finished) {
        return None;
    }
    let mut q = board.queues.remove(finished)?;
    let next = q.pop_front()?;
    park_tail(&mut board.queues, &next.to, q);
    *board.arming.entry(next.to.clone()).or_insert(0) += 1;
    Some(next)
}

fn run_serial_job(job: &SerialJob) -> anyhow::Result<bool> {
    let SerialKind::Tell { from, text, origin } = &job.kind;
    tell_agent_origin(from, &job.to, text, origin.clone(), false)?;
    Ok(true)
}

fn advance_serial(start: &str) {
    let mut current = start.to_string();
    loop {
        if is_serial_arming(&current) {
            return;
        }
        match live_status(&current) {
            Ok(AgentStatus::Working | AgentStatus::Blocked) => return,
            Ok(AgentStatus::Idle | AgentStatus::Exited) => {
                if !inbox_is_empty(&current) {
                    pump_inbox_inner(&current, false);
                    if agent_busy(&current).unwrap_or(false) || !inbox_is_empty(&current) {
                        return;
                    }
                }
            }
            Err(_) => {}
        }
        let Some(job) = claim_next_serial(&current) else {
            return;
        };
        let started = run_serial_job(&job);
        unmark_serial_arming(&job.to);
        match started {
            Ok(true) => {
                if !agent_busy(&job.to).unwrap_or(true) {
                    pump_inbox(&job.to);
                }
                return;
            }
            Ok(false) => current = job.to.clone(),
            Err(err) => {
                eprintln!("[crew] serial {current} -> {}: {err:#}", job.to);
                current = job.to.clone();
            }
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
    let interrupted = agent_interrupted(agent);
    crate::notify::maybe_status_notify(agent, &name, prev, *status, interrupted);
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
                        advance_serial(&id);
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
    let mentions = targeting::one_on_one_tell_targets(crate::rows::reply_body(text), id, &roster);
    let delivered = crate::config::with_mention_hint(text, id, &roster);
    // Install the followers before the turn starts. A fast turn can finish
    // inside `submit_delivery`, and the arming flag keeps that finish from
    // running the chain before it is in place.
    mark_serial_arming(id);
    clear_serial_after(id);
    if !mentions.is_empty() {
        let jobs = mentions
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
        queue_serial_after(id, jobs);
    }
    let started = submit_delivery(id, &delivered, true, Some(msg.id), TurnOrigin::user());
    unmark_serial_arming(id);
    // Idle here means this bot's turn did not stay up. The named teammates
    // still answer, in order, instead of the chain dying with this bot.
    if !agent_busy(id).unwrap_or(true) {
        pump_inbox(id);
    }
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
    tell_agent_origin(from, to, text, None, true)
}

fn tell_agent_origin(
    from: &str,
    to: &str,
    text: &str,
    origin: Option<TurnOrigin>,
    allow_defer: bool,
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
        drop_pending_from(to, &from);
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
    } else if let Some(owner) = mention_owner.as_deref() {
        if owner != to {
            let known = agents()
                .lock()
                .ok()
                .map(|map| map.contains_key(owner))
                .unwrap_or(false);
            if known {
                crate::transcript::push_notice(owner, &format!("to:{to}"), text);
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
    if let Some(name) = name {
        let name = name.trim();
        if !name.is_empty() {
            routines[idx].name = name.to_string();
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
            routines[idx].schedule = resolved;
        }
    }
    if let Some(prompt) = prompt {
        let prompt = prompt.trim();
        if !prompt.is_empty() {
            routines[idx].prompt = prompt.to_string();
        }
    }
    write_routines(target, routines)
}

fn remove_routine(target: &str, key: &str) -> anyhow::Result<()> {
    let mut routines = read_routines(target)?;
    let idx = find_routine_index(&routines, key)
        .ok_or_else(|| anyhow::anyhow!("unknown routine {key}"))?;
    routines.remove(idx);
    write_routines(target, routines)
}

fn set_routine_enabled(target: &str, key: &str, enabled: bool) -> anyhow::Result<()> {
    let mut routines = read_routines(target)?;
    let idx = find_routine_index(&routines, key)
        .ok_or_else(|| anyhow::anyhow!("unknown routine {key}"))?;
    routines[idx].enabled = enabled;
    write_routines(target, routines)
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
    if crate::interrupt::looks_like_judgment_question(&text) {
        crate::transcript::set_approval(agent, &msg.id, crate::protocol::ApprovalState::Pending);
        set_live_status(agent, AgentStatus::Blocked);
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

    #[test]
    fn a_direct_tell_drops_that_peer_pending_handoff() {
        let caller = test_id("drop-pending");
        enqueue_handoff(&caller, "review", "stale review");
        enqueue_handoff(&caller, "impl", "still relevant");
        drop_pending_from(&caller, "review");
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

    #[test]
    fn a_chain_answers_a_then_b_then_c() {
        let anchor = test_id("serial-anchor");
        let a = test_id("serial-a");
        let b = test_id("serial-b");
        let c = test_id("serial-c");
        queue_serial_after(
            &anchor,
            vec![
                tell_job(&a, "first"),
                tell_job(&b, "second"),
                tell_job(&c, "third"),
            ],
        );
        let first = take_next_serial(&anchor).expect("A");
        assert_eq!(first.to, a);
        let second = take_next_serial(&a).expect("B");
        assert_eq!(second.to, b);
        let third = take_next_serial(&b).expect("C");
        assert_eq!(third.to, c);
        assert!(take_next_serial(&c).is_none());
        assert!(take_next_serial(&anchor).is_none());
        clear_serial_after(&anchor);
        clear_serial_after(&a);
        clear_serial_after(&b);
        clear_serial_after(&c);
    }

    #[test]
    fn a_busy_tell_keeps_its_place_in_the_chain() {
        let anchor = test_id("serial-upgrade");
        let a = test_id("up-a");
        let b = test_id("up-b");
        let c = test_id("up-c");
        queue_serial_after(
            &anchor,
            vec![
                tell_job(&a, "user text"),
                tell_job(&b, "b"),
                tell_job(&c, "c"),
            ],
        );
        defer_tell(&anchor, &b, &anchor, "from the bot", None);
        let first = take_next_serial(&anchor).unwrap();
        let second = take_next_serial(&a).unwrap();
        let third = take_next_serial(&b).unwrap();
        assert_eq!(first.to, a);
        assert_eq!(second.to, b);
        let SerialKind::Tell { text, .. } = second.kind;
        assert_eq!(text, "from the bot");
        assert_eq!(third.to, c);
        clear_serial_after(&anchor);
        clear_serial_after(&a);
        clear_serial_after(&b);
        clear_serial_after(&c);
    }

    #[test]
    fn claiming_the_next_bot_holds_the_rest_until_it_starts() {
        let anchor = test_id("serial-claim");
        let a = test_id("claim-a");
        let b = test_id("claim-b");
        queue_serial_after(&anchor, vec![tell_job(&a, "first"), tell_job(&b, "second")]);
        let first = claim_next_serial(&anchor).expect("A");
        assert_eq!(first.to, a);
        assert!(
            claim_next_serial(&a).is_none(),
            "the follower stays queued while A is still being started"
        );
        unmark_serial_arming(&a);
        let second = claim_next_serial(&a).expect("B");
        assert_eq!(second.to, b);
        unmark_serial_arming(&b);
        clear_serial_after(&anchor);
        clear_serial_after(&a);
        clear_serial_after(&b);
    }

    #[test]
    fn a_new_chain_runs_before_jobs_already_waiting() {
        let anchor = test_id("serial-prepend");
        let old = test_id("prepend-old");
        let new_to = test_id("prepend-new");
        queue_serial_after(&anchor, vec![tell_job(&old, "old")]);
        queue_serial_after(&anchor, vec![tell_job(&new_to, "new")]);
        let first = take_next_serial(&anchor).expect("new message first");
        assert_eq!(first.to, new_to);
        let second = take_next_serial(&new_to).expect("older job follows");
        assert_eq!(second.to, old);
        clear_serial_after(&anchor);
        clear_serial_after(&old);
        clear_serial_after(&new_to);
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
        assert!(take_next_serial(&anchor).is_none());
        let seen = serial_epoch(&anchor);
        assert!(defer_tell_if_epoch(
            &anchor, seen, &b, &anchor, "kept", None
        ));
        let job = take_next_serial(&anchor).expect("kept");
        assert_eq!(job.to, b);
        let SerialKind::Tell { text, .. } = job.kind;
        assert_eq!(text, "kept");
        clear_serial_after(&anchor);
        clear_serial_after(&b);
    }
}
