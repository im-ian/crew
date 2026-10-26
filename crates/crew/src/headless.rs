use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use anyhow::Context;
use serde::{Deserialize, Serialize};
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
    pub interrupted: bool,
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
            interrupted: false,
        }),
    }))
}

pub fn clear_session(agent_id: &str) {
    let _ = fs::remove_file(paths::cli_session_path(agent_id));
    let _ = fs::remove_file(paths::cli_memory_path(agent_id));
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

/// Chat a bot had before it moved to this CLI, for the new session to read once.
pub fn save_recap(agent_id: &str, recap: &str) -> anyhow::Result<()> {
    let path = paths::cli_recap_path(agent_id);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, recap)?;
    Ok(())
}

fn load_recap(agent_id: &str) -> Option<String> {
    fs::read_to_string(paths::cli_recap_path(agent_id))
        .ok()
        .filter(|s| !s.trim().is_empty())
}

pub fn clear_recap(agent_id: &str) {
    let _ = fs::remove_file(paths::cli_recap_path(agent_id));
}

fn with_recap(recap: &str, prompt: &str) -> String {
    format!(
        "[crew recap] This bot just moved to you from another AI CLI. Below is the chat \
         so far, oldest first; `assistant` lines are the bot's earlier replies, errors \
         its old CLI printed included. Read it for context only; do not answer it. \
         Answer the message after it.\n<chat>\n{recap}\n</chat>\n\n{prompt}"
    )
}

fn with_prior(prior: &str, prompt: &str) -> String {
    format!(
        "[crew] Earlier chat, oldest first. Read it for context only; do not answer it. \
         Answer the message after it.\n<chat>\n{prior}\n</chat>\n\n{prompt}"
    )
}

/// The bot's memory as its CLI session knows it: `start` sits in the session's
/// system prompt, `seen` is the newest it has been told.
#[derive(Debug, PartialEq, Serialize, Deserialize)]
struct MemorySeen {
    start: String,
    seen: String,
}

fn load_memory_seen(agent_id: &str) -> Option<MemorySeen> {
    let raw = fs::read_to_string(paths::cli_memory_path(agent_id)).ok()?;
    serde_json::from_str(&raw).ok()
}

fn save_memory_seen(agent_id: &str, seen: &MemorySeen) -> anyhow::Result<()> {
    let path = paths::cli_memory_path(agent_id);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, serde_json::to_string(seen)?)?;
    Ok(())
}

/// What this turn's session knows of the memory, and a note for the prompt if
/// it changed since. claude and codex replay the system prompt a session
/// started with, and a new one there costs grok its prompt cache, so a resumed
/// session keeps its first memory in the system prompt and hears of changes
/// in the prompt instead.
fn memory_for_turn(
    resume: bool,
    known: Option<MemorySeen>,
    now: &str,
    prompt: &str,
) -> (MemorySeen, Option<String>) {
    if !resume {
        let fresh = MemorySeen {
            start: now.to_string(),
            seen: now.to_string(),
        };
        return (fresh, None);
    }
    // A session from before this was tracked is told once.
    let known = known.unwrap_or_else(|| MemorySeen {
        start: now.to_string(),
        seen: String::new(),
    });
    // A slash command only runs if it comes first, so the news waits a turn.
    if known.seen == now || prompt.starts_with('/') {
        return (known, None);
    }
    let told = MemorySeen {
        start: known.start,
        seen: now.to_string(),
    };
    (told, Some(memory_note(now)))
}

fn memory_note(memory: &str) -> String {
    let body = if memory.is_empty() { "(empty)" } else { memory };
    format!(
        "[crew system] Your memory changed since you last saw it. It is now as \
         below; use this instead of the `# Your memory` section in your \
         instructions.\n<memory>\n{body}\n</memory>"
    )
}

/// The system prompt keeps the instructions a session started with. Shared
/// memory, including the live teammate list, rides in the prompt on every
/// turn so a compact cannot leave an old copy as the only one. A slash
/// command has to stay the first line. A path is not a command.
fn shared_note_for_turn(
    prompt: &str,
    agent: &AgentConfig,
    roster: &[AgentConfig],
) -> Option<String> {
    if crate::daemon::is_slash_command(prompt) {
        return None;
    }
    Some(crate::config::shared_memory_note(
        agent,
        roster,
        &crate::memory::read_shared(),
    ))
}

/// Drop the CLI session so the next turn opens a new one. Refused mid-turn:
/// that turn would save its session back when it ends.
pub fn forget_session(session: &HeadlessSession) -> anyhow::Result<()> {
    let mut inner = session.inner.lock().expect("headless inner");
    if inner.status == AgentStatus::Working || inner.child.is_some() {
        anyhow::bail!("agent {} is working; switch once it finishes", session.id);
    }
    inner.session_id = None;
    clear_session(&session.id);
    Ok(())
}

pub fn kill(session: &HeadlessSession) {
    interrupt(session);
    if let Ok(mut inner) = session.inner.lock() {
        inner.session_id = None;
    }
    clear_session(&session.id);
}

/// Stop the in-flight child. Keeps the CLI session so a later turn can resume.
/// Does not undo already-sealed assistant text.
pub fn interrupt(session: &HeadlessSession) {
    let child = {
        let mut inner = match session.inner.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        inner.generation = inner.generation.wrapping_add(1);
        inner.interrupted = true;
        inner.child.take()
    };
    if let Some(mut child) = child {
        kill_all(&mut child);
    }
    if let Ok(mut inner) = session.inner.lock() {
        if inner.status != AgentStatus::Exited {
            inner.status = AgentStatus::Idle;
        }
        inner.seq += 1;
        inner.child = None;
    }
}

/// The CLI and what it started. npm's codex is a node launcher, and killing
/// the launcher alone left the CLI under it running on the bot's session.
fn kill_all(child: &mut Child) {
    // Not reaped yet, so its pid still names the group it leads.
    unsafe {
        libc::killpg(child.id() as libc::pid_t, libc::SIGKILL);
    }
    let _ = child.kill();
    let _ = child.wait();
}

pub fn is_interrupted(session: &HeadlessSession) -> bool {
    session.inner.lock().map(|i| i.interrupted).unwrap_or(false)
}

pub fn set_status(session: &HeadlessSession, status: AgentStatus) {
    if let Ok(mut inner) = session.inner.lock() {
        if inner.status == AgentStatus::Exited {
            return;
        }
        inner.status = status;
        inner.seq += 1;
    }
}

pub fn kick(
    session: Arc<HeadlessSession>,
    cfg: AgentConfig,
    roster: Vec<AgentConfig>,
    prompt: String,
    skip_rows: Vec<String>,
) -> anyhow::Result<()> {
    let generation = {
        let mut inner = session.inner.lock().expect("headless inner");
        if inner.status == AgentStatus::Working || inner.child.is_some() {
            anyhow::bail!("agent {} is working", session.id);
        }
        inner.interrupted = false;
        inner.status = AgentStatus::Working;
        inner.last_output = Instant::now();
        inner.seq += 1;
        inner.generation
    };
    crate::daemon::emit_agent_frame(&session.id);
    let thread_session = session.clone();
    if let Err(err) = std::thread::Builder::new()
        .name(format!("crew-turn-{}", session.id))
        .spawn(move || run_turn(thread_session, cfg, roster, prompt, generation, skip_rows))
    {
        if let Ok(mut inner) = session.inner.lock() {
            if inner.generation == generation {
                inner.status = AgentStatus::Idle;
                inner.seq += 1;
            }
        }
        crate::daemon::emit_agent_frame(&session.id);
        crate::daemon::pump_inbox(&session.id);
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
    skip_rows: Vec<String>,
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
    let turn = crate::transcript::begin_turn(&session.id);

    let program = cfg.binary_name();
    let stored = session
        .inner
        .lock()
        .ok()
        .and_then(|i| i.session_id.clone())
        .or_else(|| load_session(&session.id));
    // Prompt-mode CLIs have no per-bot resume flag. Inventing an id would be
    // saved here, and the next turn would skip the chat it still has to send.
    let (turn_session, created_id) = if cfg.prompt_mode() {
        (None, None)
    } else {
        match (program.as_str(), stored) {
            ("codex", Some(id)) => (Some(TurnSession { id, resume: true }), None),
            ("codex", None) => (None, None),
            (_, Some(id)) => (Some(TurnSession { id, resume: true }), None),
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
        }
    };
    if let Some(id) = created_id.as_ref() {
        if let Ok(mut inner) = session.inner.lock() {
            inner.session_id = Some(id.clone());
        }
    }

    // Only a new CLI session reads the recap: a resumed one already has it.
    // Prompt mode reads the live chat instead, so the file would repeat it.
    let recap = if cfg.prompt_mode() {
        None
    } else if turn_session.as_ref().map_or(true, |s| !s.resume) {
        load_recap(&session.id)
    } else {
        None
    };
    let prompt = match recap.as_deref() {
        Some(recap) => with_recap(recap, &prompt),
        None => prompt,
    };
    let resume = turn_session.as_ref().is_some_and(|s| s.resume);
    let memory_now = crate::memory::read(&session.id);
    let (memory_seen, memory_note) = memory_for_turn(
        resume,
        load_memory_seen(&session.id),
        memory_now.trim(),
        &prompt,
    );
    let shared_note = shared_note_for_turn(&prompt, &cfg, &roster);
    let prompt = match memory_note {
        Some(note) => format!("{note}\n\n{prompt}"),
        None => prompt,
    };
    // Second, so the live shared memory sits above a personal-memory note.
    let prompt = match shared_note {
        Some(note) => format!("{note}\n\n{prompt}"),
        None => prompt,
    };
    let prompt = if cfg.prompt_mode() {
        match crate::transcript::prior_recap_excluding(&session.id, &skip_rows) {
            Some(prior) => with_prior(&prior, &prompt),
            None => prompt,
        }
    } else {
        prompt
    };
    let argv = cfg.turn_cmd(&prompt, turn_session.as_ref(), &roster, &memory_seen.start);
    let cwd = crate::config::Config::default_cwd(&cfg);
    if let Err(err) = crate::paths::create_cwd(&cwd) {
        eprintln!("[crew] cwd {}: {err:#}", cwd.display());
    }
    let result = spawn_and_stream(&session, &argv, generation, turn, &cwd);

    if is_stale(&session, generation) {
        crate::transcript::end_turn_gen(&session.id, Some(turn));
        return;
    }

    match result {
        Ok(outcome) => {
            let dead = session_is_dead(
                outcome.got_text,
                outcome.error.as_deref(),
                created_id.is_some(),
                turn_session
                    .as_ref()
                    .filter(|s| s.resume)
                    .map(|s| s.id.as_str()),
            );
            // Used up by a turn that answered; one that failed leaves it for the
            // next. Codex may never name a thread, so a saved session is not the test.
            if recap.is_some() && outcome.got_text {
                clear_recap(&session.id);
            }
            // Like the recap: a turn that failed leaves the news for the next.
            if outcome.got_text && !dead {
                let _ = save_memory_seen(&session.id, &memory_seen);
            }
            if dead {
                if let Ok(mut inner) = session.inner.lock() {
                    inner.session_id = None;
                }
                clear_session(&session.id);
            } else if !cfg.prompt_mode() {
                if let Some(id) = outcome
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

    crate::transcript::end_turn_gen(&session.id, Some(turn));
    if let Ok(mut inner) = session.inner.lock() {
        inner.child = None;
        if inner.status != AgentStatus::Exited && inner.status != AgentStatus::Blocked {
            inner.status = AgentStatus::Idle;
        }
        inner.last_output = Instant::now();
        inner.seq += 1;
    }
    crate::daemon::emit_agent_frame(&session.id);
    // Before the inbox: the next turn replaces this origin.
    crate::daemon::turn_ended(&session.id);
    crate::daemon::pump_inbox(&session.id);
}

/// The turn was stopped (or its bot reset or removed) since it began.
fn is_stale(session: &HeadlessSession, generation: u64) -> bool {
    session
        .inner
        .lock()
        .map(|i| i.generation != generation)
        .unwrap_or(true)
}

/// A turn that died without a reply left no CLI conversation behind, so its id
/// must not be reused: resuming would point at a session the CLI never wrote.
/// Every CLI words a missing session differently ("No conversation found with
/// session ID", "no rollout found for thread id", "Session ... not found
/// locally"), but all of them quote the id, so look for that instead.
fn session_is_dead(
    got_text: bool,
    error: Option<&str>,
    fresh_id: bool,
    resumed_id: Option<&str>,
) -> bool {
    match error {
        Some(err) if !got_text => {
            fresh_id || resumed_id.map(|id| err.contains(id)).unwrap_or(false)
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
    turn: u64,
    cwd: &std::path::Path,
) -> anyhow::Result<TurnOutcome> {
    if argv.is_empty() {
        anyhow::bail!("empty command");
    }
    let program = paths::resolve_program(&argv[0]);
    let mut cmd = Command::new(program.as_os_str());
    for arg in argv.iter().skip(1) {
        cmd.arg(arg);
    }
    cmd.current_dir(cwd);
    cmd.env("PATH", paths::enriched_path());
    cmd.env("CREW_AGENT_ID", &session.id);
    cmd.env("CREW_HOME", paths::home_dir());
    // grok reads ~/.claude/CLAUDE.md, the user's own Claude Code setup, and goes
    // looking for its `@file` imports in the bot's folder before every answer.
    cmd.env("GROK_CLAUDE_AGENTS_ENABLED", "false");
    cmd.env("TERM", "dumb");
    cmd.env("NO_COLOR", "1");
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    // Its own group, so a stop reaches all of it (see `kill_all`).
    cmd.process_group(0);

    let mut child = cmd
        .spawn()
        .with_context(|| format!("spawn {} ({})", session.id, argv.join(" ")))?;
    let stdout = child.stdout.take().context("take stdout")?;
    let stderr = child.stderr.take();
    {
        let mut inner = session.inner.lock().expect("headless inner");
        if inner.generation != generation {
            kill_all(&mut child);
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

    // This turn's command, not the session's first one: a bot changes CLI in place.
    let cli = CliKind::from_program(&argv[0]);
    let mut state = ParseState::default();
    let mut plain = String::new();
    let mut sealed = false;
    let reader = BufReader::new(stdout);
    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(err) => return Err(err.into()),
        };
        // Keep draining so the CLI never blocks on a full pipe while it exits.
        // A stopped CLI's last lines are still in the pipe: read now, they land
        // under the user's stop or in the next turn's reply.
        if sealed || is_stale(session, generation) {
            continue;
        }
        let mut turn_end = false;
        // grok/claude/codex stream every reply as JSON, so a bare line there is
        // CLI chatter and must never become the answer. A text CLI's stdout is
        // the reply, so a line that starts with `{` or `[` stays.
        if cli != CliKind::Other {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) {
                for card in crate::tool_card::from_events(&v) {
                    if cli == CliKind::Claude && is_subagent_call(&v, &card.name) {
                        continue;
                    }
                    crate::transcript::push_tool(
                        &session.id,
                        card.id.as_deref(),
                        &card.name,
                        &card.detail,
                    );
                }
                if cli == CliKind::Claude {
                    for note in claude_subagent_notes(&v, &mut state) {
                        crate::transcript::push_subagent(
                            &session.id,
                            &note.key,
                            &note.from,
                            &note.text,
                        );
                    }
                }
                turn_end = is_turn_end(cli, &v);
            }
        }
        if let Some(chunk) = ingest_line(cli, &line, &mut state) {
            feed_text(cli, session, &chunk);
            if let Ok(mut inner) = session.inner.lock() {
                inner.last_output = Instant::now();
                inner.seq += 1;
            }
        } else if let Some(line) = other_reply_line(cli, &line) {
            if !plain.is_empty() {
                plain.push('\n');
            }
            plain.push_str(line);
        }
        if let Some(id) = state.session_id.as_ref() {
            if let Ok(mut inner) = session.inner.lock() {
                inner.session_id = Some(id.clone());
            }
        }
        // Without text the exit path still has an error to post, so wait for it.
        if turn_end && state.got_text {
            end_turn_early(session, generation, turn);
            sealed = true;
        }
    }

    let status = {
        let mut inner = session.inner.lock().expect("headless inner");
        // A stop took this turn's child. One there now is the next turn's, and
        // waiting on it here would hold the bot until that turn is over.
        if inner.generation != generation {
            None
        } else {
            inner.child.as_mut().and_then(|child| child.wait().ok())
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

/// Each CLI's own "turn over" event. The process outlives it by about a second
/// (session save, MCP shutdown), and the chat should not wait for that.
fn is_turn_end(cli: CliKind, v: &Value) -> bool {
    let ty = v.get("type").and_then(Value::as_str);
    match cli {
        CliKind::Grok => ty == Some("end"),
        CliKind::Claude => ty == Some("result"),
        CliKind::Codex => ty == Some("turn.completed"),
        CliKind::Other => false,
    }
}

/// Seal the reply and show the agent idle before the CLI exits. `inner.child`
/// stays set until exit, so a send in that gap still queues instead of resuming
/// a session the CLI is still writing; run_turn pumps the inbox after exit.
fn end_turn_early(session: &HeadlessSession, generation: u64, turn: u64) {
    crate::transcript::end_turn_gen(&session.id, Some(turn));
    if let Ok(mut inner) = session.inner.lock() {
        if inner.generation != generation {
            return;
        }
        if inner.status == AgentStatus::Working {
            inner.status = AgentStatus::Idle;
        }
        inner.seq += 1;
    }
    crate::daemon::emit_agent_frame(&session.id);
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
    tool_after_text: bool,
    /// Auto-compact starts this turn's stream over. Text after it is held
    /// while it still matches what the user already saw.
    compact_replay: bool,
    /// Tokens held since the compact, joined in arrival order.
    replay_buf: String,
    /// Assistant text this turn already showed. Chunks are joined as the CLI
    /// sent them, without the blank line added after a tool.
    spoken: String,
    /// `spawn_subagent` calls that have not finished. The child's reply is
    /// `text` on this same stream, with no field that marks it as the child's.
    open_subagents: HashSet<String>,
    /// This turn's Claude subagent calls: call id → the note peer the report
    /// is from. A later report for the same call replaces the first.
    claude_subagents: HashMap<String, String>,
}

fn other_reply_line(cli: CliKind, line: &str) -> Option<&str> {
    if cli != CliKind::Other || line.trim().is_empty() {
        None
    } else {
        Some(line)
    }
}

fn ingest_line(cli: CliKind, line: &str, state: &mut ParseState) -> Option<String> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    // A text CLI's stdout is the answer, not a protocol, so a JSON line must
    // not become a session id.
    if cli == CliKind::Other {
        return None;
    }
    let v: Value = serde_json::from_str(line).ok()?;
    capture_session(&v, state);
    if let Some(err) = json_error(&v) {
        state.error = Some(err);
    }
    let chunk = match cli {
        CliKind::Grok => grok_text(&v, state),
        CliKind::Claude => claude_text(&v, state),
        // Each codex message replaces the last, so there is nothing to glue.
        CliKind::Codex => return codex_text(&v, state),
        CliKind::Other => return None,
    };
    // Text before and after a tool call arrives as one stream; without a break
    // "I'll check." and the answer run together into one sentence.
    let chunk = chunk.map(|c| {
        if std::mem::take(&mut state.tool_after_text) {
            format!("\n\n{c}")
        } else {
            c
        }
    });
    // Armed after this event's own text: one claude message can hold the text
    // and the tool_use that follows it.
    if state.got_text && !crate::tool_card::from_events(&v).is_empty() {
        state.tool_after_text = true;
    }
    chunk
}

fn grok_text(v: &Value, state: &mut ParseState) -> Option<String> {
    note_subagent_call(v, state);
    let (_, kind) = grok_event(v);
    if matches!(
        kind,
        "auto_compact_started" | "auto_compact_completed" | "compaction_checkpoint"
    ) {
        if !state.compact_replay {
            state.replay_buf.clear();
        }
        state.compact_replay = true;
        return None;
    }
    if matches!(kind, "auto_compact_failed" | "auto_compact_cancelled") {
        state.compact_replay = false;
        state.replay_buf.clear();
        return None;
    }
    if let Some(chunk) = acp_message_chunk(v) {
        return grok_reply(chunk, state);
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
            grok_reply(chunk, state)
        }
        "thought" | "tool_call" | "tool_call_update" | "usage" | "plan" | "available_commands"
        | "end" => None,
        _ => None,
    }
}

/// The child's reply sits between the spawn and that call's terminal update.
/// The parent's own reply is what arrives after the tool finishes.
fn grok_reply(chunk: String, state: &mut ParseState) -> Option<String> {
    if !state.open_subagents.is_empty() {
        return None;
    }
    let Some(chunk) = fresh_after_compact(state, chunk) else {
        return None;
    };
    state.used_deltas = true;
    state.got_text = true;
    state.spoken.push_str(&chunk);
    Some(chunk)
}

/// Streaming-json sends one token at a time, and a compact may repeat the
/// sentence the user already has. Hold tokens while they still match that
/// sentence. A different sentence is shown as soon as it diverges.
fn fresh_after_compact(state: &mut ParseState, chunk: String) -> Option<String> {
    if !state.compact_replay {
        return Some(chunk);
    }
    if chunk.trim().is_empty() {
        return None;
    }
    if state.spoken.is_empty() {
        state.compact_replay = false;
        return Some(chunk);
    }
    let shown = state.spoken.clone();
    state.replay_buf.push_str(&chunk);
    if shown.starts_with(&state.replay_buf) {
        return None;
    }
    let buf = std::mem::take(&mut state.replay_buf);
    state.compact_replay = false;
    if let Some(extra) = buf.strip_prefix(&shown) {
        let extra = extra.trim_start_matches('\n');
        if extra.is_empty() {
            return None;
        }
        return Some(extra.to_string());
    }
    Some(buf)
}

fn note_subagent_call(v: &Value, state: &mut ParseState) {
    let (event, kind) = grok_event(v);
    let Some(id) = event
        .get("toolCallId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    else {
        return;
    };
    match kind {
        "tool_call" => {
            if event.get("toolName").and_then(Value::as_str) == Some("spawn_subagent") {
                state.open_subagents.insert(id.to_string());
            }
        }
        "tool_call_update" if state.open_subagents.contains(id) => {
            let status = event.get("status").and_then(Value::as_str).unwrap_or("");
            if matches!(
                status,
                "completed" | "failed" | "cancelled" | "canceled" | "error"
            ) {
                state.open_subagents.remove(id);
            }
        }
        _ => {}
    }
}

/// Streaming-json tags the event with `type`. ACP puts the same names on
/// `sessionUpdate` under `params.update`.
fn grok_event(v: &Value) -> (&Value, &str) {
    if let Some(update) = v.pointer("/params/update") {
        let kind = update
            .get("sessionUpdate")
            .and_then(Value::as_str)
            .unwrap_or("");
        return (update, kind);
    }
    (v, v.get("type").and_then(Value::as_str).unwrap_or(""))
}

/// Claude's subagent tool. It was `Task` before it was `Agent`.
fn is_subagent_tool(name: &str) -> bool {
    matches!(name, "Agent" | "Task")
}

/// A line from inside a subagent: it carries the call that started it.
fn from_subagent(v: &Value) -> bool {
    v.get("parent_tool_use_id").is_some_and(|p| !p.is_null())
}

/// The bot's own subagent call, which its notes stand in for.
fn is_subagent_call(v: &Value, name: &str) -> bool {
    is_subagent_tool(name) && !from_subagent(v)
}

#[derive(Debug, PartialEq)]
struct SubagentNote {
    /// Keeps one row per note: a later report for a call replaces the first.
    key: String,
    from: String,
    text: String,
}

/// A Claude subagent as a note exchange, like a teammate's: the prompt the bot
/// hands over, then the report it gets back. Each call is a peer of its own,
/// `sub:<call id>:<type>`, so two running at once do not share a side chat.
fn claude_subagent_notes(v: &Value, state: &mut ParseState) -> Vec<SubagentNote> {
    let mut out = Vec::new();
    match v.get("type").and_then(Value::as_str) {
        Some("assistant") if !from_subagent(v) => {
            let blocks = v.pointer("/message/content").and_then(Value::as_array);
            for block in blocks.into_iter().flatten() {
                let name = block.get("name").and_then(Value::as_str).unwrap_or("");
                if block.get("type").and_then(Value::as_str) != Some("tool_use")
                    || !is_subagent_tool(name)
                {
                    continue;
                }
                let id = block.get("id").and_then(Value::as_str);
                let prompt = block.pointer("/input/prompt").and_then(Value::as_str);
                let (Some(id), Some(prompt)) = (id, prompt) else {
                    continue;
                };
                let kind = block
                    .pointer("/input/subagent_type")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .unwrap_or("general-purpose");
                let peer = format!("sub:{id}:{kind}");
                out.push(SubagentNote {
                    key: id.to_string(),
                    from: format!("to:{peer}"),
                    text: prompt.to_string(),
                });
                state.claude_subagents.insert(id.to_string(), peer);
            }
        }
        // The tool result wraps the report in a hand-back frame; this is the
        // report alone.
        Some("system") if v.get("subtype").and_then(Value::as_str) == Some("task_notification") => {
            let Some(id) = v.get("tool_use_id").and_then(Value::as_str) else {
                return out;
            };
            if let (Some(peer), Some(text)) = (state.claude_subagents.get(id), subagent_report(v)) {
                out.push(SubagentNote {
                    key: format!("{id}/report"),
                    from: peer.clone(),
                    text,
                });
            }
        }
        _ => {}
    }
    out
}

/// What a finished subagent handed back. Failed or stopped, `summary` is not a
/// report, and a withheld hand-back's `summary` is notes for the model.
fn subagent_report(v: &Value) -> Option<String> {
    if v.get("status").and_then(Value::as_str) != Some("completed") {
        return None;
    }
    let report = if let Some(handback) = v.get("handback_report") {
        let text = handback.get("text").and_then(Value::as_str)?.trim();
        match handback
            .get("warning")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|w| !w.is_empty())
        {
            Some(warning) => format!("{warning}\n\n{text}"),
            None => text.to_string(),
        }
    } else if v.get("handback").and_then(Value::as_str) == Some("withheld") {
        return None;
    } else {
        v.get("summary").and_then(Value::as_str)?.trim().to_string()
    };
    (!report.is_empty()).then_some(report)
}

fn claude_text(v: &Value, state: &mut ParseState) -> Option<String> {
    // A subagent's words are its report's business, not the bot's reply.
    if from_subagent(v) {
        return None;
    }
    if let Some(delta) = claude_text_delta(v) {
        state.used_deltas = true;
        state.got_text = true;
        return Some(delta);
    }
    if let Some(out) = local_command_output(v) {
        state.got_text = true;
        return Some(out);
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

/// What a slash command such as `/compact` printed. The CLI answers it itself,
/// as a user row in this tag, and the model says nothing: without it the turn
/// ended blank, and the bot read as having ignored or hung on the request.
fn local_command_output(v: &Value) -> Option<String> {
    if v.get("type").and_then(Value::as_str) != Some("user") {
        return None;
    }
    let out = v
        .pointer("/message/content")?
        .as_str()?
        .trim()
        .strip_prefix("<local-command-stdout>")?
        .strip_suffix("</local-command-stdout>")?
        .trim();
    (!out.is_empty()).then(|| out.to_string())
}

fn claude_text_delta(v: &Value) -> Option<String> {
    let event = if v.get("type").and_then(Value::as_str) == Some("stream_event") {
        v.get("event").unwrap_or(v)
    } else {
        v
    };
    let delta = event
        .get("delta")
        .or_else(|| event.get("event").and_then(|e| e.get("delta")))?;
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
    stripped.chars().all(|c| {
        matches!(
            c,
            '⠋' | '⠙' | '⠹' | '⠸' | '⠼' | '⠴' | '⠦' | '⠧' | '⠇' | '⠏' | '.' | '•'
        )
    })
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
    fn turn_end_is_each_clis_own_event() {
        let end = |cli, line: &str| is_turn_end(cli, &serde_json::from_str(line).unwrap());
        assert!(end(CliKind::Grok, r#"{"type":"end"}"#));
        assert!(end(CliKind::Claude, r#"{"type":"result","subtype":"success"}"#));
        assert!(end(CliKind::Codex, r#"{"type":"turn.completed"}"#));
        // a failed codex turn has no text, so it waits for exit to post the error
        assert!(!end(CliKind::Codex, r#"{"type":"turn.failed"}"#));
        assert!(!end(CliKind::Claude, r#"{"type":"assistant"}"#));
        assert!(!end(CliKind::Other, r#"{"type":"end"}"#));
    }

    #[test]
    fn other_keeps_lines_that_look_like_json() {
        assert_eq!(other_reply_line(CliKind::Other, "[see](url)"), Some("[see](url)"));
        assert_eq!(
            other_reply_line(CliKind::Other, r#"{"a":1}"#),
            Some(r#"{"a":1}"#)
        );
        assert_eq!(other_reply_line(CliKind::Other, "  "), None);
        assert_eq!(other_reply_line(CliKind::Grok, "hello"), None);
        let mut state = ParseState::default();
        assert!(ingest_line(CliKind::Other, r#"{"session_id":"abc"}"#, &mut state).is_none());
        assert!(state.session_id.is_none());
    }

    #[test]
    fn dead_session_ids_are_dropped() {
        let id = "00000000-0000-4000-8000-000000000000";
        // fresh id + failed turn -> the CLI never wrote that session
        assert!(session_is_dead(
            false,
            Some("CLI exited with status 1"),
            true,
            None
        ));
        // stale stored id, in each CLI's own wording -> start over
        for err in [
            "No conversation found with session ID: 00000000-0000-4000-8000-000000000000",
            "Error: thread/resume failed: no rollout found for thread id \
             00000000-0000-4000-8000-000000000000 (code -32600)",
            "Session \"00000000-0000-4000-8000-000000000000\" not found locally, \
             restoring conversation from remote...",
        ] {
            assert!(session_is_dead(false, Some(err), false, Some(id)), "{err}");
        }
        // resumed session that failed for another reason -> keep the history
        assert!(!session_is_dead(
            false,
            Some("overloaded_error"),
            false,
            Some(id)
        ));
        // got a reply -> always keep
        assert!(!session_is_dead(true, Some("warning"), true, Some(id)));
        assert!(!session_is_dead(false, None, true, None));
    }

    #[test]
    fn grok_streaming_json_text_and_session() {
        let (chunk, _) = grok_line(r#"{"type":"thought","data":"planning"}"#);
        assert!(chunk.is_none());
        let (chunk, _) = grok_line(r#"{"type":"text","data":"Hello"}"#);
        assert_eq!(chunk.as_deref(), Some("Hello"));
        let (chunk, st) =
            grok_line(r#"{"type":"end","sessionId":"abc-123","stopReason":"end_turn"}"#);
        assert!(chunk.is_none());
        assert_eq!(st.session_id.as_deref(), Some("abc-123"));
    }

    fn grok_message(text: &str) -> String {
        format!(
            r#"{{"method":"session/update","params":{{"update":{{"sessionUpdate":"agent_message_chunk","content":{{"type":"text","text":"{text}"}}}}}}}}"#
        )
    }

    #[test]
    fn grok_compact_does_not_repeat_the_message_on_screen() {
        let mut st = ParseState::default();
        let said = "남은 두 건을 이어서 보겠습니다.";
        let first = ingest_line(CliKind::Grok, &grok_message(said), &mut st);
        assert_eq!(first.as_deref(), Some(said));
        ingest_line(
            CliKind::Grok,
            r#"{"type":"tool_call","toolCallId":"1","toolName":"grep"}"#,
            &mut st,
        );
        assert!(ingest_line(
            CliKind::Grok,
            r#"{"method":"_x.ai/session/update","params":{"update":{"sessionUpdate":"auto_compact_completed"}}}"#,
            &mut st,
        )
        .is_none());
        assert!(ingest_line(CliKind::Grok, &grok_message(said), &mut st).is_none());
        let next = ingest_line(CliKind::Grok, &grok_message("원인을 찾았습니다."), &mut st);
        assert_eq!(next.as_deref(), Some("\n\n원인을 찾았습니다."));
    }

    #[test]
    fn grok_compact_keeps_only_the_new_tail() {
        let mut st = ParseState::default();
        let said = "남은 두 건을 이어서 보겠습니다.";
        ingest_line(CliKind::Grok, &grok_message(said), &mut st);
        ingest_line(
            CliKind::Grok,
            r#"{"method":"session/update","params":{"update":{"sessionUpdate":"auto_compact_started"}}}"#,
            &mut st,
        );
        let grown = format!("{said} 코드에서 찾았습니다.");
        let next = ingest_line(CliKind::Grok, &grok_message(&grown), &mut st);
        assert_eq!(next.as_deref(), Some(" 코드에서 찾았습니다."));
    }

    fn grok_tokens(st: &mut ParseState, parts: &[&str]) -> String {
        let mut out = String::new();
        for part in parts {
            let line = format!(r#"{{"type":"text","data":"{part}"}}"#);
            if let Some(chunk) = ingest_line(CliKind::Grok, &line, st) {
                out.push_str(&chunk);
            }
        }
        out
    }

    #[test]
    fn grok_compact_drops_a_replay_that_arrives_as_tokens() {
        let mut st = ParseState::default();
        let parts = ["남은", " 두", " 건을", " 보겠습니다", "."];
        assert_eq!(grok_tokens(&mut st, &parts), "남은 두 건을 보겠습니다.");
        ingest_line(
            CliKind::Grok,
            r#"{"type":"tool_call","toolCallId":"1","toolName":"grep"}"#,
            &mut st,
        );
        assert!(ingest_line(
            CliKind::Grok,
            r#"{"type":"auto_compact_completed","tokens_before":1,"tokens_after":1}"#,
            &mut st,
        )
        .is_none());
        assert_eq!(grok_tokens(&mut st, &["\n\n"]), "");
        assert_eq!(grok_tokens(&mut st, &parts), "");
        assert_eq!(
            grok_tokens(&mut st, &[" 원인을", " 찾았습니다."]),
            "\n\n 원인을 찾았습니다."
        );
    }

    #[test]
    fn grok_compact_shows_a_different_sentence_from_its_first_new_token() {
        let mut st = ParseState::default();
        assert_eq!(grok_tokens(&mut st, &["남은", " 두 건"]), "남은 두 건");
        ingest_line(
            CliKind::Grok,
            r#"{"type":"auto_compact_completed"}"#,
            &mut st,
        );
        assert_eq!(
            grok_tokens(&mut st, &["남은", " 일을", " 합니다."]),
            "남은 일을 합니다."
        );
    }

    #[test]
    fn grok_keeps_a_repeated_sentence_when_nothing_compacted() {
        let mut st = ParseState::default();
        let said = "다시 말합니다.";
        assert_eq!(
            ingest_line(CliKind::Grok, &grok_message(said), &mut st).as_deref(),
            Some(said)
        );
        ingest_line(
            CliKind::Grok,
            r#"{"type":"tool_call","toolCallId":"1","toolName":"grep"}"#,
            &mut st,
        );
        assert_eq!(
            ingest_line(CliKind::Grok, &grok_message(said), &mut st).as_deref(),
            Some("\n\n다시 말합니다.")
        );
    }

    #[test]
    fn grok_ignores_tool_and_mcp_events() {
        let (chunk, _) =
            grok_line(r#"{"type":"tool_call","toolCallId":"1","title":"MCP","toolName":"mcp"}"#);
        assert!(chunk.is_none());
        let (chunk, _) = grok_line(r#"{"type":"available_commands","commands":["help"]}"#);
        assert!(chunk.is_none());
    }

    #[test]
    fn subagent_reply_stays_out_of_the_chat() {
        let mut st = ParseState::default();
        let d = ingest_line(
            CliKind::Grok,
            r#"{"type":"text","data":"I'll start the review."}"#,
            &mut st,
        );
        assert_eq!(d.as_deref(), Some("I'll start the review."));
        ingest_line(
            CliKind::Grok,
            r#"{"type":"tool_call","toolCallId":"call-1","toolName":"spawn_subagent","status":"pending"}"#,
            &mut st,
        );
        // An in-progress update has no status. It must not open the chat again.
        ingest_line(
            CliKind::Grok,
            r#"{"type":"tool_call_update","toolCallId":"call-1","status":null}"#,
            &mut st,
        );
        assert!(ingest_line(
            CliKind::Grok,
            r#"{"type":"thought","data":"checking the diff"}"#,
            &mut st
        )
        .is_none());
        assert!(ingest_line(
            CliKind::Grok,
            r#"{"type":"text","data":"I'll review the diff."}"#,
            &mut st
        )
        .is_none());
        assert!(ingest_line(
            CliKind::Grok,
            r#"{"type":"text","data":"Review notes are at /tmp/x.md."}"#,
            &mut st
        )
        .is_none());
        ingest_line(
            CliKind::Grok,
            r#"{"type":"tool_call_update","toolCallId":"call-1","status":"completed"}"#,
            &mut st,
        );
        let d = ingest_line(
            CliKind::Grok,
            r#"{"type":"text","data":"리뷰가 끝났습니다."}"#,
            &mut st,
        );
        assert_eq!(d.as_deref(), Some("\n\n리뷰가 끝났습니다."));
    }

    #[test]
    fn parallel_subagents_hide_text_until_the_last_finishes() {
        let mut st = ParseState::default();
        ingest_line(
            CliKind::Grok,
            r#"{"type":"tool_call","toolCallId":"a","toolName":"spawn_subagent"}"#,
            &mut st,
        );
        ingest_line(
            CliKind::Grok,
            r#"{"type":"tool_call","toolCallId":"b","toolName":"spawn_subagent"}"#,
            &mut st,
        );
        ingest_line(
            CliKind::Grok,
            r#"{"type":"tool_call_update","toolCallId":"a","status":"completed"}"#,
            &mut st,
        );
        assert!(ingest_line(
            CliKind::Grok,
            r#"{"type":"text","data":"still reviewing"}"#,
            &mut st
        )
        .is_none());
        ingest_line(
            CliKind::Grok,
            r#"{"type":"tool_call_update","toolCallId":"b","status":"failed"}"#,
            &mut st,
        );
        let d = ingest_line(
            CliKind::Grok,
            r#"{"type":"text","data":"둘 다 끝났습니다."}"#,
            &mut st,
        );
        assert_eq!(d.as_deref(), Some("둘 다 끝났습니다."));
    }

    fn note(key: &str, from: &str, text: &str) -> SubagentNote {
        SubagentNote {
            key: key.into(),
            from: from.into(),
            text: text.into(),
        }
    }

    #[test]
    fn a_claude_subagent_is_a_note_exchange() {
        let mut st = ParseState::default();
        let mut notes = |line: &str| {
            let v: Value = serde_json::from_str(line).unwrap();
            claude_subagent_notes(&v, &mut st)
        };
        let start: Value = serde_json::from_str(
            r#"{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","id":"toolu_1","name":"Agent","input":{}}},"parent_tool_use_id":null}"#,
        )
        .unwrap();
        assert!(
            is_subagent_call(&start, "Agent"),
            "the notes stand in for its card"
        );
        assert_eq!(
            notes(
                r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"Agent","input":{"description":"Find it","subagent_type":"Explore","prompt":"Where is the parser?"}}]},"parent_tool_use_id":null}"#
            ),
            [note(
                "toolu_1",
                "to:sub:toolu_1:Explore",
                "Where is the parser?"
            )]
        );
        // The subagent's own calls stay tool cards, a subagent of its own too.
        let inner = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_2","name":"Agent","input":{"prompt":"deeper"}}]},"parent_tool_use_id":"toolu_1"}"#;
        assert!(!is_subagent_call(
            &serde_json::from_str(inner).unwrap(),
            "Agent"
        ));
        assert!(notes(inner).is_empty());
        // A background shell finishing is a task too.
        assert!(notes(
            r#"{"type":"system","subtype":"task_notification","tool_use_id":"toolu_9","status":"completed","summary":"Background command completed"}"#
        )
        .is_empty());
        assert_eq!(
            notes(
                r#"{"type":"system","subtype":"task_notification","tool_use_id":"toolu_1","status":"completed","summary":"It is in headless.rs.\n"}"#
            ),
            [note(
                "toolu_1/report",
                "sub:toolu_1:Explore",
                "It is in headless.rs."
            )]
        );
        // A later notification for the call replaces the report it showed.
        assert_eq!(
            notes(
                r#"{"type":"system","subtype":"task_notification","tool_use_id":"toolu_1","status":"completed","handback":"flagged","summary":"notes for the model","handback_report":{"text":"It moved to parse.rs.","warning":"SECURITY WARNING"}}"#
            ),
            [note(
                "toolu_1/report",
                "sub:toolu_1:Explore",
                "SECURITY WARNING\n\nIt moved to parse.rs."
            )]
        );
        assert_eq!(
            notes(
                r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_3","name":"Task","input":{"prompt":"Say hi"}}]}}"#
            ),
            [note("toolu_3", "to:sub:toolu_3:general-purpose", "Say hi")]
        );
    }

    #[test]
    fn a_subagent_that_did_not_report_has_no_report() {
        let report = |line: &str| subagent_report(&serde_json::from_str(line).unwrap());
        assert_eq!(report(r#"{"status":"failed","summary":"API error"}"#), None);
        assert_eq!(
            report(r#"{"status":"stopped","summary":"Stopped by user"}"#),
            None
        );
        assert_eq!(
            report(r#"{"status":"completed","handback":"withheld","summary":"notes"}"#),
            None
        );
        assert_eq!(
            report(r#"{"status":"completed","handback":"send","summary":"Done."}"#).as_deref(),
            Some("Done.")
        );
    }

    #[test]
    fn a_subagents_words_stay_out_of_the_reply() {
        let mut st = ParseState::default();
        let d = ingest_line(
            CliKind::Claude,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Let me look."}]},"parent_tool_use_id":"toolu_1"}"#,
            &mut st,
        );
        assert_eq!(d, None);
        assert!(!st.got_text);
    }

    #[test]
    fn a_different_tool_still_shows_the_reply() {
        let mut st = ParseState::default();
        ingest_line(
            CliKind::Grok,
            r#"{"type":"tool_call","toolCallId":"1","toolName":"read_file"}"#,
            &mut st,
        );
        let d = ingest_line(
            CliKind::Grok,
            r#"{"type":"text","data":"읽었습니다."}"#,
            &mut st,
        );
        assert_eq!(d.as_deref(), Some("읽었습니다."));
    }

    #[test]
    fn tool_call_between_text_starts_a_new_paragraph() {
        let mut st = ParseState::default();
        let tool = r#"{"type":"tool_call","toolCallId":"1","toolName":"read_file"}"#;
        ingest_line(CliKind::Grok, tool, &mut st);
        let d = ingest_line(
            CliKind::Grok,
            r#"{"type":"text","data":"Let me check."}"#,
            &mut st,
        );
        assert_eq!(
            d.as_deref(),
            Some("Let me check."),
            "a tool before any text adds nothing"
        );
        ingest_line(CliKind::Grok, tool, &mut st);
        let d = ingest_line(CliKind::Grok, r#"{"type":"text","data":"Hi."}"#, &mut st);
        assert_eq!(d.as_deref(), Some("\n\nHi."));
        let d = ingest_line(CliKind::Grok, r#"{"type":"text","data":" More."}"#, &mut st);
        assert_eq!(
            d.as_deref(),
            Some(" More."),
            "only the first chunk after the tool"
        );
    }

    #[test]
    fn claude_breaks_after_the_text_its_tool_use_follows() {
        let mut st = ParseState::default();
        let d = ingest_line(
            CliKind::Claude,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Let me check."},{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"x"}}]}}"#,
            &mut st,
        );
        assert_eq!(d.as_deref(), Some("Let me check."));
        let d = ingest_line(
            CliKind::Claude,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"It says 42."}]}}"#,
            &mut st,
        );
        assert_eq!(d.as_deref(), Some("\n\nIt says 42."));

        let mut st = ParseState::default();
        let delta = |t: &str| {
            format!(
                r#"{{"type":"stream_event","event":{{"delta":{{"type":"text_delta","text":"{t}"}}}}}}"#
            )
        };
        ingest_line(CliKind::Claude, &delta("Let me check."), &mut st);
        ingest_line(
            CliKind::Claude,
            r#"{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","id":"t1","name":"Read","input":{}}}}"#,
            &mut st,
        );
        let d = ingest_line(CliKind::Claude, &delta("It says 42."), &mut st);
        assert_eq!(d.as_deref(), Some("\n\nIt says 42."));
    }

    /// What `claude -p --resume <id> /compact` prints: a summary row, the
    /// command's own output, and a result with no text.
    #[test]
    fn a_slash_command_answers_with_what_the_cli_printed() {
        let mut st = ParseState::default();
        let summary = r#"{"type":"user","message":{"role":"user","content":"This session is being continued from a previous conversation that ran out of context."}}"#;
        assert!(ingest_line(CliKind::Claude, summary, &mut st).is_none());
        let tool = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"<local-command-stdout>ls</local-command-stdout>"}]}}"#;
        assert!(ingest_line(CliKind::Claude, tool, &mut st).is_none());
        assert!(!st.got_text);
        let out = r#"{"type":"user","message":{"role":"user","content":"<local-command-stdout>Compacted </local-command-stdout>"}}"#;
        assert_eq!(
            ingest_line(CliKind::Claude, out, &mut st).as_deref(),
            Some("Compacted")
        );
        assert!(st.got_text, "the turn has its answer");
        let end = r#"{"type":"result","subtype":"success","is_error":false,"result":""}"#;
        assert!(ingest_line(CliKind::Claude, end, &mut st).is_none());
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
    fn a_resumed_session_keeps_its_first_memory_and_hears_of_changes() {
        let seen = |start: &str, seen: &str| MemorySeen {
            start: start.into(),
            seen: seen.into(),
        };
        let turn = |resume, known, now| memory_for_turn(resume, known, now, "hi");
        // A new session gets the memory in its system prompt and no note.
        assert_eq!(turn(false, Some(seen("a", "b")), "c"), (seen("c", "c"), None));
        // Nothing changed: same system prompt, no note.
        assert_eq!(turn(true, Some(seen("a", "a")), "a"), (seen("a", "a"), None));
        // Changed: the system prompt keeps "a", the note carries "b".
        let (k, note) = turn(true, Some(seen("a", "a")), "b");
        assert_eq!(k, seen("a", "b"));
        assert!(note.unwrap().contains("<memory>\nb\n</memory>"));
        // Told once, not again.
        assert_eq!(turn(true, Some(seen("a", "b")), "b"), (seen("a", "b"), None));
        // Emptied.
        let (_, note) = turn(true, Some(seen("a", "a")), "");
        assert!(note.unwrap().contains("(empty)"));
        // A session from before tracking is told once, unless there is nothing.
        let (k, note) = turn(true, None, "b");
        assert_eq!(k, seen("b", "b"));
        assert!(note.is_some());
        assert_eq!(turn(true, None, ""), (seen("", ""), None));
        // A slash command keeps the news for the next turn.
        let wait = memory_for_turn(true, Some(seen("a", "a")), "b", "/compact");
        assert_eq!(wait, (seen("a", "a"), None));
        let (k, note) = memory_for_turn(true, None, "b", "/compact");
        assert!(note.is_none());
        assert!(turn(true, Some(k), "b").1.is_some());
    }

    #[test]
    fn every_turn_opens_with_shared_memory() {
        crate::paths::testing::with_home("shared-turn", || {
            crate::memory::write_shared("harbor is closed").unwrap();
            let alpha = AgentConfig::new("alpha".into(), "Alpha".into(), vec!["grok".into()], None);
            let beta = AgentConfig::new("beta".into(), "Beta".into(), vec!["grok".into()], None);
            let roster = [alpha.clone(), beta];
            let note = shared_note_for_turn("hi", &alpha, &roster).unwrap();
            assert!(note.contains("Shared memory"));
            assert!(note.contains("beta — Beta"));
            assert!(note.contains("You are `alpha` (Alpha)."));
            assert!(note.contains("harbor is closed"));
            assert!(shared_note_for_turn("/compact", &alpha, &roster).is_none());
            assert!(shared_note_for_turn("/compact keep the API notes", &alpha, &roster).is_none());
            let path = shared_note_for_turn("/Users/me/shot.png 이거 봐줘", &alpha, &roster)
                .expect("a path still gets the live list");
            assert!(path.contains("beta — Beta"));
        });
    }

    #[test]
    fn uuid_is_lowercase_hyphenated() {
        let id = new_cli_uuid();
        assert_eq!(id.len(), 36);
        assert_eq!(id.chars().nth(14), Some('4'));
        assert!(id.chars().all(|c| c.is_ascii_hexdigit() || c == '-'));
    }
}
