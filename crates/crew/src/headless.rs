use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use anyhow::Context;
use serde_json::Value;

use crate::config::{AgentConfig, TurnSession};
use crate::paths;
use crate::protocol::AgentStatus;

pub struct HeadlessSession {
    pub id: String,
    pub name: String,
    pub cmd: Vec<String>,
    pub cwd: PathBuf,
    pub inner: Mutex<HeadlessInner>,
}

pub struct HeadlessInner {
    pub status: AgentStatus,
    pub last_output: Instant,
    pub seq: u64,
    pub cols: u16,
    pub rows: u16,
    pub session_id: Option<String>,
    pub child: Option<std::process::Child>,
    pub generation: u64,
}

pub fn open(
    cfg: &AgentConfig,
    cols: u16,
    rows: u16,
    fresh_session: bool,
) -> anyhow::Result<Arc<HeadlessSession>> {
    let cwd = crate::config::Config::default_cwd(cfg);
    paths::create_cwd(&cwd)?;
    if fresh_session {
        clear_session(&cfg.id);
    }
    let session_id = if fresh_session {
        None
    } else {
        load_session(&cfg.id)
    };
    Ok(Arc::new(HeadlessSession {
        id: cfg.id.clone(),
        name: cfg.display_name().to_string(),
        cmd: cfg.cmd.clone(),
        cwd,
        inner: Mutex::new(HeadlessInner {
            status: AgentStatus::Idle,
            last_output: Instant::now(),
            seq: 0,
            cols,
            rows,
            session_id,
            child: None,
            generation: 0,
        }),
    }))
}

pub fn clear_session(agent_id: &str) {
    let _ = fs::remove_file(paths::cli_session_path(agent_id));
}

pub fn load_session(agent_id: &str) -> Option<String> {
    let raw = fs::read_to_string(paths::cli_session_path(agent_id)).ok()?;
    let id = raw.trim();
    if id.is_empty() {
        None
    } else {
        Some(id.to_string())
    }
}

pub fn save_session(agent_id: &str, session_id: &str) -> anyhow::Result<()> {
    let path = paths::cli_session_path(agent_id);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, format!("{}\n", session_id.trim()))?;
    Ok(())
}

pub fn kill(session: &HeadlessSession) {
    if let Ok(mut inner) = session.inner.lock() {
        inner.generation = inner.generation.wrapping_add(1);
        if let Some(mut child) = inner.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        inner.status = AgentStatus::Idle;
        inner.seq += 1;
        inner.session_id = None;
    }
    clear_session(&session.id);
}

pub fn kick(
    session: Arc<HeadlessSession>,
    cfg: AgentConfig,
    roster: Vec<AgentConfig>,
    prompt: String,
) -> anyhow::Result<()> {
    let generation = {
        let mut inner = session.inner.lock().expect("headless inner");
        if inner.status == AgentStatus::Working || inner.child.is_some() {
            anyhow::bail!("agent {} is working", session.id);
        }
        inner.status = AgentStatus::Working;
        inner.last_output = Instant::now();
        inner.seq += 1;
        inner.generation
    };
    crate::daemon::emit_agent_frame(&session.id);
    let thread_session = session.clone();
    if let Err(err) = std::thread::Builder::new()
        .name(format!("crew-turn-{}", session.id))
        .spawn(move || run_turn(thread_session, cfg, roster, prompt, generation))
    {
        if let Ok(mut inner) = session.inner.lock() {
            if inner.generation == generation {
                inner.status = AgentStatus::Idle;
                inner.seq += 1;
            }
        }
        crate::daemon::emit_agent_frame(&session.id);
        return Err(err).context("spawn headless turn thread");
    }
    Ok(())
}

fn run_turn(
    session: Arc<HeadlessSession>,
    cfg: AgentConfig,
    roster: Vec<AgentConfig>,
    prompt: String,
    generation: u64,
) {
    {
        let inner = match session.inner.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if inner.generation != generation {
            return;
        }
    }
    crate::transcript::begin_turn(&session.id);

    let program = cfg.binary_name();
    let stored = session
        .inner
        .lock()
        .ok()
        .and_then(|i| i.session_id.clone())
        .or_else(|| load_session(&session.id));
    let (turn_session, created_id) = match (program.as_str(), stored) {
        ("codex", Some(id)) => (
            Some(TurnSession {
                id,
                resume: true,
            }),
            None,
        ),
        ("codex", None) => (None, None),
        (_, Some(id)) => (
            Some(TurnSession {
                id,
                resume: true,
            }),
            None,
        ),
        (_, None) => {
            let id = new_cli_uuid();
            (
                Some(TurnSession {
                    id: id.clone(),
                    resume: false,
                }),
                Some(id),
            )
        }
    };
    if let Some(id) = created_id.as_ref() {
        if let Ok(mut inner) = session.inner.lock() {
            inner.session_id = Some(id.clone());
        }
    }

    let argv = cfg.turn_cmd(&prompt, turn_session.as_ref(), &roster);
    let result = spawn_and_stream(&session, &argv, generation);

    let stale = session
        .inner
        .lock()
        .ok()
        .map(|i| i.generation != generation)
        .unwrap_or(true);
    if stale {
        crate::transcript::end_turn(&session.id);
        return;
    }

    match result {
        Ok(outcome) => {
            let dead = session_is_dead(
                outcome.got_text,
                outcome.error.as_deref(),
                created_id.is_some(),
            );
            if dead {
                if let Ok(mut inner) = session.inner.lock() {
                    inner.session_id = None;
                }
                clear_session(&session.id);
            } else if let Some(id) = outcome
                .session_id
                .as_deref()
                .or(created_id.as_deref())
                .or(turn_session.as_ref().map(|s| s.id.as_str()))
            {
                if !id.is_empty() {
                    if let Ok(mut inner) = session.inner.lock() {
                        inner.session_id = Some(id.to_string());
                    }
                    let _ = save_session(&session.id, id);
                }
            }
            if !outcome.got_text {
                if let Some(err) = outcome.error.as_deref() {
                    let cleaned = strip_tui_noise(err);
                    if !cleaned.is_empty() {
                        crate::transcript::on_assistant_delta(&session.id, &cleaned);
                    }
                }
            }
        }
        Err(err) => {
            if created_id.is_some() {
                if let Ok(mut inner) = session.inner.lock() {
                    inner.session_id = None;
                }
            }
            let msg = format!("{err:#}");
            let cleaned = strip_tui_noise(&msg);
            if !cleaned.is_empty() {
                crate::transcript::on_assistant_delta(&session.id, &cleaned);
            }
        }
    }

    crate::transcript::end_turn(&session.id);
    if let Ok(mut inner) = session.inner.lock() {
        inner.child = None;
        if inner.status != AgentStatus::Exited {
            inner.status = AgentStatus::Idle;
        }
        inner.last_output = Instant::now();
        inner.seq += 1;
    }
    crate::daemon::emit_agent_frame(&session.id);
}

/// A turn that died without a reply left no CLI conversation behind, so its id
/// must not be reused: `--resume` would point at a session the CLI never wrote.
fn session_is_dead(got_text: bool, error: Option<&str>, fresh_id: bool) -> bool {
    match error {
        Some(err) if !got_text => {
            fresh_id || err.to_lowercase().contains("no conversation found")
        }
        _ => false,
    }
}

struct TurnOutcome {
    session_id: Option<String>,
    got_text: bool,
    error: Option<String>,
}

fn spawn_and_stream(
    session: &HeadlessSession,
    argv: &[String],
    generation: u64,
) -> anyhow::Result<TurnOutcome> {
    if argv.is_empty() {
        anyhow::bail!("empty command");
    }
    let program = paths::resolve_program(&argv[0]);
    let mut cmd = Command::new(program.as_os_str());
    for arg in argv.iter().skip(1) {
        cmd.arg(arg);
    }
    cmd.current_dir(&session.cwd);
    cmd.env("PATH", paths::enriched_path());
    cmd.env("CREW_AGENT_ID", &session.id);
    cmd.env("CREW_HOME", paths::home_dir());
    cmd.env("TERM", "dumb");
    cmd.env("NO_COLOR", "1");
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .with_context(|| format!("spawn {} ({})", session.id, argv.join(" ")))?;
    let stdout = child.stdout.take().context("take stdout")?;
    let stderr = child.stderr.take();
    {
        let mut inner = session.inner.lock().expect("headless inner");
        if inner.generation != generation {
            let _ = child.kill();
            let _ = child.wait();
            anyhow::bail!("turn cancelled");
        }
        inner.child = Some(child);
    }

    let stderr_handle = stderr.map(|err| {
        std::thread::spawn(move || {
            let mut buf = String::new();
            let _ = BufReader::new(err).read_to_string(&mut buf);
            buf
        })
    });

    let cli = CliKind::from_program(&session.cmd.first().cloned().unwrap_or_default());
    let mut state = ParseState::default();
    let mut plain = String::new();
    let reader = BufReader::new(stdout);
    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(err) => return Err(err.into()),
        };
        if let Some(chunk) = ingest_line(cli, &line, &mut state) {
            feed_text(cli, session, &chunk);
            if let Ok(mut inner) = session.inner.lock() {
                inner.last_output = Instant::now();
                inner.seq += 1;
            }
        } else if cli == CliKind::Other && !line.trim().is_empty() && !looks_json(&line) {
            // grok/claude/codex stream every reply as JSON, so a bare line there is
            // CLI chatter (MCP warnings, banners) and must never become the answer.
            if !plain.is_empty() {
                plain.push('\n');
            }
            plain.push_str(&line);
        }
        if let Some(id) = state.session_id.as_ref() {
            if let Ok(mut inner) = session.inner.lock() {
                inner.session_id = Some(id.clone());
            }
        }
    }

    let status = {
        let mut inner = session.inner.lock().expect("headless inner");
        match inner.child.as_mut() {
            Some(child) => child.wait().ok(),
            None => None,
        }
    };
    let stderr_text = stderr_handle
        .and_then(|h| h.join().ok())
        .unwrap_or_default();

    if !state.got_text && !plain.is_empty() {
        let cleaned = strip_tui_noise(&plain);
        if !cleaned.is_empty() {
            crate::transcript::on_assistant_delta(&session.id, &cleaned);
            state.got_text = true;
        }
    }

    let mut error = state.error.take();
    if !state.got_text {
        let code = status.and_then(|s| s.code()).unwrap_or(1);
        if code != 0 {
            let tail = strip_tui_noise(&stderr_text);
            let msg = if tail.is_empty() {
                format!("CLI exited with status {code}")
            } else {
                tail
            };
            error = Some(error.unwrap_or(msg));
        }
    }

    Ok(TurnOutcome {
        session_id: state.session_id,
        got_text: state.got_text,
        error,
    })
}

fn feed_text(cli: CliKind, session: &HeadlessSession, chunk: &str) {
    match cli {
        CliKind::Codex => crate::transcript::set_pending_assistant(&session.id, chunk),
        _ => crate::transcript::on_assistant_delta(&session.id, chunk),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CliKind {
    Grok,
    Claude,
    Codex,
    Other,
}

impl CliKind {
    fn from_program(raw: &str) -> Self {
        let name = std::path::Path::new(raw)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(raw)
            .to_ascii_lowercase();
        match name.as_str() {
            "grok" => Self::Grok,
            "claude" => Self::Claude,
            "codex" => Self::Codex,
            _ => Self::Other,
        }
    }
}

#[derive(Debug, Default)]
struct ParseState {
    session_id: Option<String>,
    used_deltas: bool,
    got_text: bool,
    error: Option<String>,
    last_codex_item: Option<String>,
    last_codex_text: Option<String>,
}

fn ingest_line(cli: CliKind, line: &str, state: &mut ParseState) -> Option<String> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let v: Value = serde_json::from_str(line).ok()?;
    capture_session(&v, state);
    if let Some(err) = json_error(&v) {
        state.error = Some(err);
    }
    match cli {
        CliKind::Grok => grok_text(&v, state),
        CliKind::Claude => claude_text(&v, state),
        CliKind::Codex => codex_text(&v, state),
        CliKind::Other => None,
    }
}

fn grok_text(v: &Value, state: &mut ParseState) -> Option<String> {
    if let Some(chunk) = acp_message_chunk(v) {
        state.used_deltas = true;
        state.got_text = true;
        return Some(chunk);
    }
    let ty = v.get("type").and_then(Value::as_str).unwrap_or("");
    match ty {
        "text" => {
            let chunk = v
                .get("data")
                .or_else(|| v.get("text"))
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())?
                .to_string();
            state.used_deltas = true;
            state.got_text = true;
            Some(chunk)
        }
        "thought" | "tool_call" | "tool_call_update" | "usage" | "plan" | "available_commands"
        | "end" => None,
        _ => None,
    }
}

fn claude_text(v: &Value, state: &mut ParseState) -> Option<String> {
    if let Some(delta) = claude_text_delta(v) {
        state.used_deltas = true;
        state.got_text = true;
        return Some(delta);
    }
    if state.used_deltas {
        return None;
    }
    if v.get("type").and_then(Value::as_str) == Some("assistant") {
        let text = assistant_message_text(v.get("message").unwrap_or(v));
        if !text.is_empty() {
            state.got_text = true;
            return Some(text);
        }
    }
    None
}

fn claude_text_delta(v: &Value) -> Option<String> {
    let event = if v.get("type").and_then(Value::as_str) == Some("stream_event") {
        v.get("event").unwrap_or(v)
    } else {
        v
    };
    let delta = event.get("delta").or_else(|| event.get("event").and_then(|e| e.get("delta")))?;
    let ty = delta.get("type").and_then(Value::as_str).unwrap_or("");
    if ty == "text_delta" || ty == "text" {
        let text = delta.get("text").and_then(Value::as_str)?;
        if text.is_empty() {
            None
        } else {
            Some(text.to_string())
        }
    } else {
        None
    }
}

fn assistant_message_text(message: &Value) -> String {
    let mut out = String::new();
    if let Some(arr) = message.get("content").and_then(Value::as_array) {
        for block in arr {
            if block.get("type").and_then(Value::as_str) == Some("text") {
                if let Some(t) = block.get("text").and_then(Value::as_str) {
                    out.push_str(t);
                }
            }
        }
    }
    if out.is_empty() {
        if let Some(t) = message.get("text").and_then(Value::as_str) {
            out.push_str(t);
        }
    }
    out
}

fn codex_text(v: &Value, state: &mut ParseState) -> Option<String> {
    let ty = v.get("type").and_then(Value::as_str).unwrap_or("");
    if ty != "item.completed" && ty != "item.updated" {
        return None;
    }
    let item = v.get("item")?;
    if item.get("type").and_then(Value::as_str) != Some("agent_message") {
        return None;
    }
    let text = item.get("text").and_then(Value::as_str)?;
    if text.is_empty() {
        return None;
    }
    let item_id = item
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if state.last_codex_item.as_deref() == Some(item_id.as_str())
        && state.last_codex_text.as_deref() == Some(text)
    {
        return None;
    }
    state.last_codex_item = Some(item_id);
    state.last_codex_text = Some(text.to_string());
    state.got_text = true;
    Some(text.to_string())
}

fn acp_message_chunk(v: &Value) -> Option<String> {
    let method = v.get("method").and_then(Value::as_str).unwrap_or("");
    if method != "session/update" && method != "_x.ai/session/update" {
        return None;
    }
    let update = v.pointer("/params/update")?;
    if update.get("sessionUpdate").and_then(Value::as_str) != Some("agent_message_chunk") {
        return None;
    }
    update
        .pointer("/content/text")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

fn capture_session(v: &Value, state: &mut ParseState) {
    if state.session_id.is_some() {
        return;
    }
    for key in ["sessionId", "session_id", "thread_id"] {
        if let Some(id) = v.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()) {
            state.session_id = Some(id.to_string());
            return;
        }
    }
    if let Some(id) = v
        .pointer("/params/sessionId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        state.session_id = Some(id.to_string());
    }
}

fn json_error(v: &Value) -> Option<String> {
    let ty = v.get("type").and_then(Value::as_str).unwrap_or("");
    if ty == "error" || ty == "turn.failed" {
        return v
            .get("message")
            .or_else(|| v.pointer("/error/message"))
            .and_then(Value::as_str)
            .map(|s| s.to_string())
            .or_else(|| Some("CLI error".into()));
    }
    if v.get("is_error").and_then(Value::as_bool) == Some(true) {
        return v
            .get("result")
            .or_else(|| v.get("message"))
            .and_then(Value::as_str)
            .map(|s| s.to_string());
    }
    None
}

fn looks_json(line: &str) -> bool {
    let t = line.trim_start();
    t.starts_with('{') || t.starts_with('[')
}

pub fn strip_tui_noise(input: &str) -> String {
    let mut out = String::new();
    for line in input.replace('\r', "\n").lines() {
        if is_tui_noise_line(line) {
            continue;
        }
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(line.trim_end());
    }
    out.trim().to_string()
}

fn is_tui_noise_line(line: &str) -> bool {
    let t = line.trim();
    if t.is_empty() {
        return true;
    }
    let lower = t.to_ascii_lowercase();
    const PATTERNS: &[&str] = &[
        "starting session",
        "opt out",
        "opt-out",
        "? for shortcuts",
        "press ctrl",
        "ctrl+",
        "shift+tab",
        "to also allow",
        "mcp server",
        "mcp servers",
        "connected to mcp",
        "welcome to grok",
        "welcome to claude",
        "open in browser",
        "https://grok",
        "do you want to use",
        "spinner",
    ];
    if PATTERNS.iter().any(|p| lower.contains(p)) {
        return true;
    }
    let stripped: String = t.chars().filter(|c| !c.is_whitespace()).collect();
    stripped.chars().all(|c| matches!(c, '⠋' | '⠙' | '⠹' | '⠸' | '⠼' | '⠴' | '⠦' | '⠧' | '⠇' | '⠏' | '.' | '•'))
}

pub fn new_cli_uuid() -> String {
    let mut b = [0u8; 16];
    fill_random(&mut b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]
    )
}

fn fill_random(buf: &mut [u8]) {
    if let Ok(mut f) = File::open("/dev/urandom") {
        if f.read_exact(buf).is_ok() {
            return;
        }
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id() as u128;
    let mut n = nanos ^ (pid << 64) ^ nanos.rotate_left(17);
    for b in buf {
        *b = (n & 0xff) as u8;
        n = n.wrapping_mul(6364136223846793005).wrapping_add(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grok_line(line: &str) -> (Option<String>, ParseState) {
        let mut st = ParseState::default();
        let chunk = ingest_line(CliKind::Grok, line, &mut st);
        (chunk, st)
    }

    #[test]
    fn dead_session_ids_are_dropped() {
        // fresh id + failed turn -> the CLI never wrote that session
        assert!(session_is_dead(false, Some("CLI exited with status 1"), true));
        // stale stored id the CLI no longer knows -> start over
        assert!(session_is_dead(
            false,
            Some("No conversation found with session ID: abc"),
            false
        ));
        // resumed session that failed for another reason -> keep the history
        assert!(!session_is_dead(false, Some("overloaded_error"), false));
        // got a reply -> always keep
        assert!(!session_is_dead(true, Some("warning"), true));
        assert!(!session_is_dead(false, None, true));
    }

    #[test]
    fn grok_streaming_json_text_and_session() {
        let (chunk, _) = grok_line(r#"{"type":"thought","data":"planning"}"#);
        assert!(chunk.is_none());
        let (chunk, _) = grok_line(r#"{"type":"text","data":"Hello"}"#);
        assert_eq!(chunk.as_deref(), Some("Hello"));
        let (chunk, st) = grok_line(r#"{"type":"end","sessionId":"abc-123","stopReason":"end_turn"}"#);
        assert!(chunk.is_none());
        assert_eq!(st.session_id.as_deref(), Some("abc-123"));
    }

    #[test]
    fn grok_ignores_tool_and_mcp_events() {
        let (chunk, _) = grok_line(
            r#"{"type":"tool_call","toolCallId":"1","title":"MCP","toolName":"mcp"}"#,
        );
        assert!(chunk.is_none());
        let (chunk, _) = grok_line(r#"{"type":"available_commands","commands":["help"]}"#);
        assert!(chunk.is_none());
    }

    #[test]
    fn claude_prefers_text_deltas() {
        let mut st = ParseState::default();
        let d = ingest_line(
            CliKind::Claude,
            r#"{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"Hel"}}}"#,
            &mut st,
        );
        assert_eq!(d.as_deref(), Some("Hel"));
        let d = ingest_line(
            CliKind::Claude,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"}]}}"#,
            &mut st,
        );
        assert!(d.is_none());
        let mut st = ParseState::default();
        ingest_line(
            CliKind::Claude,
            r#"{"type":"system","subtype":"init","session_id":"sess-1"}"#,
            &mut st,
        );
        assert_eq!(st.session_id.as_deref(), Some("sess-1"));
        let d = ingest_line(
            CliKind::Claude,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Hi"}]}}"#,
            &mut st,
        );
        assert_eq!(d.as_deref(), Some("Hi"));
    }

    #[test]
    fn codex_agent_message_and_thread_id() {
        let mut st = ParseState::default();
        ingest_line(
            CliKind::Codex,
            r#"{"type":"thread.started","thread_id":"tid-9"}"#,
            &mut st,
        );
        assert_eq!(st.session_id.as_deref(), Some("tid-9"));
        let d = ingest_line(
            CliKind::Codex,
            r#"{"type":"item.completed","item":{"id":"item_3","type":"reasoning","text":"think"}}"#,
            &mut st,
        );
        assert!(d.is_none());
        let d = ingest_line(
            CliKind::Codex,
            r#"{"type":"item.completed","item":{"id":"item_4","type":"agent_message","text":"OK"}}"#,
            &mut st,
        );
        assert_eq!(d.as_deref(), Some("OK"));
    }

    #[test]
    fn strip_starting_session_and_opt_out() {
        let raw = "Starting session\nOpt out of sending data\n? for shortcuts\nHello there\nMCP servers connected\n";
        assert_eq!(strip_tui_noise(raw), "Hello there");
        assert!(strip_tui_noise("Starting session\nOpt out").is_empty());
    }

    #[test]
    fn uuid_is_lowercase_hyphenated() {
        let id = new_cli_uuid();
        assert_eq!(id.len(), 36);
        assert_eq!(id.chars().nth(14), Some('4'));
        assert!(id.chars().all(|c| c.is_ascii_hexdigit() || c == '-'));
    }
}
