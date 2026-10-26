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
    /// The bot that asked for the turn in progress, if one did. The rows the
    /// turn adds carry it as their `peer`.
    peer: Option<String>,
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
            peer: None,
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
    paths::transcript_path(key)
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
                peer: None,
            },
        );
    }
}

pub fn load_agent(agent: &str) {
    load_key(agent, &paths::transcript_path(agent));
}

pub fn drop_agent(agent: &str) {
    drop_key(agent, &paths::transcript_path(agent));
}

/// Removal is final: forget the chat and its file, so an id reused by a
/// later agent of the same name does not inherit the old session.
///
/// The path is passed in rather than derived, so this agrees with
/// `load_agent` on where a key's file lives. The guard is held across the
/// unlink so a concurrent push cannot write a file that this call then deletes.
fn drop_key(key: &str, path: &Path) {
    let Ok(mut map) = chats().lock() else {
        return;
    };
    map.remove(key);
    if let Err(err) = fs::remove_file(path) {
        if err.kind() != std::io::ErrorKind::NotFound {
            // Swallowing this would show an empty chat now and replay the
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

/// When this chat last got something for the user. An exchange another bot
/// asked for is not, unless it left a card the user has to answer. Newest by
/// time, not by place: a reply being written stays above rows that land
/// meanwhile, and can finish after them.
pub fn last_ts(key: &str) -> u64 {
    messages(key)
        .iter()
        .filter(|m| m.peer.is_none() || m.choice.is_some() || m.approval.is_some())
        .map(|m| m.ts)
        .max()
        .unwrap_or(0)
}

/// The bot that asked for the turn starting here, or None for the user's own
/// and once a turn ends. Returns what it replaces, for a delivery that did not
/// go out.
pub fn set_peer(agent: &str, peer: Option<String>) -> Option<String> {
    let mut map = chats().lock().ok()?;
    let chat = map
        .entry(agent.to_string())
        .or_insert_with(AgentChat::empty);
    std::mem::replace(&mut chat.peer, peer)
}

pub fn preview(agent: &str) -> Option<String> {
    let msgs = messages(agent);
    // Newest balloon. A tool call is newer while it runs, and its text is the
    // arguments (`{ "command": ... }`), which was showing in the channel list.
    // A row that still has nothing to quote is skipped, so the balloon before
    // it stays up.
    msgs.iter()
        .filter_map(|m| preview_line(m).map(|line| (m.ts, line)))
        .max_by_key(|(ts, _)| *ts)
        .map(|(_, line)| line)
}

/// What the channel list can quote from one row. Tool arguments and a bare
/// JSON dump are not a sentence. A question on that row still is. A reply is
/// several balloons; the list quotes the last one. A message still waiting
/// has not gone out, so the line before it stays.
fn preview_line(msg: &ChatMessage) -> Option<String> {
    if msg.queued {
        return None;
    }
    if msg.kind == Some(MessageKind::Tool) && msg.choice.is_none() && msg.approval.is_none() {
        return None;
    }
    if is_subagent_note(msg) {
        return None;
    }
    let shown = crate::rows::display_text(msg);
    // The user's own row is one balloon, so it still starts at the beginning.
    let mut t = if msg.role == Role::User {
        one_line(&shown)
    } else {
        quote_last_balloon(&shown)
    };
    if t.is_empty() || (msg.role != Role::User && is_raw_payload(&t)) {
        t = msg
            .choice
            .as_ref()
            .and_then(|c| c.questions.first())
            .map(|q| q.question.clone())
            .unwrap_or_default();
    }
    if t.is_empty() || (msg.role != Role::User && is_raw_payload(&t)) {
        return None;
    }
    let clipped: String = t.chars().take(48).collect();
    if t.chars().count() > 48 {
        Some(format!("{clipped}…"))
    } else {
        Some(clipped)
    }
}

fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The last balloon worth quoting. A JSON value may contain a blank line, so
/// it is not one balloon; that value is still not a sentence.
fn quote_last_balloon(text: &str) -> String {
    if is_raw_payload(&one_line(text)) {
        return String::new();
    }
    let parts = balloons(text);
    let mut end = parts.len();
    while end > 0 {
        if let Some(start) = json_suffix(&parts[..end]) {
            end = start;
            continue;
        }
        let line = one_line(&parts[end - 1]);
        if line.is_empty() {
            end -= 1;
            continue;
        }
        return line;
    }
    String::new()
}

/// Where a trailing JSON object or array starts. Blank lines split one value
/// into several balloons, and the tail of that value is not itself JSON.
fn json_suffix(parts: &[String]) -> Option<usize> {
    let mut found = None;
    for start in (0..parts.len()).rev() {
        if is_raw_payload(&one_line(&parts[start..].join("\n\n"))) {
            found = Some(start);
        }
    }
    found
}

/// Balloons of one reply, matching `splitBubbles` in `ui/src/bubbles.ts`.
/// A blank line starts a balloon. A fence stays with the line above it, and
/// a balloon that is only a rule or link definitions is dropped.
fn balloons(text: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut lines: Vec<&str> = Vec::new();
    let mut fence: Option<(char, usize)> = None;
    let mut gap = false;
    for line in text.split('\n') {
        if let Some(open) = fence {
            if fence_closes(line, open) {
                fence = None;
            }
        } else if line.trim().is_empty() {
            gap = true;
        } else {
            let open = fence_opens(line);
            if gap && open.is_none() {
                push_balloon(&mut parts, &lines);
                lines.clear();
            }
            gap = false;
            if let Some(open) = open {
                fence = Some(open);
            }
        }
        lines.push(line);
    }
    push_balloon(&mut parts, &lines);
    if parts.is_empty() {
        let whole = text.trim();
        if !whole.is_empty() {
            parts.push(whole.to_string());
        }
    }
    parts
}

fn push_balloon(parts: &mut Vec<String>, lines: &[&str]) {
    let piece = lines.join("\n");
    let piece = piece.trim();
    if piece.is_empty() || is_rule(piece) || piece.split('\n').all(is_link_def) {
        return;
    }
    parts.push(piece.to_string());
}

fn fence_opens(line: &str) -> Option<(char, usize)> {
    let rest = line.trim_start_matches([' ', '\t']);
    let (mark, n) = mark_run(rest)?;
    // A ``` line with another backtick on it is inline code, not a fence.
    if mark == '`' && rest[n..].contains('`') {
        return None;
    }
    Some((mark, n))
}

fn fence_closes(line: &str, open: (char, usize)) -> bool {
    let rest = line.trim_start_matches([' ', '\t']);
    let Some((mark, n)) = mark_run(rest) else {
        return false;
    };
    mark == open.0 && n >= open.1 && rest[n..].chars().all(char::is_whitespace)
}

fn mark_run(rest: &str) -> Option<(char, usize)> {
    let mark = rest.chars().next()?;
    if mark != '`' && mark != '~' {
        return None;
    }
    let n = rest.chars().take_while(|c| *c == mark).count();
    (n >= 3).then_some((mark, n))
}

fn is_rule(piece: &str) -> bool {
    if piece.contains('\n') {
        return false;
    }
    let b = piece.as_bytes();
    let mut i = 0;
    while i < b.len() && i < 3 && b[i] == b' ' {
        i += 1;
    }
    if i >= b.len() {
        return false;
    }
    let mark = b[i];
    if !matches!(mark, b'-' | b'*' | b'_') {
        return false;
    }
    let mut marks = 0;
    while i < b.len() {
        if b[i] == mark {
            marks += 1;
        } else if b[i] != b' ' && b[i] != b'\t' {
            return false;
        }
        i += 1;
    }
    marks >= 3
}

fn is_link_def(line: &str) -> bool {
    let b = line.as_bytes();
    let mut i = 0;
    while i < b.len() && i < 3 && b[i] == b' ' {
        i += 1;
    }
    if i >= b.len() || b[i] != b'[' || b.get(i + 1) == Some(&b'^') {
        return false;
    }
    let Some(rel) = line[i + 1..].find(']') else {
        return false;
    };
    if rel == 0 {
        return false;
    }
    let Some(after) = line[i + 1 + rel + 1..].strip_prefix(':') else {
        return false;
    };
    after
        .trim_start_matches([' ', '\t'])
        .chars()
        .next()
        .is_some_and(|c| !c.is_whitespace())
}

fn is_raw_payload(text: &str) -> bool {
    let t = text.trim();
    if !(t.starts_with('{') || t.starts_with('[')) {
        return false;
    }
    matches!(
        serde_json::from_str::<serde_json::Value>(t),
        Ok(serde_json::Value::Object(_)) | Ok(serde_json::Value::Array(_))
    )
}

/// Characters of chat a CLI that joins mid-conversation reads before its first turn.
const RECAP_BUDGET: usize = 12_000;

/// The chat so far as `who: text` lines, oldest first, for a bot that moved
/// to another CLI. Tool rows and subagent notes are left out, and the newest
/// messages win when it runs long. None when there is nothing to read.
pub fn recap(agent: &str) -> Option<String> {
    recap_of(&messages(agent))
}

/// The chat before the rows in `skip`, which this turn is already sending.
/// Empty falls back to dropping only the last row, which is that message when
/// it has no id here. A prompt-mode CLI has no session, so the turn sends this
/// and then the new message.
pub fn prior_recap_excluding(agent: &str, skip: &[String]) -> Option<String> {
    excluding(&messages(agent), skip)
}

fn excluding(msgs: &[ChatMessage], skip: &[String]) -> Option<String> {
    if skip.is_empty() {
        return prior_of(msgs);
    }
    let kept: Vec<ChatMessage> = msgs
        .iter()
        .filter(|m| !skip.iter().any(|id| id == &m.id))
        .cloned()
        .collect();
    recap_of(&kept)
}

fn prior_of(msgs: &[ChatMessage]) -> Option<String> {
    let mut end = msgs.len();
    if let Some(last) = msgs.iter().rposition(|m| {
        !m.queued && m.kind != Some(MessageKind::Tool) && !is_subagent_note(m)
    }) {
        if msgs[last].role != Role::Assistant {
            end = last;
        }
    }
    recap_of(&msgs[..end])
}

fn recap_of(msgs: &[ChatMessage]) -> Option<String> {
    let mut lines = Vec::new();
    let mut used = 0;
    let mut cut = false;
    for msg in msgs.iter().rev() {
        if msg.queued || msg.kind == Some(MessageKind::Tool) || is_subagent_note(msg) {
            continue;
        }
        let text = crate::rows::display_text(msg);
        if text.is_empty() {
            continue;
        }
        let who = if msg.role == Role::Assistant {
            "assistant"
        } else {
            &msg.from
        };
        let line = format!("{who}: {text}");
        let len = line.chars().count();
        if used + len > RECAP_BUDGET {
            // The newest message alone is too long: its end is what comes next.
            if lines.is_empty() {
                let tail: String = text.chars().skip(len - RECAP_BUDGET).collect();
                lines.push(format!("{who}: (start left out) {tail}"));
            }
            cut = true;
            break;
        }
        used += len;
        lines.push(line);
    }
    if lines.is_empty() {
        return None;
    }
    if cut {
        lines.push("(earlier messages left out)".into());
    }
    lines.reverse();
    Some(lines.join("\n\n"))
}

pub fn push_user(agent: &str, from: &str, text: &str) -> ChatMessage {
    push_role(agent, Role::User, from, text, true, None, None)
}

/// `peer` is the bot that asked for the turn this row starts, if one did.
pub fn push_system(agent: &str, from: &str, text: &str, peer: Option<String>) -> ChatMessage {
    push_role(
        agent,
        Role::System,
        from,
        text,
        true,
        infer_system_kind(from),
        peer,
    )
}

/// System row that must not open a turn, e.g. a "sent to other session" receipt.
/// `peer` is the bot that asked for the turn it was sent from, if one did.
pub fn push_notice(agent: &str, from: &str, text: &str, peer: Option<String>) -> ChatMessage {
    push_role(
        agent,
        Role::System,
        from,
        text,
        false,
        Some(MessageKind::Sent),
        peer,
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
        None,
    )
}

/// Take back a row `agent` never heard: a handoff a tell went out in place of,
/// or a tell that did not go out in place of its reply.
pub fn remove_row(agent: &str, id: &str) {
    let Ok(mut map) = chats().lock() else {
        return;
    };
    let Some(chat) = map.get_mut(agent) else {
        return;
    };
    let Some(idx) = chat.messages.iter().rposition(|m| m.id == id) else {
        return;
    };
    chat.messages.remove(idx);
    // A reply `agent` is still writing sits after it.
    if let Some(p) = chat.pending_idx.filter(|&p| p > idx) {
        chat.pending_idx = Some(p - 1);
    }
    persist(agent, chat);
}

pub fn text_of(agent: &str, id: &str) -> Option<String> {
    let map = chats().lock().ok()?;
    let m = map.get(agent)?.messages.iter().rev().find(|m| m.id == id)?;
    Some(m.text.clone())
}

/// `id`'s new text, persisted and pushed to the window.
pub fn set_text(agent: &str, id: &str, text: &str) {
    let msg = {
        let Ok(mut map) = chats().lock() else {
            return;
        };
        let Some(chat) = map.get_mut(agent) else {
            return;
        };
        let Some(m) = chat.messages.iter_mut().rev().find(|m| m.id == id) else {
            return;
        };
        m.text = text.to_string();
        let msg = m.clone();
        persist(agent, chat);
        msg
    };
    emit(agent, msg);
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
                peer: None,
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
    push_in_turn(agent, call_id, name, detail, MessageKind::Tool)
}

/// A note between a bot and its subagent: the prompt (`to:sub:…`) or the
/// report (`sub:…`). A later report under the same `key` replaces the first.
pub fn push_subagent(agent: &str, key: &str, from: &str, text: &str) -> ChatMessage {
    let kind = if from.starts_with("to:") {
        MessageKind::Sent
    } else {
        MessageKind::Received
    };
    push_in_turn(agent, Some(key), from, text, kind)
}

/// A bot's talk with its own subagent. Like a tool call, it is how the bot
/// did its work, not something said to the user.
fn is_subagent_note(msg: &ChatMessage) -> bool {
    let from = msg.from.strip_prefix("to:").unwrap_or(&msg.from);
    from.starts_with("sub:")
}

/// A row from inside a turn, above the reply still being written, which stays
/// one bubble for the whole turn. Later events for the same `call_id` fill the
/// same row in instead of stacking another.
fn push_in_turn(
    agent: &str,
    call_id: Option<&str>,
    from: &str,
    text: &str,
    kind: MessageKind,
) -> ChatMessage {
    let mut msg = ChatMessage {
        id: new_id(),
        role: Role::System,
        from: from.to_string(),
        text: text.to_string(),
        ts: now_ms(),
        queued: false,
        peer: None,
        kind: Some(kind),
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
            if !from.is_empty() {
                row.from = from.to_string();
            }
            if !text.is_empty() {
                row.text = text.to_string();
            }
            msg = row.clone();
        } else {
            msg.peer = chat.peer.clone();
            if let Some(id) = call_id {
                chat.tool_ids.insert(id.to_string(), msg.id.clone());
            }
            if let Some(idx) = chat.pending_idx {
                chat.messages.insert(idx, msg.clone());
                chat.pending_idx = Some(idx + 1);
            } else {
                chat.messages.push(msg.clone());
            }
        }
        persist(agent, chat);
    }
    emit(agent, msg.clone());
    msg
}

fn choice_title(q: &crate::protocol::ChoiceQuestion) -> &str {
    let header = q.header.as_deref().unwrap_or("").trim();
    if header.is_empty() {
        q.question.trim()
    } else {
        header
    }
}

/// True when every title on `next` is already an open question on `open`.
fn same_pending_question(open: &crate::protocol::ChoiceCard, next: &crate::protocol::ChoiceCard) -> bool {
    if open.state != ChoiceState::Pending {
        return false;
    }
    let have: Vec<&str> = open.questions.iter().map(choice_title).filter(|t| !t.is_empty()).collect();
    let want: Vec<&str> = next.questions.iter().map(choice_title).filter(|t| !t.is_empty()).collect();
    !want.is_empty() && want.iter().all(|t| have.iter().any(|h| h == t))
}

/// The user already has this question open, so another ask must not add a card.
pub fn has_pending_question(agent: &str, question: &str) -> bool {
    let want = question.trim();
    if want.is_empty() {
        return false;
    }
    let Ok(map) = chats().lock() else {
        return false;
    };
    let Some(chat) = map.get(agent) else {
        return false;
    };
    chat.messages.iter().any(|m| {
        m.choice.as_ref().is_some_and(|c| {
            c.state == ChoiceState::Pending
                && c.questions.iter().any(|q| choice_title(q) == want)
        })
    })
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
        peer: chat.peer.clone(),
        kind: None,
        approval: None,
        choice: None,
    };
    chat.messages.push(m.clone());
    chat.pending_idx = Some(chat.messages.len() - 1);
    pin_queued_below_reply(chat);
    let Some(idx) = chat.pending_idx else {
        return;
    };
    chat.tool_ids
        .insert(id.to_string(), chat.messages[idx].id.clone());
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
                    peer: None,
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
        // The same question is already on screen. A retry must not stack a
        // second card the user has to answer again.
        if idx.is_none() {
            if let Some(open) = chat.messages.iter().rposition(|m| {
                m.choice
                    .as_ref()
                    .is_some_and(|c| same_pending_question(c, &card))
            }) {
                return chat.messages[open].clone();
            }
        }
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
                peer: chat.peer.clone(),
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
        None,
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

fn push_role(
    agent: &str,
    role: Role,
    from: &str,
    text: &str,
    expect: bool,
    kind: Option<MessageKind>,
    peer: Option<String>,
) -> ChatMessage {
    let msg = ChatMessage {
        id: new_id(),
        role,
        from: from.to_string(),
        text: text.to_string(),
        ts: now_ms(),
        queued: false,
        peer,
        kind,
        approval: None,
        choice: None,
    };
    let sealed = match chats().lock() {
        Ok(mut map) => {
            let chat = map
                .entry(agent.to_string())
                .or_insert_with(AgentChat::empty);
            // A headless turn still answering keeps its reply and its stream.
            // Sealing here split the reply around this row, and a row that
            // expects no turn left the rest of the reply nowhere to go.
            let sealed = if chat.hold {
                None
            } else {
                finish_pending(agent, chat)
            };
            chat.messages.push(msg.clone());
            if !chat.hold {
                chat.expecting = expect;
                chat.dirty = false;
                chat.last_byte = Instant::now();
            }
            persist(agent, chat);
            sealed
        }
        Err(_) => None,
    };
    if let Some(sealed) = sealed {
        emit_sealed(agent, sealed);
    }
    emit(agent, msg.clone());
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

/// The bot moved on without an allow or a deny: a new turn started, or it was
/// stopped. The card holds nothing back any more, and a click on it later
/// would answer a question nobody is waiting on.
pub fn drop_pending_approval(agent: &str) {
    let rows: Vec<ChatMessage> = {
        let mut map = match chats().lock() {
            Ok(m) => m,
            Err(_) => return,
        };
        let Some(chat) = map.get_mut(agent) else {
            return;
        };
        let mut rows = Vec::new();
        for m in chat.messages.iter_mut() {
            if m.approval == Some(ApprovalState::Pending) {
                m.approval = None;
                rows.push(m.clone());
            }
        }
        if !rows.is_empty() {
            persist(agent, chat);
        }
        rows
    };
    for row in rows {
        emit(agent, row);
    }
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
        // Memory only: the file never keeps it, and this runs under the inbox lock.
        m.queued = queued;
        m.clone()
    };
    emit(agent, msg);
}

pub fn cancel_expect(agent: &str) {
    if let Ok(mut map) = chats().lock() {
        if let Some(chat) = map.get_mut(agent) {
            // A delivery that failed on a bot mid-turn: the stream is that turn's.
            if chat.hold {
                return;
            }
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

/// A queued follow-up lands before the first token of the reply. Keep it
/// under that reply, or the next token draws the bot's chat beneath it.
fn pin_queued_below_reply(chat: &mut AgentChat) {
    let Some(pending) = chat.pending_idx else {
        return;
    };
    if pending >= chat.messages.len() {
        return;
    }
    if !chat.messages[..pending].iter().any(|m| m.queued) {
        return;
    }
    let id = chat.messages[pending].id.clone();
    let queued: Vec<_> = chat.messages.iter().filter(|m| m.queued).cloned().collect();
    chat.messages.retain(|m| !m.queued);
    chat.pending_idx = chat.messages.iter().position(|m| m.id == id);
    chat.messages.extend(queued);
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
            pin_queued_below_reply(chat);
            let Some(idx) = chat.pending_idx else {
                return;
            };
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
                peer: chat.peer.clone(),
                kind: None,
                approval: None,
                choice: None,
            };
            chat.messages.push(m);
            chat.pending_idx = Some(chat.messages.len() - 1);
            pin_queued_below_reply(chat);
            let Some(idx) = chat.pending_idx else {
                return;
            };
            chat.last_emit = Instant::now();
            chat.dirty = false;
            Some(chat.messages[idx].clone())
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
            pin_queued_below_reply(chat);
            let Some(idx) = chat.pending_idx else {
                return;
            };
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
                peer: chat.peer.clone(),
                kind: None,
                approval: None,
                choice: None,
            };
            chat.messages.push(m);
            chat.pending_idx = Some(chat.messages.len() - 1);
            pin_queued_below_reply(chat);
            let Some(idx) = chat.pending_idx else {
                return;
            };
            chat.last_emit = Instant::now();
            chat.dirty = false;
            Some(chat.messages[idx].clone())
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
    emit(key, message);
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
    fn recap_reads_the_chat_without_tool_rows_and_keeps_the_newest() {
        let row = |role, from: &str, text: &str, kind| ChatMessage {
            id: new_id(),
            role,
            from: from.into(),
            text: text.into(),
            ts: 0,
            queued: false,
            peer: None,
            kind,
            approval: None,
            choice: None,
        };
        let msgs = vec![
            row(
                Role::System,
                "user",
                "review this",
                Some(MessageKind::Received),
            ),
            row(Role::Assistant, "bot", "", Some(MessageKind::Tool)),
            row(Role::Assistant, "bot", "looks fine", None),
        ];
        assert_eq!(
            recap_of(&msgs).as_deref(),
            Some("user: review this\n\nassistant: looks fine")
        );
        let prior = vec![
            row(Role::User, "user", "first", None),
            row(Role::Assistant, "bot", "answer", None),
            row(Role::User, "user", "second", None),
        ];
        assert_eq!(
            prior_of(&prior).as_deref(),
            Some("user: first\n\nassistant: answer")
        );
        assert_eq!(prior_of(&prior[2..]), None);
        let handoff = row(
            Role::System,
            "bob",
            "done",
            Some(MessageKind::Handoff),
        );
        let second = row(Role::User, "user", "second", None);
        let third = row(Role::User, "user", "third", None);
        let joined = vec![
            row(Role::User, "user", "first", None),
            row(Role::Assistant, "bot", "answer", None),
            handoff.clone(),
            second.clone(),
            third.clone(),
        ];
        let skip = vec![handoff.id, second.id, third.id];
        assert_eq!(
            excluding(&joined, &skip).as_deref(),
            Some("user: first\n\nassistant: answer")
        );
        assert_eq!(recap_of(&msgs[1..2]), None);

        let long = "x".repeat(RECAP_BUDGET);
        let msgs = vec![
            row(Role::System, "user", "first", None),
            row(Role::Assistant, "bot", &long, None),
        ];
        let recap = recap_of(&msgs).unwrap();
        assert!(recap.starts_with("(earlier messages left out)\n\nassistant: (start left out) x"));
        assert!(!recap.contains("first"));

        // One message over the budget keeps its end, where a report concludes.
        let report = format!("{}the conclusion", "y".repeat(RECAP_BUDGET));
        let msgs = vec![row(Role::Assistant, "bot", &report, None)];
        let recap = recap_of(&msgs).unwrap();
        assert!(recap.ends_with("the conclusion"), "{recap}");
        assert!(recap.contains("assistant: (start left out) y"));
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

    /// 빵셔틀 only answered 가위바위보. That answer is 가위바위보's news, so
    /// 빵셔틀's own chat stays read and every row of it is tagged with the asker.
    #[test]
    fn another_bots_turn_leaves_the_chat_read() {
        let agent = format!(
            "peer-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        drop_agent(&agent);
        let seen = push_user(&agent, "user", "안녕");
        push_system(&agent, "rival", "가위바위보 한 판", Some("rival".into()));
        set_peer(&agent, Some("rival".into()));
        on_assistant_delta(&agent, "보");
        seal_now(&agent);
        // The turn ends before its tell back goes out.
        set_peer(&agent, None);
        push_notice(&agent, "to:rival", "보", Some("rival".into()));
        assert_eq!(last_ts(&agent), seen.ts);
        let rows = messages(&agent);
        assert!(rows[1..].iter().all(|m| m.peer.as_deref() == Some("rival")));

        let reply = rows.iter().find(|m| m.role == Role::Assistant).unwrap();
        set_approval(&agent, &reply.id, ApprovalState::Pending);
        assert_eq!(
            last_ts(&agent),
            reply.ts,
            "a card waiting on the user is news"
        );

        let typed = push_user(&agent, "user", "누가 이겼어?");
        assert_eq!(typed.peer, None, "what the user typed is news");
        on_assistant_delta(&agent, "내가 이겼어");
        seal_now(&agent);
        assert!(last_ts(&agent) >= typed.ts);
        assert!(messages(&agent).last().is_some_and(|m| m.peer.is_none()));
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
    fn subagent_notes_sit_above_the_reply_they_came_in() {
        let agent = format!(
            "sub-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        drop_agent(&agent);
        begin_turn(&agent);
        on_assistant_delta(&agent, "I'll ask.");
        let peer = "sub:toolu_1:Explore";
        let sent = push_subagent(&agent, "toolu_1", &format!("to:{peer}"), "find the parser");
        let got = push_subagent(&agent, "toolu_1/report", peer, "It is in headless.rs.");
        assert_eq!(
            preview(&agent).as_deref(),
            Some("I'll ask."),
            "not news to the user"
        );
        on_assistant_delta(&agent, " Found it.");
        // A later report for the same call takes the first one's place.
        let again = push_subagent(&agent, "toolu_1/report", peer, "It moved to parse.rs.");
        assert_eq!(again.id, got.id);
        let rows = messages(&agent);
        assert_eq!(rows.len(), 3, "the reply stays one bubble");
        assert_eq!(rows[0].id, sent.id);
        assert_eq!(rows[0].kind, Some(MessageKind::Sent));
        assert_eq!(rows[1].id, got.id);
        assert_eq!(rows[1].kind, Some(MessageKind::Received));
        assert_eq!(rows[1].text, "It moved to parse.rs.");
        assert_eq!(rows[2].role, Role::Assistant);
        assert_eq!(rows[2].text, "I'll ask. Found it.");
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

    /// A teammate's reply or the user's follow-up can land while this bot is
    /// still answering. Sealing there split the reply around the row, handed
    /// the first half on as the whole answer, and a row that expects no turn
    /// (the teammate's reply) left the rest of the answer nowhere to go.
    #[test]
    fn a_row_landing_mid_turn_leaves_the_reply_whole() {
        crate::paths::testing::with_home("mid-turn", || {
            let agent = format!(
                "midturn-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            );
            push_user(&agent, "user", "first");
            let turn = begin_turn(&agent);
            on_assistant_delta(&agent, "one");
            push_handoff(&agent, "peer", "their answer");
            on_assistant_delta(&agent, " two");
            push_user(&agent, "user", "follow-up");
            on_assistant_delta(&agent, " three");
            end_turn_gen(&agent, Some(turn));
            let rows: Vec<(Role, String)> = messages(&agent)
                .into_iter()
                .map(|m| (m.role, m.text))
                .collect();
            assert_eq!(
                rows,
                [
                    (Role::User, "first".to_string()),
                    (Role::Assistant, "one two three".to_string()),
                    (Role::System, "their answer".to_string()),
                    (Role::User, "follow-up".to_string()),
                ]
            );
            drop_agent(&agent);
        });
    }

    /// A reply still being written stays above the rows that land meanwhile,
    /// so the last row is not the newest news once the reply finishes.
    #[test]
    fn a_reply_finishing_above_newer_rows_is_the_latest() {
        crate::paths::testing::with_home("latest", || {
            let agent = format!(
                "latest-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            );
            push_user(&agent, "user", "hi");
            let turn = begin_turn(&agent);
            on_assistant_delta(&agent, "working on it");
            let note = push_handoff(&agent, "peer", "their answer");
            std::thread::sleep(Duration::from_millis(5));
            on_assistant_delta(&agent, ", done");
            end_turn_gen(&agent, Some(turn));
            assert!(last_ts(&agent) > note.ts, "the unread dot missed it");
            assert_eq!(preview(&agent).as_deref(), Some("working on it, done"));
            drop_agent(&agent);
        });
    }

    /// A follow-up sent while the bot is still answering stays under that
    /// reply. The first tokens used to land after it and shove it upward.
    #[test]
    fn a_queued_follow_up_stays_below_the_reply() {
        crate::paths::testing::with_home("pin-queued", || {
            let n = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let before = format!("pin-before-{n}");
            push_user(&before, "user", "first");
            begin_turn(&before);
            let follow = push_user(&before, "user", "follow-up");
            set_queued(&before, &follow.id, true);
            on_assistant_delta(&before, "one");
            let rows: Vec<(Role, String, bool)> = messages(&before)
                .into_iter()
                .map(|m| (m.role, m.text, m.queued))
                .collect();
            assert_eq!(
                rows,
                [
                    (Role::User, "first".into(), false),
                    (Role::Assistant, "one".into(), false),
                    (Role::User, "follow-up".into(), true),
                ]
            );
            on_assistant_delta(&before, " two");
            let again: Vec<(Role, String)> = messages(&before)
                .into_iter()
                .map(|m| (m.role, m.text))
                .collect();
            assert_eq!(
                again,
                [
                    (Role::User, "first".into()),
                    (Role::Assistant, "one two".into()),
                    (Role::User, "follow-up".into()),
                ]
            );

            let after = format!("pin-after-{n}");
            push_user(&after, "user", "first");
            begin_turn(&after);
            on_assistant_delta(&after, "one");
            let follow = push_user(&after, "user", "follow-up");
            set_queued(&after, &follow.id, true);
            on_assistant_delta(&after, " two");
            let rows: Vec<(Role, String, bool)> = messages(&after)
                .into_iter()
                .map(|m| (m.role, m.text, m.queued))
                .collect();
            assert_eq!(
                rows,
                [
                    (Role::User, "first".into(), false),
                    (Role::Assistant, "one two".into(), false),
                    (Role::User, "follow-up".into(), true),
                ]
            );
            drop_agent(&before);
            drop_agent(&after);
        });
    }

    /// The channel list quotes the last sentence. A command's arguments are
    /// newer while the call runs, and used to show up as `{ "command": ...`.
    #[test]
    fn a_tool_call_stays_out_of_the_channel_preview() {
        crate::paths::testing::with_home("preview-tool", || {
            let n = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let agent = format!("preview-tool-{n}");
            push_user(&agent, "user", "이 버그 고쳐줘");
            begin_turn(&agent);
            on_assistant_delta(&agent, "고쳐 보겠습니다.");
            std::thread::sleep(Duration::from_millis(5));
            push_tool(
                &agent,
                Some("call-1"),
                "run_terminal_command",
                "{\n  \"command\": \"cargo test -p crew\"\n}",
            );
            assert_eq!(preview(&agent).as_deref(), Some("고쳐 보겠습니다."));

            let only = format!("preview-only-{n}");
            push_user(&only, "user", "확인해줘");
            std::thread::sleep(Duration::from_millis(5));
            begin_turn(&only);
            push_tool(
                &only,
                Some("call-2"),
                "run_terminal_command",
                "{\n  \"command\": \"ls\"\n}",
            );
            assert_eq!(preview(&only).as_deref(), Some("확인해줘"));

            let dumped = format!("preview-dump-{n}");
            push_user(&dumped, "user", "상태 알려줘");
            std::thread::sleep(Duration::from_millis(5));
            begin_turn(&dumped);
            on_assistant_delta(&dumped, "{\n  \"command\": \"echo hi\"\n}");
            assert_eq!(preview(&dumped).as_deref(), Some("상태 알려줘"));

            let ask = format!("preview-ask-{n}");
            push_user(&ask, "user", "골라");
            std::thread::sleep(Duration::from_millis(5));
            begin_turn(&ask);
            push_tool(
                &ask,
                Some("call-q"),
                "AskUserQuestion",
                r#"{"questions":[{"question":"어느 쪽을 고를래?","options":[{"label":"A"},{"label":"B"}]}]}"#,
            );
            assert_eq!(preview(&ask).as_deref(), Some("어느 쪽을 고를래?"));

            // An approval stuck on the command payload must not blank the list.
            let gated = format!("preview-gate-{n}");
            push_user(&gated, "user", "실행해도 될까");
            begin_turn(&gated);
            on_assistant_delta(&gated, "이 명령을 실행할까?");
            std::thread::sleep(Duration::from_millis(5));
            let tool = push_tool(
                &gated,
                Some("call-3"),
                "run_terminal_command",
                "{\n  \"command\": \"rm -rf build\"\n}",
            );
            set_approval(&gated, &tool.id, ApprovalState::Pending);
            assert_eq!(preview(&gated).as_deref(), Some("이 명령을 실행할까?"));

            // A blank line inside the payload is still JSON, not a sentence.
            let gated_gap = format!("preview-gate-gap-{n}");
            push_user(&gated_gap, "user", "이전 문장");
            begin_turn(&gated_gap);
            on_assistant_delta(&gated_gap, "이 명령을 실행할까?");
            std::thread::sleep(Duration::from_millis(5));
            let gapped = push_tool(
                &gated_gap,
                Some("call-4"),
                "run_terminal_command",
                "{\n  \"command\": \"rm\",\n\n  \"yes\": true\n}",
            );
            set_approval(&gated_gap, &gapped.id, ApprovalState::Pending);
            assert_eq!(preview(&gated_gap).as_deref(), Some("이 명령을 실행할까?"));

            drop_agent(&agent);
            drop_agent(&only);
            drop_agent(&dumped);
            drop_agent(&ask);
            drop_agent(&gated);
            drop_agent(&gated_gap);
        });
    }

    /// A message waiting to send is not the channel list's line. The one already
    /// in the chat stays, and the waiting text shows once it goes out.
    #[test]
    fn a_queued_message_stays_out_of_the_channel_preview() {
        crate::paths::testing::with_home("preview-queued", || {
            let n = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let waiting = format!("preview-queued-{n}");
            push_user(&waiting, "user", "이전 이야기");
            begin_turn(&waiting);
            on_assistant_delta(&waiting, "여기까지 했습니다.");
            end_turn(&waiting);
            std::thread::sleep(Duration::from_millis(5));
            let queued = push_user(&waiting, "user", "이어서 해줘");
            set_queued(&waiting, &queued.id, true);
            assert_eq!(preview(&waiting).as_deref(), Some("여기까지 했습니다."));
            set_queued(&waiting, &queued.id, false);
            assert_eq!(preview(&waiting).as_deref(), Some("이어서 해줘"));

            let held_only = format!("preview-queued-only-{n}");
            let held = push_user(&held_only, "user", "아직 보내지 않음");
            set_queued(&held_only, &held.id, true);
            assert_eq!(preview(&held_only), None);

            drop_agent(&waiting);
            drop_agent(&held_only);
        });
    }

    /// A turn is one row split into balloons. The list was quoting the first.
    #[test]
    fn the_channel_preview_quotes_the_last_balloon() {
        crate::paths::testing::with_home("preview-balloon", || {
            let n = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let agent = format!("preview-balloon-{n}");
            push_user(&agent, "user", "올려줘");
            begin_turn(&agent);
            on_assistant_delta(
                &agent,
                "각 변경을 나눠 PR로 올리겠습니다.\n\n리뷰 두 건이 끝났습니다.",
            );
            assert_eq!(preview(&agent).as_deref(), Some("리뷰 두 건이 끝났습니다."));

            let ruled = format!("preview-rule-{n}");
            push_user(&ruled, "user", "나눠줘");
            begin_turn(&ruled);
            on_assistant_delta(&ruled, "위\n\n---\n\n아래\n\n* * *");
            assert_eq!(preview(&ruled).as_deref(), Some("아래"));

            let fenced = format!("preview-fence-{n}");
            push_user(&fenced, "user", "보여줘");
            begin_turn(&fenced);
            on_assistant_delta(&fenced, "이거 봐.\n\n```\nout\n```\n\n끝났어요.");
            assert_eq!(preview(&fenced).as_deref(), Some("끝났어요."));

            let glued = format!("preview-glued-{n}");
            push_user(&glued, "user", "실행해줘");
            begin_turn(&glued);
            on_assistant_delta(&glued, "먼저 볼게요.\n\n`echo hi`\n\n```\nhi\n```");
            assert_eq!(preview(&glued).as_deref(), Some("`echo hi` ``` hi ```"));

            let inline = format!("preview-inline-{n}");
            push_user(&inline, "user", "감싸줘");
            begin_turn(&inline);
            on_assistant_delta(&inline, "```a``` 는 코드\n\n끝");
            assert_eq!(preview(&inline).as_deref(), Some("끝"));

            let long = format!("preview-long-{n}");
            push_user(&long, "user", "길게");
            begin_turn(&long);
            let tail = "가".repeat(50);
            on_assistant_delta(&long, &format!("앞선 말풍선입니다.\n\n{tail}"));
            let clipped: String = tail.chars().take(48).collect();
            assert_eq!(
                preview(&long).as_deref(),
                Some(format!("{clipped}…").as_str())
            );

            // One paragraph stays one balloon, sentences included.
            let whole = format!("preview-whole-{n}");
            push_user(&whole, "user", "상태");
            begin_turn(&whole);
            on_assistant_delta(&whole, "확인했어요.\n이제 고칠게요.");
            assert_eq!(
                preview(&whole).as_deref(),
                Some("확인했어요. 이제 고칠게요.")
            );

            // A blank line is legal inside JSON, so the tail is not a balloon.
            let dumped = format!("preview-json-gap-{n}");
            push_user(&dumped, "user", "상태 알려줘");
            begin_turn(&dumped);
            on_assistant_delta(&dumped, "{\n  \"a\": 1,\n\n  \"b\": 2\n}");
            assert_eq!(preview(&dumped).as_deref(), Some("상태 알려줘"));
            let empty = format!("preview-json-empty-{n}");
            push_user(&empty, "user", "비어 있어");
            begin_turn(&empty);
            on_assistant_delta(&empty, "{\n\n}");
            assert_eq!(preview(&empty).as_deref(), Some("비어 있어"));
            let mixed = format!("preview-json-mix-{n}");
            push_user(&mixed, "user", "고쳐줘");
            begin_turn(&mixed);
            on_assistant_delta(
                &mixed,
                "고쳐 보겠습니다.\n\n{\n  \"a\": 1,\n\n  \"b\": 2\n}",
            );
            assert_eq!(preview(&mixed).as_deref(), Some("고쳐 보겠습니다."));

            drop_agent(&agent);
            drop_agent(&ruled);
            drop_agent(&fenced);
            drop_agent(&glued);
            drop_agent(&inline);
            drop_agent(&long);
            drop_agent(&whole);
            drop_agent(&dumped);
            drop_agent(&empty);
            drop_agent(&mixed);
        });
    }

    /// A delivery that fails while a turn is under way is not that turn's. It
    /// switched the turn's stream off, and the whole reply was lost.
    #[test]
    fn a_failed_delivery_leaves_the_turn_in_flight_alone() {
        let agent = format!(
            "inflight-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        let turn = begin_turn(&agent);
        cancel_expect(&agent);
        on_assistant_delta(&agent, "still here");
        end_turn_gen(&agent, Some(turn));
        assert_eq!(
            messages(&agent).last().map(|m| m.text.as_str()),
            Some("still here")
        );
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
            peer: None,
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
        let msg = push_notice(&agent, "to:pm", "hello", None);
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
        let msg = push_system(&agent, "alpha", "wait", None);
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
        push_system(&agent, "user", "안녕?", None);
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
    fn a_second_ask_with_the_same_question_stays_one_card() {
        let agent = format!(
            "ask-same-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        drop_agent(&agent);
        begin_turn(&agent);
        on_assistant_delta(&agent, "진행해도 되는지 알려 주세요.");
        let detail = |label: &str| {
            format!(
                r#"{{"questions":[{{"question":"어떻게 할까요?","options":[{{"label":"{label}"}},{{"label":"그대로 둔다"}}]}}]}}"#
            )
        };
        push_tool(
            &agent,
            Some("call-1"),
            "ask_user_question",
            &detail("지운다 (Recommended)"),
        );
        push_tool(&agent, Some("call-2"), "ask_user_question", &detail("지운다"));
        let cards: Vec<_> = messages(&agent)
            .into_iter()
            .filter(|m| m.choice.is_some())
            .collect();
        assert_eq!(cards.len(), 1);
        let q = &cards[0].choice.as_ref().unwrap().questions[0];
        assert_eq!(q.question, "어떻게 할까요?");
        assert_eq!(q.options[0].label, "지운다 (Recommended)");
        assert!(has_pending_question(&agent, "어떻게 할까요?"));
        drop_agent(&agent);
    }

    #[test]
    fn a_different_question_opens_its_own_card() {
        let agent = format!(
            "ask-diff-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        drop_agent(&agent);
        begin_turn(&agent);
        push_tool(
            &agent,
            Some("call-1"),
            "ask_user_question",
            r#"{"question":"어느 쪽을 고를래?","options":[{"label":"A"},{"label":"B"}]}"#,
        );
        push_tool(
            &agent,
            Some("call-2"),
            "ask_user_question",
            r#"{"question":"이름을 뭐로 할까?","options":[{"label":"가"},{"label":"나"}]}"#,
        );
        let n = messages(&agent)
            .into_iter()
            .filter(|m| m.choice.is_some())
            .count();
        assert_eq!(n, 2);
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
