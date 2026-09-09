use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::paths;
use crate::protocol::{
    ApprovalState, ChatMessage, ChoiceCard, ChoiceState, Event, MessageKind, Role,
};
use crate::rows::{is_crew_marker_line, strip_crew_markers};

fn channel_key(id: &str) -> String {
    format!("ch:{id}")
}

const EMIT_INTERVAL: Duration = Duration::from_millis(60);
const SEAL_IDLE: Duration = Duration::from_millis(650);
const EXPECT_TIMEOUT: Duration = Duration::from_millis(2000);

static CHATS: OnceLock<Mutex<HashMap<String, AgentChat>>> = OnceLock::new();
static ID_SEQ: AtomicU64 = AtomicU64::new(1);
static SEAL_HOOK: OnceLock<fn(&str, &ChatMessage)> = OnceLock::new();

pub fn set_seal_hook(hook: fn(&str, &ChatMessage)) {
    let _ = SEAL_HOOK.set(hook);
}

struct AgentChat {
    messages: Vec<ChatMessage>,
    expecting: bool,
    pending_idx: Option<usize>,
    last_byte: Instant,
    last_emit: Instant,
    dirty: bool,
    utf8_tail: Vec<u8>,
    /// When set, idle-seal is deferred until `end_turn` (headless tool pauses).
    hold: bool,
    /// Injected stdin expected to echo on the PTY; stripped from assistant text.
    echo_skip: String,
    /// begin_turn generation so a cancelled turn cannot seal its successor.
    turn_gen: u64,
    /// CLI tool-call id -> message id, so repeat events update one card.
    tool_ids: HashMap<String, String>,
}

impl AgentChat {
    fn empty() -> Self {
        Self {
            messages: Vec::new(),
            expecting: false,
            pending_idx: None,
            last_byte: Instant::now(),
            last_emit: Instant::now(),
            dirty: false,
            utf8_tail: Vec::new(),
            hold: false,
            echo_skip: String::new(),
            turn_gen: 0,
            tool_ids: HashMap::new(),
        }
    }
}

fn chats() -> &'static Mutex<HashMap<String, AgentChat>> {
    CHATS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn new_id() -> String {
    let n = ID_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{}-{n}", now_ms())
}

fn persist_path(key: &str) -> std::path::PathBuf {
    if let Some(id) = key.strip_prefix("ch:") {
        paths::channel_transcript_path(id)
    } else {
        paths::transcript_path(key)
    }
}

fn load_key(key: &str, path: &Path) {
    let mut messages = Vec::new();
    if let Ok(file) = File::open(path) {
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            if let Ok(msg) = serde_json::from_str::<ChatMessage>(line) {
                messages.push(msg);
            }
        }
    }
    if let Ok(mut map) = chats().lock() {
        map.insert(
            key.to_string(),
            AgentChat {
                messages,
                expecting: false,
                pending_idx: None,
                last_byte: Instant::now(),
                last_emit: Instant::now(),
                dirty: false,
                utf8_tail: Vec::new(),
                hold: false,
                echo_skip: String::new(),
                turn_gen: 0,
                tool_ids: HashMap::new(),
            },
        );
    }
}

pub fn load_agent(agent: &str) {
    load_key(agent, &paths::transcript_path(agent));
}

pub fn load_channel(id: &str) {
    load_key(&channel_key(id), &paths::channel_transcript_path(id));
}

pub fn drop_agent(agent: &str) {
    drop_key(agent, &paths::transcript_path(agent));
}

pub fn drop_channel(id: &str) {
    drop_key(&channel_key(id), &paths::channel_transcript_path(id));
}

/// Removal is final: forget the chat and its file, so an id reused by a
/// later agent of the same name does not inherit the old session.
///
/// The path is passed in rather than derived, so this agrees with
/// `load_agent` / `load_channel` on where a key's file lives — deriving it
/// would read an agent id that happens to start with `ch:` as a channel and
/// unlink a real room. The guard is held across the unlink so a concurrent
/// push cannot write a file that this call then deletes.
fn drop_key(key: &str, path: &Path) {
    let Ok(mut map) = chats().lock() else {
        return;
    };
    map.remove(key);
    if let Err(err) = fs::remove_file(path) {
        if err.kind() != std::io::ErrorKind::NotFound {
            // Swallowing this would show an empty room now and replay the
            // dead conversation on the next daemon start.
            eprintln!("[crew] could not remove {}: {err}", path.display());
        }
    }
}

pub fn messages(agent: &str) -> Vec<ChatMessage> {
    chats()
        .lock()
        .ok()
        .and_then(|m| m.get(agent).map(|c| c.messages.clone()))
        .unwrap_or_default()
}

pub fn last_ts(key: &str) -> u64 {
    messages(key).last().map(|m| m.ts).unwrap_or(0)
}

pub fn channel_last_ts(id: &str) -> u64 {
    last_ts(&channel_key(id))
}

pub fn preview(agent: &str) -> Option<String> {
    let msgs = messages(agent);
    let last = msgs.last()?;
    let mut t: String = crate::rows::display_text(last)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if t.is_empty() {
        t = last
            .choice
            .as_ref()
            .and_then(|c| c.questions.first())
            .map(|q| q.question.clone())
            .unwrap_or_default();
    }
    if t.is_empty() {
        return None;
    }
    let clipped: String = t.chars().take(48).collect();
    if t.chars().count() > 48 {
        Some(format!("{clipped}…"))
    } else {
        Some(clipped)
    }
}

pub fn push_user(agent: &str, from: &str, text: &str) -> ChatMessage {
    push_role(agent, Role::User, from, text, true, None)
}

pub fn push_system(agent: &str, from: &str, text: &str) -> ChatMessage {
    push_role(
        agent,
        Role::System,
        from,
        text,
        true,
        infer_system_kind(from),
    )
}

/// System row that must not open a turn, e.g. a "sent to other session" receipt.
pub fn push_notice(agent: &str, from: &str, text: &str) -> ChatMessage {
    push_role(
        agent,
        Role::System,
        from,
        text,
        false,
        Some(MessageKind::Sent),
    )
}

pub fn push_handoff(agent: &str, from: &str, text: &str) -> ChatMessage {
    push_role(
        agent,
        Role::System,
        from,
        text,
        false,
        Some(MessageKind::Handoff),
    )
}

/// One row per tool call. `call_id` is the CLI's id for the call: later events
/// for the same id fill the same card in instead of stacking another row.
pub fn push_tool(agent: &str, call_id: Option<&str>, name: &str, detail: &str) -> ChatMessage {
    let pinned_ask = is_pinned_ask(agent, call_id);
    if crate::choice::is_ask_tool(name) || pinned_ask {
        if let Some(card) = crate::choice::from_tool_detail(detail) {
            return attach_choice(agent, call_id, card);
        }
        pin_ask_tool(agent, call_id);
        if detail.is_empty() {
            return ChatMessage {
                id: String::new(),
                role: Role::System,
                from: name.to_string(),
                text: String::new(),
                ts: now_ms(),
                queued: false,
                kind: Some(MessageKind::Tool),
                approval: None,
                choice: None,
            };
        }
        // Unrecognised payload: still show a tool row so the turn isn't silent.
    } else if name.is_empty() {
        if let Some(card) = crate::choice::from_tool_detail(detail) {
            return attach_choice(agent, call_id, card);
        }
    }
    let mut msg = ChatMessage {
        id: new_id(),
        role: Role::System,
        from: name.to_string(),
        text: detail.to_string(),
        ts: now_ms(),
        queued: false,
        kind: Some(MessageKind::Tool),
        approval: None,
        choice: None,
    };
    if let Ok(mut map) = chats().lock() {
        let chat = map
            .entry(agent.to_string())
            .or_insert_with(AgentChat::empty);
        let call_id = call_id.filter(|id| !id.is_empty());
        let known = call_id
            .and_then(|id| chat.tool_ids.get(id).cloned())
            .and_then(|mid| chat.messages.iter().position(|m| m.id == mid));
        if let Some(idx) = known {
            let row = &mut chat.messages[idx];
            if !name.is_empty() {
                row.from = name.to_string();
            }
            if !detail.is_empty() {
                row.text = detail.to_string();
            }
            msg = row.clone();
            persist(agent, chat);
        } else {
            if let Some(id) = call_id {
                chat.tool_ids.insert(id.to_string(), msg.id.clone());
            }
            if let Some(idx) = chat.pending_idx {
                chat.messages.insert(idx, msg.clone());
                chat.pending_idx = Some(idx + 1);
            } else {
                chat.messages.push(msg.clone());
            }
            persist(agent, chat);
        }
    }
    emit(agent, msg.clone());
    msg
}

/// Attach a picker to the in-flight assistant row, or open a new one.
fn is_pinned_ask(agent: &str, call_id: Option<&str>) -> bool {
    let Some(id) = call_id.filter(|s| !s.is_empty()) else {
        return false;
    };
    let Ok(map) = chats().lock() else {
        return false;
    };
    let Some(chat) = map.get(agent) else {
        return false;
    };
    chat.tool_ids
        .get(id)
        .and_then(|mid| chat.messages.iter().find(|m| &m.id == mid))
        .map(|m| m.choice.is_some() || m.role == Role::Assistant && m.kind.is_none())
        .unwrap_or(false)
}

fn pin_ask_tool(agent: &str, call_id: Option<&str>) {
    let Some(id) = call_id.filter(|s| !s.is_empty()) else {
        return;
    };
    let mut map = match chats().lock() {
        Ok(m) => m,
        Err(_) => return,
    };
    let chat = map
        .entry(agent.to_string())
        .or_insert_with(AgentChat::empty);
    if chat.tool_ids.contains_key(id) {
        return;
    }
    if let Some(idx) = chat.pending_idx {
        chat.tool_ids
            .insert(id.to_string(), chat.messages[idx].id.clone());
        return;
    }
    let m = ChatMessage {
        id: new_id(),
        role: Role::Assistant,
        from: agent.to_string(),
        text: String::new(),
        ts: now_ms(),
        queued: false,
        kind: None,
        approval: None,
        choice: None,
    };
    chat.messages.push(m.clone());
    chat.pending_idx = Some(chat.messages.len() - 1);
    chat.tool_ids.insert(id.to_string(), m.id);
}

pub fn attach_choice(agent: &str, call_id: Option<&str>, mut card: ChoiceCard) -> ChatMessage {
    if card.id.is_empty() {
        card.id = call_id
            .filter(|id| !id.is_empty())
            .map(|id| format!("{agent}:{id}"))
            .unwrap_or_else(new_id);
    }
    let msg = {
        let mut map = match chats().lock() {
            Ok(m) => m,
            Err(_) => {
                return ChatMessage {
                    id: String::new(),
                    role: Role::Assistant,
                    from: agent.to_string(),
                    text: String::new(),
                    ts: now_ms(),
                    queued: false,
                    kind: None,
                    approval: None,
                    choice: Some(card),
                };
            }
        };
        let chat = map
            .entry(agent.to_string())
            .or_insert_with(AgentChat::empty);
        let call_id = call_id.filter(|id| !id.is_empty());
        let known = call_id
            .and_then(|id| chat.tool_ids.get(id).cloned())
            .and_then(|mid| chat.messages.iter().position(|m| m.id == mid));
        let known_free = known.filter(|&idx| {
            chat.messages
                .get(idx)
                .and_then(|m| m.choice.as_ref())
                .map(|c| c.questions.is_empty() || c.id == card.id)
                .unwrap_or(true)
        });
        let pending = chat.pending_idx.filter(|&idx| {
            chat.messages
                .get(idx)
                .map(|row| {
                    row.choice
                        .as_ref()
                        .map(|c| c.questions.is_empty() || c.id == card.id)
                        .unwrap_or(true)
                })
                .unwrap_or(false)
        });
        let idx = known_free.or(pending);
        let out = if let Some(idx) = idx {
            let row = &mut chat.messages[idx];
            let keep = row
                .choice
                .as_ref()
                .map(|c| c.state == ChoiceState::Pending)
                .unwrap_or(true);
            if keep {
                if let Some(existing) = row.choice.as_ref() {
                    card.id = existing.id.clone();
                }
                row.choice = Some(card);
            }
            if let Some(id) = call_id {
                chat.tool_ids.insert(id.to_string(), row.id.clone());
            }
            row.clone()
        } else {
            let m = ChatMessage {
                id: new_id(),
                role: Role::Assistant,
                from: agent.to_string(),
                text: String::new(),
                ts: now_ms(),
                queued: false,
                kind: None,
                approval: None,
                choice: Some(card),
            };
            chat.messages.push(m.clone());
            if let Some(id) = call_id {
                chat.tool_ids.insert(id.to_string(), m.id.clone());
            }
            m
        };
        persist(agent, chat);
        out
    };
    if !msg.id.is_empty() {
        emit(agent, msg.clone());
    }
    msg
}

pub fn set_choice(key: &str, message_id: &str, card: ChoiceCard) {
    let msg = {
        let mut map = match chats().lock() {
            Ok(m) => m,
            Err(_) => return,
        };
        let Some(chat) = map.get_mut(key) else {
            return;
        };
        let Some(m) = chat.messages.iter_mut().rev().find(|m| m.id == message_id) else {
            return;
        };
        m.choice = Some(card);
        let out = m.clone();
        persist(key, chat);
        out
    };
    emit_row(key, msg);
}

pub fn resolve_choice(
    agent: &str,
    choice_id: &str,
    answers: &[Vec<String>],
    values: &[Vec<String>],
    closed: bool,
) -> Option<ChoiceCard> {
    let mut updated: Option<ChoiceCard> = None;
    let mut emit_rows: Vec<(String, ChatMessage)> = Vec::new();
    if let Ok(mut map) = chats().lock() {
        for (key, chat) in map.iter_mut() {
            let mut dirty = false;
            for m in chat.messages.iter_mut() {
                let Some(card) = m.choice.as_mut() else {
                    continue;
                };
                if card.id != choice_id {
                    continue;
                }
                if m.from != agent && key != agent {
                    continue;
                }
                crate::choice::apply_answers(card, answers, values, closed);
                updated = Some(card.clone());
                emit_rows.push((key.clone(), m.clone()));
                dirty = true;
            }
            if dirty {
                persist(key, chat);
            }
        }
    }
    for (key, msg) in emit_rows {
        emit_row(&key, msg);
    }
    updated
}

pub fn pending_message_id(agent: &str) -> Option<String> {
    let map = chats().lock().ok()?;
    let chat = map.get(agent)?;
    let idx = chat.pending_idx?;
    chat.messages.get(idx).map(|m| m.id.clone())
}

pub fn choice_by_message(key: &str, message_id: &str) -> Option<ChatMessage> {
    messages(key)
        .into_iter()
        .rev()
        .find(|m| m.id == message_id && m.choice.is_some())
}

pub fn close_pending_choices(agent: &str) -> Vec<String> {
    let ids: Vec<String> = messages(agent)
        .into_iter()
        .filter_map(|m| {
            m.choice.and_then(|c| {
                if c.state == ChoiceState::Pending {
                    Some(c.id)
                } else {
                    None
                }
            })
        })
        .collect();
    for id in &ids {
        let _ = resolve_choice(agent, id, &[], &[], true);
    }
    ids
}

pub fn all_messages() -> Vec<(String, ChatMessage)> {
    let map = match chats().lock() {
        Ok(m) => m,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    for (key, chat) in map.iter() {
        for m in &chat.messages {
            out.push((key.clone(), m.clone()));
        }
    }
    out
}

pub fn push_routine(agent: &str, name: &str, text: &str) -> ChatMessage {
    push_role(
        agent,
        Role::System,
        name,
        text,
        true,
        Some(MessageKind::Routine),
    )
}

fn infer_system_kind(from: &str) -> Option<MessageKind> {
    if from.starts_with("to:") {
        Some(MessageKind::Sent)
    } else if from.starts_with('#') {
        Some(MessageKind::Received)
    } else {
        Some(MessageKind::Received)
    }
}

/// Record injected PTY/prompt text so local echo is not stored as assistant output.
pub fn expect_echo(agent: &str, text: &str) {
    let mut t = normalize_text(text);
    if !t.is_empty() && !t.ends_with('\n') {
        t.push('\n');
    }
    if let Ok(mut map) = chats().lock() {
        if let Some(chat) = map.get_mut(agent) {
            chat.echo_skip = t;
        }
    }
}

pub fn channel_messages(id: &str) -> Vec<ChatMessage> {
    messages(&channel_key(id))
}

pub fn channel_preview(id: &str) -> Option<String> {
    preview(&channel_key(id))
}

pub fn push_channel(id: &str, role: Role, from: &str, text: &str) -> ChatMessage {
    let key = channel_key(id);
    let kind = match role {
        Role::System => infer_system_kind(from),
        _ => None,
    };
    let msg = push_role(&key, role, from, text, false, kind);
    let _ = crate::daemon::events().send(Event::ChannelMessage {
        channel: id.to_string(),
        message: msg.clone(),
    });
    msg
}

fn push_role(
    agent: &str,
    role: Role,
    from: &str,
    text: &str,
    expect: bool,
    kind: Option<MessageKind>,
) -> ChatMessage {
    seal_now(agent);
    let msg = ChatMessage {
        id: new_id(),
        role,
        from: from.to_string(),
        text: text.to_string(),
        ts: now_ms(),
        queued: false,
        kind,
        approval: None,
        choice: None,
    };
    if let Ok(mut map) = chats().lock() {
        let chat = map
            .entry(agent.to_string())
            .or_insert_with(AgentChat::empty);
        chat.messages.push(msg.clone());
        chat.expecting = expect;
        chat.pending_idx = None;
        chat.dirty = false;
        chat.last_byte = Instant::now();
        persist(agent, chat);
    }
    if !agent.starts_with("ch:") {
        emit(agent, msg.clone());
    }
    msg
}

pub fn set_approval(agent: &str, id: &str, state: ApprovalState) {
    let msg = {
        let mut map = match chats().lock() {
            Ok(m) => m,
            Err(_) => return,
        };
        let Some(chat) = map.get_mut(agent) else {
            return;
        };
        let Some(m) = chat.messages.iter_mut().rev().find(|m| m.id == id) else {
            return;
        };
        if m.approval == Some(state) {
            return;
        }
        m.approval = Some(state);
        let out = m.clone();
        persist(agent, chat);
        out
    };
    emit(agent, msg);
}

pub fn pending_approval(agent: &str) -> Option<ChatMessage> {
    messages(agent)
        .into_iter()
        .rev()
        .find(|m| m.approval == Some(ApprovalState::Pending))
}

pub fn set_queued(agent: &str, id: &str, queued: bool) {
    let msg = {
        let mut map = match chats().lock() {
            Ok(m) => m,
            Err(_) => return,
        };
        let Some(chat) = map.get_mut(agent) else {
            return;
        };
        let Some(m) = chat.messages.iter_mut().rev().find(|m| m.id == id) else {
            return;
        };
        if m.queued == queued {
            return;
        }
        m.queued = queued;
        let out = m.clone();
        persist(agent, chat);
        out
    };
    emit(agent, msg);
}

pub fn cancel_expect(agent: &str) {
    if let Ok(mut map) = chats().lock() {
        if let Some(chat) = map.get_mut(agent) {
            chat.expecting = false;
            chat.echo_skip.clear();
        }
    }
}

pub fn begin_turn(agent: &str) -> u64 {
    if let Ok(mut map) = chats().lock() {
        let chat = map
            .entry(agent.to_string())
            .or_insert_with(AgentChat::empty);
        chat.turn_gen = chat.turn_gen.wrapping_add(1);
        chat.tool_ids.clear();
        chat.expecting = true;
        chat.hold = true;
        chat.last_byte = Instant::now();
        return chat.turn_gen;
    }
    0
}

pub fn end_turn(agent: &str) {
    end_turn_gen(agent, None);
}

/// Seal this turn only. `Some(gen)` is a no-op if a newer `begin_turn` already
/// started, so a cancelled headless thread cannot drop the successor's output.
pub fn end_turn_gen(agent: &str, gen: Option<u64>) {
    if let Some(g) = gen {
        let skip = chats()
            .lock()
            .ok()
            .and_then(|m| m.get(agent).map(|c| c.turn_gen != g))
            .unwrap_or(true);
        if skip {
            return;
        }
    }
    if let Ok(mut map) = chats().lock() {
        if let Some(chat) = map.get_mut(agent) {
            chat.hold = false;
        }
    }
    seal_now(agent);
}

pub fn on_assistant_delta(agent: &str, chunk: &str) {
    if chunk.is_empty() {
        return;
    }
    on_pty_bytes(agent, chunk.as_bytes());
}

pub fn set_pending_assistant(agent: &str, text: &str) {
    let msg = {
        let mut map = match chats().lock() {
            Ok(m) => m,
            Err(_) => return,
        };
        let Some(chat) = map.get_mut(agent) else {
            return;
        };
        if !chat.expecting && chat.pending_idx.is_none() {
            return;
        }
        let cleaned = normalize_text(&strip_ansi(text));
        let cleaned = strip_prefix_echo(&chat.echo_skip, &cleaned);
        let had_marker = cleaned.lines().any(is_crew_marker_line);
        let cleaned = strip_crew_markers(&cleaned);
        if cleaned.is_empty() || (had_marker && is_inbound_echo(chat, &cleaned)) {
            return;
        }
        chat.last_byte = Instant::now();
        if let Some(idx) = chat.pending_idx {
            chat.messages[idx].text = cleaned;
            chat.messages[idx].ts = now_ms();
            if chat.last_emit.elapsed() >= EMIT_INTERVAL {
                chat.last_emit = Instant::now();
                chat.dirty = false;
                Some(chat.messages[idx].clone())
            } else {
                chat.dirty = true;
                None
            }
        } else {
            let m = ChatMessage {
                id: new_id(),
                role: Role::Assistant,
                from: agent.to_string(),
                text: cleaned,
                ts: now_ms(),
                queued: false,
                kind: None,
                approval: None,
                choice: None,
            };
            chat.messages.push(m.clone());
            chat.pending_idx = Some(chat.messages.len() - 1);
            chat.last_emit = Instant::now();
            chat.dirty = false;
            Some(m)
        }
    };
    if let Some(msg) = msg {
        emit(agent, msg);
    }
}

pub fn on_pty_bytes(agent: &str, bytes: &[u8]) {
    let msg = {
        let mut map = match chats().lock() {
            Ok(m) => m,
            Err(_) => return,
        };
        let Some(chat) = map.get_mut(agent) else {
            return;
        };
        if !chat.expecting && chat.pending_idx.is_none() {
            return;
        }
        chat.utf8_tail.extend_from_slice(bytes);
        let data = std::mem::take(&mut chat.utf8_tail);
        let (raw, rest) = decode_utf8_keep_tail(&data);
        chat.utf8_tail = rest;
        chat.last_byte = Instant::now();
        let raw = normalize_text(&strip_ansi(&raw));
        let raw = consume_echo(&mut chat.echo_skip, &raw);
        let had_marker = raw.lines().any(is_crew_marker_line);
        let cleaned = strip_crew_markers(&raw);
        if cleaned.is_empty() || (had_marker && is_inbound_echo(chat, &cleaned)) {
            return;
        }
        if let Some(idx) = chat.pending_idx {
            chat.messages[idx].text.push_str(&cleaned);
            let combined = strip_crew_markers(&chat.messages[idx].text);
            chat.messages[idx].text = combined.clone();
            if combined.is_empty() || (had_marker && is_inbound_echo(chat, &combined)) {
                if had_marker && is_inbound_echo(chat, &combined) {
                    chat.messages[idx].text.clear();
                }
                return;
            }
            chat.messages[idx].ts = now_ms();
            if chat.last_emit.elapsed() >= EMIT_INTERVAL {
                chat.last_emit = Instant::now();
                chat.dirty = false;
                Some(chat.messages[idx].clone())
            } else {
                chat.dirty = true;
                None
            }
        } else {
            let m = ChatMessage {
                id: new_id(),
                role: Role::Assistant,
                from: agent.to_string(),
                text: cleaned,
                ts: now_ms(),
                queued: false,
                kind: None,
                approval: None,
                choice: None,
            };
            chat.messages.push(m.clone());
            chat.pending_idx = Some(chat.messages.len() - 1);
            chat.last_emit = Instant::now();
            chat.dirty = false;
            Some(m)
        }
    };
    if let Some(msg) = msg {
        emit(agent, msg);
    }
}

pub fn tick() {
    flush_dirty_all();
    maybe_seal_all();
}

fn flush_dirty_all() {
    let agents: Vec<String> = match chats().lock() {
        Ok(m) => m.keys().cloned().collect(),
        Err(_) => return,
    };
    for agent in agents {
        let msg = {
            let mut map = match chats().lock() {
                Ok(m) => m,
                Err(_) => return,
            };
            let Some(chat) = map.get_mut(&agent) else {
                continue;
            };
            if !chat.dirty {
                continue;
            }
            let Some(idx) = chat.pending_idx else {
                chat.dirty = false;
                continue;
            };
            if chat.last_emit.elapsed() < EMIT_INTERVAL {
                continue;
            }
            chat.last_emit = Instant::now();
            chat.dirty = false;
            Some(chat.messages[idx].clone())
        };
        if let Some(msg) = msg {
            emit(&agent, msg);
        }
    }
}

pub fn maybe_seal_all() {
    let agents: Vec<String> = match chats().lock() {
        Ok(m) => m.keys().cloned().collect(),
        Err(_) => return,
    };
    for agent in agents {
        maybe_seal(&agent);
    }
}

pub fn seal_all_now() {
    let agents: Vec<String> = match chats().lock() {
        Ok(m) => m.keys().cloned().collect(),
        Err(_) => return,
    };
    for agent in agents {
        seal_now(&agent);
    }
}

pub fn seal_agent(agent: &str) {
    seal_now(agent);
}

fn maybe_seal(agent: &str) {
    let emitted = {
        let mut map = match chats().lock() {
            Ok(m) => m,
            Err(_) => return,
        };
        let Some(chat) = map.get_mut(agent) else {
            return;
        };
        if chat.hold {
            return;
        }
        if chat.pending_idx.is_none() {
            if chat.expecting && chat.last_byte.elapsed() > EXPECT_TIMEOUT {
                chat.expecting = false;
                chat.echo_skip.clear();
            }
            return;
        }
        if chat.last_byte.elapsed() < SEAL_IDLE {
            return;
        }
        finish_pending(agent, chat)
    };
    if let Some(msg) = emitted {
        emit_sealed(agent, msg);
    }
}

fn seal_now(agent: &str) {
    let emitted = {
        let mut map = match chats().lock() {
            Ok(m) => m,
            Err(_) => return,
        };
        let Some(chat) = map.get_mut(agent) else {
            return;
        };
        finish_pending(agent, chat)
    };
    if let Some(msg) = emitted {
        emit_sealed(agent, msg);
    }
}

fn finish_pending(agent: &str, chat: &mut AgentChat) -> Option<ChatMessage> {
    chat.hold = false;
    let Some(idx) = chat.pending_idx.take() else {
        chat.expecting = false;
        chat.dirty = false;
        chat.echo_skip.clear();
        return None;
    };
    chat.dirty = false;
    chat.echo_skip.clear();
    chat.messages[idx].text = strip_crew_markers(&chat.messages[idx].text)
        .trim_end()
        .to_string();
    chat.expecting = false;
    if chat.messages[idx].choice.is_none() {
        let (rest, parsed) = crate::choice::split_from_text(&chat.messages[idx].text);
        if let Some(mut card) = parsed {
            if card.id.is_empty() {
                card.id = chat.messages[idx].id.clone();
            }
            chat.messages[idx].choice = Some(card);
            chat.messages[idx].text = rest;
        }
    }
    if chat.messages[idx].text.is_empty() && chat.messages[idx].choice.is_none() {
        chat.messages.remove(idx);
        persist(agent, chat);
        return None;
    }
    persist(agent, chat);
    Some(chat.messages[idx].clone())
}

pub fn archive_and_clear(agent: &str, archive_dir: &Path) -> anyhow::Result<()> {
    seal_now(agent);
    let src = paths::transcript_path(agent);
    fs::create_dir_all(archive_dir)?;
    if src.exists() {
        fs::copy(&src, archive_dir.join("messages.jsonl"))?;
    } else {
        fs::write(archive_dir.join("messages.jsonl"), "")?;
    }
    if let Ok(mut map) = chats().lock() {
        map.insert(agent.to_string(), AgentChat::empty());
    }
    if let Some(parent) = src.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(src, "")?;
    Ok(())
}

fn redact_secrets(m: &mut ChatMessage) {
    let Some(card) = m.choice.as_mut() else {
        return;
    };
    for q in &mut card.questions {
        for f in &mut q.fields {
            if f.secret {
                f.value.clear();
            }
        }
    }
}

fn persist(agent: &str, chat: &AgentChat) {
    let path = persist_path(agent);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let mut out = String::new();
    for m in &chat.messages {
        let mut stored = m.clone();
        stored.queued = false;
        redact_secrets(&mut stored);
        if let Ok(line) = serde_json::to_string(&stored) {
            out.push_str(&line);
            out.push('\n');
        }
    }
    let _ = fs::write(path, out);
}

fn emit(agent: &str, message: ChatMessage) {
    let _ = crate::daemon::events().send(Event::Message {
        agent: agent.to_string(),
        message,
    });
}

fn emit_row(key: &str, message: ChatMessage) {
    if let Some(channel) = key.strip_prefix("ch:") {
        let _ = crate::daemon::events().send(Event::ChannelMessage {
            channel: channel.to_string(),
            message,
        });
    } else {
        emit(key, message);
    }
}

fn emit_sealed(agent: &str, message: ChatMessage) {
    emit(agent, message.clone());
    if let Some(hook) = SEAL_HOOK.get() {
        hook(agent, &message);
    }
}

fn decode_utf8_keep_tail(buf: &[u8]) -> (String, Vec<u8>) {
    match std::str::from_utf8(buf) {
        Ok(s) => (s.to_string(), Vec::new()),
        Err(e) => {
            let valid = e.valid_up_to();
            let s = String::from_utf8_lossy(&buf[..valid]).into_owned();
            if e.error_len().is_some() {
                let rest_start = (valid + 1).min(buf.len());
                let (more, tail) = decode_utf8_keep_tail(&buf[rest_start..]);
                (format!("{s}\u{fffd}{more}"), tail)
            } else {
                (s, buf[valid..].to_vec())
            }
        }
    }
}

fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            match chars.peek().copied() {
                Some('[') => {
                    chars.next();
                    for n in chars.by_ref() {
                        if n.is_ascii_alphabetic() || n == '~' {
                            break;
                        }
                    }
                }
                Some(']') => {
                    chars.next();
                    while let Some(n) = chars.next() {
                        if n == '\u{07}' {
                            break;
                        }
                        if n == '\u{1b}' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                Some(_) => {
                    chars.next();
                }
                None => {}
            }
            continue;
        }
        if matches!(c, '\u{07}' | '\u{08}' | '\u{00}') {
            continue;
        }
        out.push(c);
    }
    out
}

fn normalize_text(s: &str) -> String {
    s.replace("\r\n", "\n").replace('\r', "\n")
}

fn last_inbound_text(chat: &AgentChat) -> Option<&str> {
    chat.messages.iter().enumerate().rev().find_map(|(i, m)| {
        if chat.pending_idx == Some(i) || m.role == Role::Assistant {
            None
        } else {
            Some(m.text.as_str())
        }
    })
}

fn is_inbound_echo(chat: &AgentChat, text: &str) -> bool {
    let Some(src) = last_inbound_text(chat)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return false;
    };
    let mut any = false;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        any = true;
        if line != src {
            return false;
        }
    }
    any
}

fn common_prefix_bytes(a: &str, b: &str) -> usize {
    let mut len = 0;
    for (ca, cb) in a.chars().zip(b.chars()) {
        if ca != cb {
            break;
        }
        len += ca.len_utf8();
    }
    len
}

fn strip_prefix_echo(echo: &str, incoming: &str) -> String {
    if echo.is_empty() {
        return incoming.to_string();
    }
    if incoming.starts_with(echo) {
        incoming[echo.len()..].to_string()
    } else {
        incoming.to_string()
    }
}

fn consume_echo(pending: &mut String, incoming: &str) -> String {
    if pending.is_empty() {
        return incoming.to_string();
    }
    if incoming.is_empty() {
        return String::new();
    }
    let n = common_prefix_bytes(pending, incoming);
    if n == 0 || (n < pending.len() && n < incoming.len()) {
        pending.clear();
        return incoming.to_string();
    }
    if n == pending.len() {
        pending.clear();
        return incoming[n..].to_string();
    }
    pending.replace_range(..n, "");
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_csi_and_cr() {
        let raw = "\u{1b}[31mhello\u{1b}[0m\r\nworld\r";
        assert_eq!(normalize_text(&strip_ansi(raw)), "hello\nworld\n");
    }

    #[test]
    fn dropping_an_agent_deletes_its_transcript_file() {
        crate::paths::testing::with_home("transcript-drop", || {
            // Unique like every other id in this module: `CHATS` is
            // process-wide and the suite runs in parallel.
            let agent = &format!(
                "drop-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            );
            push_user(agent, "user", "old session");
            let path = paths::transcript_path(agent);
            assert!(path.exists(), "transcript should persist");
            drop_agent(agent);
            assert!(!path.exists(), "a removed agent must not leave its file");
            // A later agent reusing the id starts empty.
            load_agent(agent);
            assert!(messages(agent).is_empty());
            drop_agent(agent);
        });
    }

    #[test]
    fn dropping_a_channel_deletes_its_transcript_file() {
        crate::paths::testing::with_home("transcript-drop-room", || {
            let ch = "designroom";
            push_channel(ch, Role::User, "someone", "old room");
            let path = paths::channel_transcript_path(ch);
            assert!(path.exists(), "channel transcript should persist");
            drop_channel(ch);
            assert!(!path.exists(), "a removed room must not leave its file");
            load_channel(ch);
            assert!(channel_messages(ch).is_empty());
        });
    }

    #[test]
    fn an_agent_id_starting_with_ch_leaves_the_room_alone() {
        crate::paths::testing::with_home("transcript-drop-ch", || {
            // `ch:` is how a channel is keyed internally, and the CLI takes an
            // id verbatim. Deriving the path from the key would read this
            // agent as the room and unlink the room's file.
            push_channel("general", Role::User, "someone", "room talk");
            let room = paths::channel_transcript_path("general");
            assert!(room.exists());
            push_user("ch:general", "user", "not a room");
            drop_agent("ch:general");
            assert!(room.exists(), "dropping an agent must not unlink a room");
            drop_channel("general");
            assert!(!room.exists());
        });
    }

    #[test]
    fn last_ts_tracks_latest_message() {
        let agent = format!(
            "ts-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        drop_agent(&agent);
        assert_eq!(last_ts(&agent), 0);
        let msg = push_user(&agent, "user", "hi");
        assert_eq!(last_ts(&agent), msg.ts);
        assert!(msg.ts > 0);
        drop_agent(&agent);
    }

    #[test]
    fn tool_events_sharing_a_call_id_stay_one_row() {
        let agent = format!(
            "tool-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        drop_agent(&agent);
        begin_turn(&agent);
        let opened = push_tool(&agent, Some("call-1"), "Read", "");
        push_tool(&agent, Some("call-1"), "", "{\"file_path\":\"/tmp/a.rs\"}");
        push_tool(&agent, Some("call-2"), "Bash", "{\"command\":\"ls\"}");
        let rows: Vec<_> = messages(&agent)
            .into_iter()
            .filter(|m| m.kind == Some(MessageKind::Tool))
            .collect();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, opened.id);
        assert_eq!(rows[0].from, "Read");
        assert!(rows[0].text.contains("/tmp/a.rs"));
        assert_eq!(rows[1].from, "Bash");
        // A new turn must not fold into the previous turn's card.
        begin_turn(&agent);
        push_tool(&agent, Some("call-1"), "Read", "{}");
        assert_eq!(
            messages(&agent)
                .iter()
                .filter(|m| m.kind == Some(MessageKind::Tool))
                .count(),
            3
        );
        drop_agent(&agent);
    }

    #[test]
    fn pending_assistant_reuses_id_before_seal() {
        let agent = format!(
            "stream-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        drop_agent(&agent);
        push_user(&agent, "user", "hi");
        on_pty_bytes(&agent, b"hel");
        let first = messages(&agent);
        assert_eq!(first.last().unwrap().role, Role::Assistant);
        assert_eq!(first.last().unwrap().text, "hel");
        let id = first.last().unwrap().id.clone();
        on_pty_bytes(&agent, b"lo");
        let second = messages(&agent);
        assert_eq!(second.last().unwrap().id, id);
        assert_eq!(second.last().unwrap().text, "hello");
        seal_now(&agent);
        let sealed = messages(&agent);
        assert_eq!(sealed.last().unwrap().id, id);
        assert_eq!(sealed.last().unwrap().text, "hello");
        drop_agent(&agent);
    }

    #[test]
    fn hold_skips_idle_seal_until_end_turn() {
        let agent = format!(
            "hold-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        drop_agent(&agent);
        push_user(&agent, "user", "hi");
        begin_turn(&agent);
        on_assistant_delta(&agent, "hel");
        {
            let mut map = chats().lock().unwrap();
            map.get_mut(&agent).unwrap().last_byte = Instant::now() - Duration::from_secs(5);
        }
        maybe_seal(&agent);
        let mid = messages(&agent);
        assert_eq!(mid.last().unwrap().text, "hel");
        on_assistant_delta(&agent, "lo");
        end_turn(&agent);
        let sealed = messages(&agent);
        assert_eq!(sealed.last().unwrap().text, "hello");
        drop_agent(&agent);
    }

    #[test]
    fn cancelled_end_turn_does_not_drop_successor_output() {
        let agent = format!(
            "stale-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        drop_agent(&agent);
        push_user(&agent, "user", "first");
        let g1 = begin_turn(&agent);
        on_assistant_delta(&agent, "old");
        end_turn(&agent);
        assert_eq!(messages(&agent).last().unwrap().text, "old");
        push_user(&agent, "user", "second");
        let g2 = begin_turn(&agent);
        end_turn_gen(&agent, Some(g1));
        on_assistant_delta(&agent, "new reply");
        end_turn_gen(&agent, Some(g2));
        let sealed = messages(&agent);
        let last = sealed.last().unwrap();
        assert_eq!(last.role, Role::Assistant);
        assert_eq!(last.text, "new reply");
        drop_agent(&agent);
    }

    #[test]
    fn jsonl_roundtrip_shape() {
        let msg = ChatMessage {
            id: "a".into(),
            role: Role::System,
            from: "alpha".into(),
            text: "hi".into(),
            ts: 9,
            queued: false,
            kind: None,
            approval: None,
            choice: None,
        };
        let line = serde_json::to_string(&msg).unwrap();
        assert!(!line.contains("queued"), "{line}");
        let back: ChatMessage = serde_json::from_str(&line).unwrap();
        assert_eq!(back.from, "alpha");
        assert_eq!(back.role, Role::System);
        assert!(!back.queued);
    }

    #[test]
    fn push_notice_does_not_expect_a_turn() {
        let agent = format!(
            "notice-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        drop_agent(&agent);
        let msg = push_notice(&agent, "to:pm", "hello");
        assert_eq!(msg.role, Role::System);
        assert_eq!(msg.from, "to:pm");
        assert_eq!(msg.text, "hello");
        {
            let map = chats().lock().unwrap();
            let chat = map.get(&agent).unwrap();
            assert!(!chat.expecting);
        }
        drop_agent(&agent);
    }

    #[test]
    fn set_queued_toggles_in_memory() {
        let agent = format!(
            "queued-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        drop_agent(&agent);
        let msg = push_system(&agent, "alpha", "wait");
        assert!(!msg.queued);
        set_queued(&agent, &msg.id, true);
        assert!(messages(&agent).last().unwrap().queued);
        let line = serde_json::to_string(&{
            let mut stored = messages(&agent).last().unwrap().clone();
            stored.queued = false;
            stored
        })
        .unwrap();
        assert!(!line.contains("queued"), "{line}");
        set_queued(&agent, &msg.id, false);
        assert!(!messages(&agent).last().unwrap().queued);
        drop_agent(&agent);
    }

    #[test]
    fn strip_crew_marker_lines() {
        let raw = "[crew from:user]\n안녕?\n[crew from:user]\n안녕?";
        assert_eq!(strip_crew_markers(raw), "안녕?\n안녕?");
        assert_eq!(strip_crew_markers("[crew from:user]\n"), "");
        assert_eq!(
            strip_crew_markers("[crew channel:room from:alpha]\nhello"),
            "hello"
        );
        assert_eq!(
            strip_crew_markers("[crew system]\nTeammates: a"),
            "Teammates: a"
        );
        assert_eq!(
            strip_crew_markers("keep\n[crew from:x]\nthis"),
            "keep\nthis"
        );
    }

    #[test]
    fn deltas_starting_with_a_newline_keep_it() {
        // grok streams "\n\n" as its own chunk; swallowing it flattened whole
        // replies into one line and broke every ``` fence in them.
        assert_eq!(strip_crew_markers("\n"), "\n");
        assert_eq!(strip_crew_markers("\n\n**ls -1**"), "\n\n**ls -1**");
        let agent = format!(
            "nl-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        drop_agent(&agent);
        push_user(&agent, "user", "hi");
        on_assistant_delta(&agent, "```sh");
        on_assistant_delta(&agent, "\n");
        on_assistant_delta(&agent, "ls -1\n```");
        assert_eq!(messages(&agent).last().unwrap().text, "```sh\nls -1\n```");
        drop_agent(&agent);
    }

    #[test]
    fn consume_echo_skips_injected_envelope() {
        let mut pending = "[crew from:user]\n안녕?\n".to_string();
        assert_eq!(consume_echo(&mut pending, "[crew from:"), "");
        assert_eq!(pending, "user]\n안녕?\n");
        assert_eq!(consume_echo(&mut pending, "user]\n안녕?\nhello"), "hello");
        assert!(pending.is_empty());
    }

    #[test]
    fn envelope_echo_is_not_stored_as_assistant() {
        let agent = format!(
            "echo-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        drop_agent(&agent);
        push_system(&agent, "user", "안녕?");
        expect_echo(&agent, "[crew from:user]\n안녕?");
        on_pty_bytes(
            &agent,
            "[crew from:user]\n안녕?\n[crew from:user]\n안녕?".as_bytes(),
        );
        seal_now(&agent);
        let msgs = messages(&agent);
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].role, Role::System);
        assert_eq!(msgs[0].text, "안녕?");
        drop_agent(&agent);
    }

    #[test]
    fn ask_tool_becomes_a_choice_not_a_tool_row() {
        let agent = format!(
            "ask-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        drop_agent(&agent);
        begin_turn(&agent);
        on_assistant_delta(&agent, "이렇게 고를 수 있어.");
        push_tool(
            &agent,
            Some("call-q"),
            "ask_user_question",
            r#"{"questions":[{"question":"어느 쪽을 고를래?","options":[{"label":"A"},{"label":"B"},{"label":"C"}]}]}"#,
        );
        let msgs = messages(&agent);
        let last = msgs.last().unwrap();
        assert_eq!(last.role, Role::Assistant);
        assert_ne!(last.kind, Some(MessageKind::Tool));
        let card = last.choice.as_ref().expect("choice");
        assert_eq!(card.questions[0].question, "어느 쪽을 고를래?");
        assert_eq!(card.questions[0].options.len(), 3);
        let resolved = resolve_choice(&agent, &card.id, &[vec!["C".into()]], &[], false).unwrap();
        assert_eq!(resolved.state, crate::protocol::ChoiceState::Answered);
        assert_eq!(
            crate::choice::format_answer(&resolved),
            "어느 쪽을 고를래? → C"
        );
        drop_agent(&agent);
    }

    #[test]
    fn sealed_lettered_list_becomes_a_choice() {
        let agent = format!(
            "list-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        drop_agent(&agent);
        push_user(&agent, "user", "hi");
        on_assistant_delta(&agent, "어느 쪽을 고를래?\nA. A\nB. B\nC. C");
        seal_now(&agent);
        let last = messages(&agent).last().cloned().unwrap();
        assert!(last.text.is_empty(), "{}", last.text);
        let card = last.choice.expect("choice");
        assert_eq!(card.questions[0].question, "어느 쪽을 고를래?");
        assert_eq!(card.questions[0].options.len(), 3);
        drop_agent(&agent);
    }

    #[test]
    fn ask_tool_name_then_args_become_a_choice() {
        let agent = format!(
            "ask2-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        drop_agent(&agent);
        begin_turn(&agent);
        on_assistant_delta(&agent, "고를 수 있어.");
        push_tool(&agent, Some("call-q"), "AskUserQuestion", "");
        push_tool(
            &agent,
            Some("call-q"),
            "",
            r#"{"questions":[{"question":"어느 쪽을 고를래?","options":[{"label":"A"},{"label":"B"},{"label":"C"}]}]}"#,
        );
        let last = messages(&agent).last().cloned().unwrap();
        assert_eq!(last.role, Role::Assistant);
        assert_ne!(last.kind, Some(MessageKind::Tool));
        assert_eq!(
            last.choice.as_ref().unwrap().questions[0].question,
            "어느 쪽을 고를래?"
        );
        drop_agent(&agent);
    }

    #[test]
    fn ask_tool_fields_become_a_choice() {
        let agent = format!(
            "ask-in-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        drop_agent(&agent);
        begin_turn(&agent);
        push_tool(
            &agent,
            Some("call-in"),
            "AskUserQuestion",
            r#"{"question":"로그인","fields":[{"label":"아이디"},{"label":"비밀번호","type":"password"}]}"#,
        );
        let last = messages(&agent).last().cloned().unwrap();
        let card = last.choice.as_ref().expect("choice");
        assert_eq!(card.questions[0].question, "로그인");
        assert!(card.questions[0].options.is_empty());
        assert_eq!(card.questions[0].fields.len(), 2);
        assert!(card.questions[0].fields[1].secret);
        let resolved = resolve_choice(
            &agent,
            &card.id,
            &[],
            &[vec!["ada".into(), "s3cret".into()]],
            false,
        )
        .unwrap();
        assert_eq!(resolved.state, crate::protocol::ChoiceState::Answered);
        assert_eq!(
            crate::choice::format_answer(&resolved),
            "로그인\n아이디: ada\n비밀번호: s3cret"
        );
        drop_agent(&agent);
    }
}
