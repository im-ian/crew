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

pub fn cancel_expect(agent: &str) {
    if let Ok(mut map) = chats().lock() {
        if let Some(chat) = map.get_mut(agent) {
            chat.expecting = false;
        }
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
        let cleaned = normalize_text(&strip_ansi(&raw));
        if cleaned.is_empty() {
            return;
        }
        if let Some(idx) = chat.pending_idx {
            chat.messages[idx].text.push_str(&cleaned);
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
        if chat.pending_idx.is_none() {
            if chat.expecting && chat.last_byte.elapsed() > EXPECT_TIMEOUT {
                chat.expecting = false;
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
    let Some(idx) = chat.pending_idx.take() else {
        chat.expecting = false;
        chat.dirty = false;
        return None;
    };
    chat.dirty = false;
    chat.messages[idx].text = chat.messages[idx].text.trim_end().to_string();
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
        if let Ok(line) = serde_json::to_string(m) {
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
    fn jsonl_roundtrip_shape() {
        let msg = ChatMessage {
            id: "a".into(),
            role: Role::System,
            from: "alpha".into(),
            text: "hi".into(),
            ts: 9,
        };
        let line = serde_json::to_string(&msg).unwrap();
        let back: ChatMessage = serde_json::from_str(&line).unwrap();
        assert_eq!(back.from, "alpha");
        assert_eq!(back.role, Role::System);
    }
}
