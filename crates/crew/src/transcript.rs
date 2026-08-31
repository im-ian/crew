use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::paths;
use crate::protocol::{ChatMessage, Event, Role};

fn channel_key(id: &str) -> String {
    format!("ch:{id}")
}

const EMIT_INTERVAL: Duration = Duration::from_millis(60);
const SEAL_IDLE: Duration = Duration::from_millis(650);
const EXPECT_TIMEOUT: Duration = Duration::from_millis(2000);

static CHATS: OnceLock<Mutex<HashMap<String, AgentChat>>> = OnceLock::new();
static ID_SEQ: AtomicU64 = AtomicU64::new(1);

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
    if let Ok(mut map) = chats().lock() {
        map.remove(agent);
    }
}

pub fn drop_channel(id: &str) {
    if let Ok(mut map) = chats().lock() {
        map.remove(&channel_key(id));
    }
}

pub fn messages(agent: &str) -> Vec<ChatMessage> {
    chats()
        .lock()
        .ok()
        .and_then(|m| m.get(agent).map(|c| c.messages.clone()))
        .unwrap_or_default()
}

pub fn preview(agent: &str) -> Option<String> {
    let msgs = messages(agent);
    let last = msgs.last()?;
    let t: String = last.text.split_whitespace().collect::<Vec<_>>().join(" ");
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
    push_role(agent, Role::User, from, text, true)
}

pub fn push_system(agent: &str, from: &str, text: &str) -> ChatMessage {
    push_role(agent, Role::System, from, text, true)
}

/// System row that must not open a turn, e.g. a "sent to other session" receipt.
pub fn push_notice(agent: &str, from: &str, text: &str) -> ChatMessage {
    push_role(agent, Role::System, from, text, false)
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
    let msg = push_role(&key, role, from, text, false);
    let _ = crate::daemon::events().send(Event::ChannelMessage {
        channel: id.to_string(),
        message: msg.clone(),
    });
    msg
}

fn push_role(agent: &str, role: Role, from: &str, text: &str, expect: bool) -> ChatMessage {
    seal_now(agent);
    let msg = ChatMessage {
        id: new_id(),
        role,
        from: from.to_string(),
        text: text.to_string(),
        ts: now_ms(),
        queued: false,
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

pub fn begin_turn(agent: &str) {
    if let Ok(mut map) = chats().lock() {
        let chat = map
            .entry(agent.to_string())
            .or_insert_with(AgentChat::empty);
        chat.expecting = true;
        chat.hold = true;
        chat.last_byte = Instant::now();
    }
}

pub fn end_turn(agent: &str) {
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
        emit(agent, msg);
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
        emit(agent, msg);
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
    if chat.messages[idx].text.is_empty() {
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

fn persist(agent: &str, chat: &AgentChat) {
    let path = persist_path(agent);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let mut out = String::new();
    for m in &chat.messages {
        let mut stored = m.clone();
        stored.queued = false;
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

fn is_crew_marker_line(line: &str) -> bool {
    let t = line.trim();
    if !t.starts_with("[crew ") || !t.ends_with(']') {
        return false;
    }
    let inner = &t["[crew ".len()..t.len() - 1];
    inner == "system"
        || inner.starts_with("from:")
        || inner.starts_with("routine:")
        || inner.starts_with("channel:")
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

fn strip_crew_markers(s: &str) -> String {
    let mut out = String::new();
    for line in s.split('\n') {
        if is_crew_marker_line(line) {
            continue;
        }
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(line);
    }
    out
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
    fn jsonl_roundtrip_shape() {
        let msg = ChatMessage {
            id: "a".into(),
            role: Role::System,
            from: "alpha".into(),
            text: "hi".into(),
            ts: 9,
            queued: false,
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
        assert_eq!(strip_crew_markers("[crew system]\nTeammates: a"), "Teammates: a");
        assert_eq!(strip_crew_markers("keep\n[crew from:x]\nthis"), "keep\nthis");
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
}
