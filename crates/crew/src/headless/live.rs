//! Claude, grok, agy and codex kept up between turns.
//!
//! A turn used to be its own process, and the CLI keeps that process up past
//! its answer while a task it put in the background runs. A send in that time
//! waited for the task, forever for a dev server, and stopping the CLI to let
//! it through stopped the task too. Now one process stays up and reads each
//! prompt from stdin: Claude as a stream-json line, grok and agy as an ACP
//! `session/prompt` request, codex as an app-server `turn/start` (JSON-RPC, a
//! line each way). A turn ends at Claude's `result`, at the answer to grok or
//! agy's request, or at codex's `turn/completed`; the next prompt goes to the
//! same process, and its background tasks go on.
//!
//! One reader thread owns the process's stdout. Each turn gets the lines up
//! to its end over a channel. Lines that come while no turn is open are the
//! CLI's own: the task list, a subagent's notes, and the reply Claude or grok
//! starts by itself once a task ends, which becomes a turn of its own.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, ExitStatus, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use anyhow::Context;
use serde_json::Value;

use super::{
    apply_grok_stdout, arm_first_output_watch, claude_background, claude_subagent_notes,
    cli_command, end_turn_early, event_session_id, grok_event, is_claude_turn_start, is_stale,
    is_turn_end, keep_background, kill_all, note_claude_background, note_sealed_grok_child,
    note_stdout, release_sealed_if_idle, settle_grok_reply, show_compacts, stream_line,
    strip_tui_noise, CliKind, HeadlessInner, HeadlessSession, ParseState, SubagentNote,
    TurnOutcome,
};
use crate::config::AcpCli;
use crate::protocol::{AgentStatus, Watch};

pub(super) struct LiveCli {
    /// Which process this is, so a reader can tell its own from the next.
    serial: u64,
    proto: Proto,
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    started: Started,
    /// Turns given this process's lines, oldest first. Each ends at its end
    /// (see `TurnEnd`), including one that was stopped.
    turns: VecDeque<Sink>,
    /// The CLI's latest list of tasks running in the background.
    background: Vec<(String, Watch)>,
    /// ACP: the session the process opened or loaded, once it has.
    acp_session: Option<String>,
    /// ACP: the id of the next request.
    next_id: u64,
    /// ACP: what the last turn knew of grok's subagents. Their notes go on
    /// between turns, and the next turn goes on from here.
    grok_state: Option<ParseState>,
    /// Claude: subagents still running after the reply, so a report that
    /// arrives once the turn has closed can let the bot go idle.
    claude_state: Option<ParseState>,
    /// Codex: the turn app-server is running, so a stop can interrupt it.
    /// Cleared when that turn completes, so a stop never interrupts the last one.
    turn_id: Option<String>,
    /// Codex: the thread's approval policy. `never` is `--yolo`.
    approval: Option<String>,
    /// Process group leader. Recorded so a daemon that dies can reap it.
    pid: u32,
}

impl Drop for LiveCli {
    fn drop(&mut self) {
        super::forget_live_cli(self.pid);
    }
}

/// How a process takes prompts and ends turns.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Proto {
    /// stream-json on stdin, a turn ends at `result`.
    Claude,
    /// ACP: a `session/prompt` request, a turn ends at its answer.
    Acp(AcpCli),
    /// app-server: a `turn/start` request, a turn ends at `turn/completed`.
    Codex,
}

impl Proto {
    /// The CLI whose limit the first-output watch keeps. agy prints nothing
    /// before its answer, as on a turn of its own.
    fn cli(self) -> CliKind {
        match self {
            Proto::Claude => CliKind::Claude,
            Proto::Acp(AcpCli::Grok) => CliKind::Grok,
            Proto::Acp(AcpCli::Agy) => CliKind::Other,
            Proto::Codex => CliKind::Codex,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Proto::Claude => "Claude",
            Proto::Acp(AcpCli::Grok) => "grok",
            Proto::Acp(AcpCli::Agy) => "agy",
            Proto::Codex => "codex",
        }
    }

    /// How a reply the CLI starts by itself ends.
    fn own_end(self) -> TurnEnd {
        match self {
            Proto::Claude => TurnEnd::Result,
            Proto::Acp(_) | Proto::Codex => TurnEnd::Completed,
        }
    }
}

/// What a process was started with. A turn that would start it differently
/// starts a new one.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct Started {
    /// argv without the session flags.
    pub argv: Vec<String>,
    pub cwd: PathBuf,
    /// The CLI session the process holds.
    pub session_id: Option<String>,
    /// What the session is set up with beside the argv: agy's rules, model
    /// and effort. Empty for a CLI that has them all on its argv, and for
    /// grok, which keeps the rules a session was opened with.
    pub setup: String,
}

/// How a turn reaches its process.
pub(super) struct Launch {
    pub proto: Proto,
    /// The argv a new process starts with, session flags and all.
    pub argv: Vec<String>,
    pub started: Started,
    /// ACP: how the session is set up.
    pub acp: Option<AcpSetup>,
    /// Codex: how the thread is set up.
    pub codex: Option<CodexSetup>,
}

/// Codex sets the thread up over app-server, not on the command line.
pub(super) struct CodexSetup {
    pub rules: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    /// `--yolo` is `never`. None leaves the server's own policy.
    pub approval: Option<String>,
    /// `--yolo` is `danger-full-access`.
    pub sandbox: Option<String>,
    /// The saved thread to resume. None opens a new one.
    pub load: Option<String>,
}

/// ACP has the session set up over the protocol, not on the command line.
pub(super) struct AcpSetup {
    pub rules: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    /// The saved session to load. None opens a new one.
    pub load: Option<String>,
}

struct Sink {
    generation: u64,
    tx: Sender<LiveLine>,
    end: TurnEnd,
    /// The request this turn is waiting on. `0` is not one. A JSON-RPC error
    /// ends the turn only when its id is this, so an interrupt's error does not.
    prompt_id: u64,
    /// Set once this turn's prompt has been written. A start line before that
    /// is a turn the CLI opened itself.
    prompted: bool,
    /// The CLI opened this turn. It is read ahead of a prompt that is not
    /// written yet.
    own: bool,
    /// Codex turn id, once a start or the `turn/start` result names it.
    turn_id: Option<String>,
}

/// The line a turn ends at.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TurnEnd {
    /// Claude's `result`.
    Result,
    /// The answer to the `session/prompt` request with this id.
    Response(u64),
    /// grok's `turn_completed` for its own session, which ends a reply it
    /// started by itself. Nothing answers that one.
    Completed,
}

enum LiveLine {
    Line(String),
    /// The process is gone: its exit status and what it wrote to stderr.
    Exit(Option<ExitStatus>, String),
}

static SERIAL: AtomicU64 = AtomicU64::new(1);
static STOP_ID: AtomicU64 = AtomicU64::new(1);

/// How long the CLI has to end a stopped turn before the process is killed,
/// as a stop did before. It answers at once.
const STOP_WAIT: Duration = if cfg!(test) {
    Duration::from_secs(1)
} else {
    Duration::from_secs(10)
};

/// The stderr kept for a turn that fails.
const STDERR_KEEP: usize = 16 * 1024;

/// How long an ACP process has to start and open its session. grok answers
/// in under a second, and loads a long session in a few.
const SETUP_WAIT: Duration = if cfg!(test) {
    Duration::from_secs(3)
} else {
    Duration::from_secs(60)
};

/// One prompted turn on the live process. A process kept from an earlier
/// turn that died before it read the prompt is started again, once.
pub(super) fn run_turn(
    session: &Arc<HeadlessSession>,
    launch: &Launch,
    prompt: &str,
    generation: u64,
    turn: &mut u64,
) -> anyhow::Result<TurnOutcome> {
    if launch.argv.is_empty() {
        anyhow::bail!("empty command");
    }
    let mut armed = false;
    let mut fresh = false;
    loop {
        let (tx, rx) = channel();
        let claimed = claim(session, launch, generation, tx, fresh)?;
        let reused = claimed.reused;
        if !reused {
            let cwd = &launch.started.cwd;
            let opened = match launch.proto {
                Proto::Acp(cli) => launch
                    .acp
                    .as_ref()
                    .map(|setup| open_session(session, &claimed, cli, setup, cwd, &rx, generation)),
                Proto::Codex => launch
                    .codex
                    .as_ref()
                    .map(|setup| open_codex(session, &claimed, setup, cwd, &rx, generation)),
                Proto::Claude => None,
            };
            if let Some(opened) = opened {
                match opened {
                    Ok(()) => {}
                    Err(Setup::Stale) => {
                        close_serial(session, claimed.serial);
                        anyhow::bail!("turn cancelled");
                    }
                    // Its session did not open, so the process has nothing to
                    // keep. A session it could not load is dropped, as a one-shot
                    // turn's failed resume was: the error quotes its id.
                    Err(Setup::Failed(why)) => {
                        close_serial(session, claimed.serial);
                        return Ok(TurnOutcome {
                            session_id: None,
                            got_text: false,
                            error: Some(why),
                            compacted: false,
                            watched: Vec::new(),
                            subagents: false,
                        });
                    }
                }
            }
        }
        let line = match launch.proto {
            Proto::Claude => prompt_line(prompt),
            Proto::Acp(_) => match acp_session(session, claimed.serial) {
                Some(id) => acp_prompt_line(claimed.prompt_id, &id, prompt),
                None => anyhow::bail!("turn cancelled"),
            },
            Proto::Codex => match acp_session(session, claimed.serial) {
                Some(id) => {
                    codex_prompt_line(claimed.prompt_id, &id, prompt, launch.codex.as_ref())
                }
                None => anyhow::bail!("turn cancelled"),
            },
        };
        let stdin = &claimed.stdin;
        match write_prompt(session, stdin, &line, generation) {
            Written::Yes => {}
            Written::Stale => anyhow::bail!("turn cancelled"),
            Written::Failed if reused => {
                // Gone since its last turn, before this one could reach it.
                close(session);
                fresh = true;
                continue;
            }
            // A new process that took no prompt exits, and the turn hears how.
            Written::Failed => {}
        }
        if !armed {
            arm_first_output_watch(Arc::clone(session), generation, launch.proto.cli());
            armed = true;
        }
        let ctx = TurnCtx {
            proto: launch.proto,
            serial: claimed.serial,
            end: claimed.end,
            own: false,
        };
        let read = read_turn(session, &rx, generation, turn, &ctx);
        if read.unheard && reused && !fresh && !is_stale(session, generation) {
            fresh = true;
            continue;
        }
        return Ok(read.outcome);
    }
}

/// The process a turn writes to.
struct Claimed {
    stdin: Arc<Mutex<ChildStdin>>,
    /// Kept from an earlier turn, not started for this one.
    reused: bool,
    serial: u64,
    /// ACP: the id the prompt goes out with.
    prompt_id: u64,
    end: TurnEnd,
}

/// The process this turn writes to, with the turn's sink in its line. One
/// kept from an earlier turn is reused while it runs and nothing it was
/// started with changed; otherwise it goes and a new one starts.
fn claim(
    session: &Arc<HeadlessSession>,
    launch: &Launch,
    generation: u64,
    tx: Sender<LiveLine>,
    fresh: bool,
) -> anyhow::Result<Claimed> {
    let (argv, started) = (&launch.argv, &launch.started);
    let old = {
        let mut inner = session.inner.lock().expect("headless inner");
        if inner.generation != generation {
            anyhow::bail!("turn cancelled");
        }
        let inner = &mut *inner;
        let keep = !fresh
            && inner.live.as_mut().is_some_and(|live| {
                live.proto == launch.proto
                    && live.started == *started
                    && (live.proto == Proto::Claude || live.acp_session.is_some())
                    && matches!(live.child.try_wait(), Ok(None))
            });
        if keep {
            let live = inner.live.as_mut().expect("kept");
            let (prompt_id, end) = live.prompt_end();
            live.turns.push_back(Sink {
                generation,
                tx,
                end,
                prompt_id,
                prompted: false,
                own: false,
                turn_id: None,
            });
            let claimed = Claimed {
                stdin: Arc::clone(&live.stdin),
                reused: true,
                serial: live.serial,
                prompt_id,
                end,
            };
            open_turn(inner);
            return Ok(claimed);
        }
        inner.live.take()
    };
    // Outside the lock: the CLI gets a moment to close.
    if let Some(mut old) = old {
        kill_all(&mut old.child);
    }

    let mut cmd = cli_command(session, argv, &started.cwd);
    cmd.stdin(Stdio::piped());
    let mut child = cmd
        .spawn()
        .with_context(|| format!("spawn {} ({})", session.id, argv.join(" ")))?;
    let stdin = child.stdin.take().context("take stdin")?;
    let stdout = child.stdout.take().context("take stdout")?;
    let stderr = child.stderr.take();
    let stdin = Arc::new(Mutex::new(stdin));
    let serial = SERIAL.fetch_add(1, Ordering::Relaxed);
    let proto = launch.proto;
    let claimed = {
        let mut inner = session.inner.lock().expect("headless inner");
        if inner.generation != generation {
            Err(child)
        } else {
            let pid = child.id();
            let mut live = LiveCli {
                serial,
                proto,
                child,
                stdin: Arc::clone(&stdin),
                started: started.clone(),
                turns: VecDeque::new(),
                background: Vec::new(),
                acp_session: None,
                next_id: 1,
                grok_state: None,
                claude_state: None,
                turn_id: None,
                approval: launch.codex.as_ref().and_then(|c| c.approval.clone()),
                pid,
            };
            let (prompt_id, end) = live.prompt_end();
            live.turns.push_back(Sink {
                generation,
                tx,
                end,
                prompt_id,
                prompted: false,
                own: false,
                turn_id: None,
            });
            super::remember_live_cli(&session.id, live.pid);
            inner.live = Some(live);
            open_turn(&mut inner);
            Ok(Claimed {
                stdin,
                reused: false,
                serial,
                prompt_id,
                end,
            })
        }
    };
    let claimed = match claimed {
        Ok(claimed) => claimed,
        Err(mut child) => {
            kill_all(&mut child);
            anyhow::bail!("turn cancelled");
        }
    };
    let stderr = stderr.map(keep_stderr);
    let reader = Arc::clone(session);
    if let Err(err) = std::thread::Builder::new()
        .name(format!("crew-live-{}", session.id))
        .spawn(move || read_stdout(reader, serial, proto, stdout, stderr))
    {
        close(session);
        return Err(err).context("spawn the live CLI reader");
    }
    Ok(claimed)
}

impl LiveCli {
    fn take_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    /// The id a prompt goes out with, and the line its turn ends at.
    fn prompt_end(&mut self) -> (u64, TurnEnd) {
        match self.proto {
            Proto::Claude => (0, TurnEnd::Result),
            Proto::Acp(_) => {
                let id = self.take_id();
                (id, TurnEnd::Response(id))
            }
            // The request's answer arrives at once, with the turn id. The
            // turn itself ends later, at `turn/completed`.
            Proto::Codex => (self.take_id(), TurnEnd::Completed),
        }
    }
}

enum Setup {
    /// The turn was stopped while the process started.
    Stale,
    Failed(String),
}

/// Start the ACP conversation and open the turn's session on it: load the
/// saved one, or open a new one with the rules. agy also gets its model and
/// effort here. Lines up to each answer are the setup's: a loaded session
/// tells its history over again first, and none of it is this turn's reply.
fn open_session(
    session: &HeadlessSession,
    claimed: &Claimed,
    cli: AcpCli,
    setup: &AcpSetup,
    cwd: &Path,
    rx: &Receiver<LiveLine>,
    generation: u64,
) -> Result<(), Setup> {
    let name = Proto::Acp(cli).name();
    let deadline = Instant::now() + SETUP_WAIT;
    let ask = |method: &str, params: Value| -> Result<Value, Setup> {
        acp_request(session, claimed, rx, generation, deadline, method, params)
    };
    let init = ask(
        "initialize",
        serde_json::json!({
            "protocolVersion": 1,
            "clientCapabilities": {
                "fs": { "readTextFile": false, "writeTextFile": false },
                "terminal": false,
            },
        }),
    )?;
    if let Some(why) = rpc_error(&init) {
        return Err(Setup::Failed(format!("{name} did not start: {why}")));
    }
    let meta = match (cli, setup.rules.trim().is_empty()) {
        (_, true) => serde_json::json!({}),
        (AcpCli::Grok, false) => serde_json::json!({ "rules": setup.rules }),
        (AcpCli::Agy, false) => serde_json::json!({
            "antigravity": { "systemPrompt": { "append": setup.rules } },
        }),
    };
    // Where grok keeps the session, by the folder's real path, as a one-shot
    // turn's `current_dir()` named it.
    let cwd = std::fs::canonicalize(cwd)
        .unwrap_or_else(|_| cwd.to_path_buf())
        .display()
        .to_string();
    let id = match setup.load.as_deref() {
        // grok keeps the rules a session was opened with, as a one-shot
        // resume did; agy adds the ones given here.
        Some(id) => {
            let loaded = ask(
                "session/load",
                serde_json::json!({ "sessionId": id, "cwd": cwd, "mcpServers": [], "_meta": meta }),
            )?;
            if let Some(why) = rpc_error(&loaded) {
                return Err(Setup::Failed(format!(
                    "{name} could not open session {id}: {why}"
                )));
            }
            id.to_string()
        }
        None => {
            let opened = ask(
                "session/new",
                serde_json::json!({ "cwd": cwd, "mcpServers": [], "_meta": meta }),
            )?;
            if let Some(why) = rpc_error(&opened) {
                return Err(Setup::Failed(format!(
                    "{name} could not open a session: {why}"
                )));
            }
            opened
                .pointer("/result/sessionId")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| Setup::Failed(format!("{name} opened a session with no id")))?
                .to_string()
        }
    };
    if cli == AcpCli::Agy {
        if let Some(model) = setup.model.as_deref() {
            let set = ask(
                "session/set_model",
                serde_json::json!({ "sessionId": id, "modelId": model }),
            )?;
            if let Some(why) = rpc_error(&set) {
                return Err(Setup::Failed(format!("agy has no model {model}: {why}")));
            }
        }
        if let Some(effort) = setup.effort.as_deref() {
            let set = ask(
                "session/set_config_option",
                serde_json::json!({ "sessionId": id, "configId": "thought_level", "value": effort }),
            )?;
            // The model's own thinking level stays: no reason to fail the turn.
            if let Some(why) = rpc_error(&set) {
                eprintln!("[crew] {}: agy effort {effort}: {why}", session.id);
            }
        }
    }
    // The session the process holds is this one, not the id the turn made up
    // for a new one: the CLI names its own. A turn stopped before it saves
    // the session still leaves it for the next.
    if let Ok(mut inner) = session.inner.lock() {
        if inner.generation == generation {
            inner.session_id = Some(id.clone());
        }
        if let Some(live) = inner.live.as_mut().filter(|l| l.serial == claimed.serial) {
            live.started.session_id = Some(id.clone());
            live.acp_session = Some(id);
        }
    }
    Ok(())
}

/// `initialize`, then the thread this turn speaks on: the saved one, or a
/// new one with the developer instructions. Lines up to each answer are the
/// setup's, and none of them is this turn's reply.
fn open_codex(
    session: &HeadlessSession,
    claimed: &Claimed,
    setup: &CodexSetup,
    cwd: &Path,
    rx: &Receiver<LiveLine>,
    generation: u64,
) -> Result<(), Setup> {
    let deadline = Instant::now() + SETUP_WAIT;
    let ask = |method: &str, params: Value| -> Result<Value, Setup> {
        acp_request(session, claimed, rx, generation, deadline, method, params)
    };
    let init = ask(
        "initialize",
        serde_json::json!({
            "clientInfo": { "name": "crew", "version": env!("CARGO_PKG_VERSION") },
        }),
    )?;
    if let Some(why) = rpc_error(&init) {
        return Err(Setup::Failed(format!("codex did not start: {why}")));
    }
    // The client says the handshake is done. app-server does not answer it.
    let _ = write_line(
        &claimed.stdin,
        &serde_json::json!({ "jsonrpc": "2.0", "method": "initialized" }).to_string(),
    );
    let cwd = std::fs::canonicalize(cwd)
        .unwrap_or_else(|_| cwd.to_path_buf())
        .display()
        .to_string();
    let mut params = serde_json::json!({ "cwd": cwd });
    if let Some(model) = setup.model.as_deref().filter(|m| !m.is_empty()) {
        params["model"] = Value::String(model.to_string());
    }
    if let Some(approval) = setup.approval.as_deref().filter(|s| !s.is_empty()) {
        params["approvalPolicy"] = Value::String(approval.to_string());
    }
    if let Some(sandbox) = setup.sandbox.as_deref().filter(|s| !s.is_empty()) {
        params["sandbox"] = Value::String(sandbox.to_string());
    }
    if !setup.rules.trim().is_empty() {
        params["developerInstructions"] = Value::String(setup.rules.clone());
    }
    let id = match setup.load.as_deref().filter(|id| !id.is_empty()) {
        Some(id) => {
            params["threadId"] = Value::String(id.to_string());
            let loaded = ask("thread/resume", params)?;
            if let Some(why) = rpc_error(&loaded) {
                return Err(Setup::Failed(format!(
                    "codex could not open session {id}: {why}"
                )));
            }
            id.to_string()
        }
        None => {
            let opened = ask("thread/start", params)?;
            if let Some(why) = rpc_error(&opened) {
                return Err(Setup::Failed(format!(
                    "codex could not open a session: {why}"
                )));
            }
            opened
                .pointer("/result/thread/id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| Setup::Failed("codex opened a session with no id".into()))?
                .to_string()
        }
    };
    if let Ok(mut inner) = session.inner.lock() {
        if inner.generation == generation {
            inner.session_id = Some(id.clone());
        }
        if let Some(live) = inner.live.as_mut().filter(|l| l.serial == claimed.serial) {
            live.started.session_id = Some(id.clone());
            live.acp_session = Some(id);
        }
    }
    Ok(())
}

/// One setup request and its answer. Other lines that come first are not
/// this turn's.
fn acp_request(
    session: &HeadlessSession,
    claimed: &Claimed,
    rx: &Receiver<LiveLine>,
    generation: u64,
    deadline: Instant,
    method: &str,
    params: Value,
) -> Result<Value, Setup> {
    let id = {
        let mut inner = session.inner.lock().map_err(|_| Setup::Stale)?;
        match inner.live.as_mut().filter(|l| l.serial == claimed.serial) {
            Some(live) => live.take_id(),
            None => return Err(Setup::Stale),
        }
    };
    let request =
        serde_json::json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
    // One that cannot be written exited, and the exit says why below.
    let _ = write_line(&claimed.stdin, &request.to_string());
    loop {
        if is_stale(session, generation) {
            return Err(Setup::Stale);
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(Setup::Failed(format!(
                "{} did not answer {method} in {} s",
                program_of(claimed, session),
                SETUP_WAIT.as_secs()
            )));
        }
        match rx.recv_timeout(left.min(Duration::from_millis(100))) {
            Ok(LiveLine::Line(line)) => {
                let Ok(v) = serde_json::from_str::<Value>(line.trim()) else {
                    continue;
                };
                if v.get("method").is_none() && v.get("id").and_then(Value::as_u64) == Some(id) {
                    return Ok(v);
                }
            }
            Ok(LiveLine::Exit(status, stderr)) => {
                return Err(Setup::Failed(exit_error(status, &stderr)));
            }
            Err(RecvTimeoutError::Timeout) => {}
            // Whoever took the process stopped it.
            Err(RecvTimeoutError::Disconnected) => return Err(Setup::Stale),
        }
    }
}

/// The CLI's name, for a setup that never answered.
fn program_of(claimed: &Claimed, session: &HeadlessSession) -> &'static str {
    session
        .inner
        .lock()
        .ok()
        .and_then(|inner| {
            let live = inner.live.as_ref()?;
            (live.serial == claimed.serial).then_some(live.proto.name())
        })
        .unwrap_or("The CLI")
}

/// What a JSON-RPC error answer says.
fn rpc_error(v: &Value) -> Option<String> {
    let err = v.get("error")?;
    let message = err
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("an error");
    let detail = err.pointer("/data/detail").and_then(Value::as_str);
    Some(match detail {
        Some(detail) if !detail.is_empty() => format!("{message} ({detail})"),
        _ => message.to_string(),
    })
}

/// How a process that exited says it failed: its stderr, or its status.
fn exit_error(status: Option<ExitStatus>, stderr: &str) -> String {
    let tail = strip_tui_noise(stderr);
    if !tail.is_empty() {
        return tail;
    }
    let code = status.and_then(|s| s.code()).unwrap_or(1);
    format!("CLI exited with status {code}")
}

fn acp_session(session: &HeadlessSession, serial: u64) -> Option<String> {
    let inner = session.inner.lock().ok()?;
    let live = inner.live.as_ref().filter(|l| l.serial == serial)?;
    live.acp_session.clone()
}

fn open_turn(inner: &mut HeadlessInner) {
    inner.live_turn = true;
    // Shown again when the turn ends. A working agent's list reads as its
    // reply being done.
    inner.watch.clear();
    inner.seq += 1;
}

/// `{"type":"user","message":{"role":"user","content":…}}`, the content last.
fn prompt_line(prompt: &str) -> String {
    let content = Value::String(prompt.to_string());
    format!(r#"{{"type":"user","message":{{"role":"user","content":{content}}}}}"#)
}

/// The app-server `turn/start` for one prompt, on one line. Effort is the
/// turn's; the thread already has the model and the instructions.
fn codex_prompt_line(id: u64, thread_id: &str, prompt: &str, setup: Option<&CodexSetup>) -> String {
    let mut params = serde_json::json!({
        "threadId": thread_id,
        "input": [{ "type": "text", "text": prompt }],
    });
    if let Some(setup) = setup {
        if let Some(effort) = setup.effort.as_deref().filter(|s| !s.is_empty()) {
            params["effort"] = Value::String(effort.to_string());
        }
        if let Some(approval) = setup.approval.as_deref().filter(|s| !s.is_empty()) {
            params["approvalPolicy"] = Value::String(approval.to_string());
        }
        if let Some(policy) = setup.sandbox.as_deref().and_then(codex_sandbox_policy) {
            params["sandboxPolicy"] = policy;
        }
    }
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "turn/start",
        "params": params,
    })
    .to_string()
}

/// app-server's turn sandbox, from the `sandbox_mode` string `--yolo` sets.
fn codex_sandbox_policy(mode: &str) -> Option<Value> {
    let kind = match mode {
        "danger-full-access" => "dangerFullAccess",
        "read-only" => "readOnly",
        "workspace-write" => "workspaceWrite",
        _ => return None,
    };
    Some(serde_json::json!({ "type": kind }))
}

/// The ACP `session/prompt` request for one prompt, on one line.
fn acp_prompt_line(id: u64, session_id: &str, prompt: &str) -> String {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "session/prompt",
        "params": {
            "sessionId": session_id,
            "prompt": [{ "type": "text", "text": prompt }],
        },
    })
    .to_string()
}

fn write_line(stdin: &Mutex<ChildStdin>, line: &str) -> std::io::Result<()> {
    let mut stdin = stdin
        .lock()
        .map_err(|_| std::io::Error::other("stdin lock"))?;
    write_locked(&mut stdin, line)
}

fn write_locked(stdin: &mut ChildStdin, line: &str) -> std::io::Result<()> {
    stdin.write_all(line.as_bytes())?;
    stdin.write_all(b"\n")?;
    stdin.flush()
}

enum Written {
    Yes,
    /// Stopped before the prompt went: no `result` will close its sink.
    Stale,
    Failed,
}

fn drop_generation(session: &HeadlessSession, generation: u64) {
    if let Ok(mut inner) = session.inner.lock() {
        if let Some(live) = inner.live.as_mut() {
            live.turns.retain(|t| t.generation != generation);
        }
    }
}

fn own_turn_open(session: &HeadlessSession) -> bool {
    session.inner.lock().ok().is_some_and(|inner| {
        inner
            .live
            .as_ref()
            .is_some_and(|live| live.turns.iter().any(|turn| turn.own))
    })
}

fn mark_prompted(session: &HeadlessSession, generation: u64) {
    if let Ok(mut inner) = session.inner.lock() {
        if let Some(live) = inner.live.as_mut() {
            if let Some(sink) = live
                .turns
                .iter_mut()
                .find(|turn| !turn.own && turn.generation == generation)
            {
                sink.prompted = true;
            }
        }
    }
}

/// The prompt, unless a stop got there first. A stop writes its interrupt
/// under the same stdin lock, so it lands after a prompt that went, and one
/// that lands before the prompt finds no turn to end: Claude would then run
/// the prompt in full, with nobody reading it.
///
/// A turn the CLI already opened is finished first. The prompt is not written
/// while a stdout line is being classified, so that line cannot become this
/// prompt's start.
fn write_prompt(
    session: &HeadlessSession,
    stdin: &Mutex<ChildStdin>,
    line: &str,
    generation: u64,
) -> Written {
    loop {
        if is_stale(session, generation) {
            drop_generation(session, generation);
            return Written::Stale;
        }
        if own_turn_open(session) {
            std::thread::sleep(Duration::from_millis(20));
            continue;
        }
        let _gate = session
            .route_gate
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        if is_stale(session, generation) {
            drop_generation(session, generation);
            return Written::Stale;
        }
        if own_turn_open(session) {
            continue;
        }
        let Ok(mut stdin) = stdin.lock() else {
            return Written::Failed;
        };
        if is_stale(session, generation) {
            drop(stdin);
            drop_generation(session, generation);
            return Written::Stale;
        }
        return match write_locked(&mut stdin, line) {
            Ok(()) => {
                drop(stdin);
                mark_prompted(session, generation);
                Written::Yes
            }
            Err(_) => Written::Failed,
        };
    }
}

struct ReadTurn {
    outcome: TurnOutcome,
    /// The process went before it wrote a line for this turn: it exited, or
    /// was killed with a stopped turn it never closed ahead of this one.
    unheard: bool,
}

/// Which turn of which process a reader reads.
struct TurnCtx {
    proto: Proto,
    serial: u64,
    end: TurnEnd,
    /// The CLI opened this turn. Its end must not answer a prompt still open.
    own: bool,
}

/// What a turn starts from. Claude's and codex's are new each turn. An ACP
/// turn goes on from what the last one knew of grok's subagents, in the
/// session the process holds.
fn start_state(session: &HeadlessSession, ctx: &TurnCtx) -> ParseState {
    let Ok(mut inner) = session.inner.lock() else {
        return ParseState::default();
    };
    if ctx.proto == Proto::Claude || ctx.proto == Proto::Codex {
        let mut state = ParseState::default();
        state.session_id = match ctx.proto {
            Proto::Codex => inner
                .live
                .as_ref()
                .filter(|l| l.serial == ctx.serial)
                .and_then(|l| l.acp_session.clone()),
            _ => inner.session_id.clone(),
        };
        return state;
    }
    let Some(live) = inner.live.as_mut().filter(|l| l.serial == ctx.serial) else {
        return ParseState::default();
    };
    let mut state = live.grok_state.take().unwrap_or_default();
    state.session_id = live.acp_session.clone();
    state.child_tokens = true;
    // A spawn that names no folder keeps its session in grok's.
    state.grok_cwd = std::fs::canonicalize(&live.started.cwd)
        .unwrap_or_else(|_| live.started.cwd.clone())
        .display()
        .to_string();
    state
}

/// This turn's lines, up to its end or the process's exit.
fn read_turn(
    session: &Arc<HeadlessSession>,
    rx: &Receiver<LiveLine>,
    generation: u64,
    turn: &mut u64,
    ctx: &TurnCtx,
) -> ReadTurn {
    let mut state = start_state(session, ctx);
    let mut plain = String::new();
    let mut heard = false;
    let mut exit = None;
    let mut codex_text = HashMap::new();
    let mut rollout = None;
    // Set at the `result`: what went wrong, when it says the turn failed.
    let mut ended: Option<Option<String>> = None;
    loop {
        let line = match rx.recv() {
            Ok(LiveLine::Line(line)) => line,
            Ok(LiveLine::Exit(status, stderr)) => {
                exit = Some((status, stderr));
                break;
            }
            // The process was stopped, or this stopped turn's `result` came.
            Err(_) => break,
        };
        heard = true;
        // A stopped turn reads on to its `result`, and shows none of it.
        if note_stdout(session, generation) {
            continue;
        }
        show_compacts(session, &mut state);
        let (turn_end, failure) = match ctx.proto {
            Proto::Claude => {
                let end = stream_line(session, CliKind::Claude, &line, &mut state, &mut plain);
                let failure = end
                    .then(|| serde_json::from_str::<Value>(line.trim()).ok())
                    .flatten()
                    .and_then(|v| result_failure(&v));
                (end, failure)
            }
            Proto::Acp(_) => acp_line(session, ctx, &line, &mut state),
            Proto::Codex => codex_line(session, &line, &mut state, &mut codex_text, &mut rollout),
        };
        show_compacts(session, &mut state);
        if let Some(id) = state.session_id.as_ref() {
            if let Ok(mut inner) = session.inner.lock() {
                inner.session_id = Some(id.clone());
            }
        }
        if turn_end {
            ended = Some(failure);
            // What grok held back while a subagent spoke goes before the end.
            if matches!(ctx.proto, Proto::Acp(_)) {
                settle_grok_reply(session, &mut state);
            }
            // The process stays up, with what it runs in the background. The
            // agent is idle, and the next send goes to it. A subagent that has
            // not reported yet is still this turn's work, so the bot stays
            // working until that line arrives. A turn the CLI opened while a
            // prompt is still open only seals its own bubble.
            let pending_own = ctx.own && user_turn_pending(session, generation);
            if state.got_text && !pending_own {
                let waiting =
                    ctx.proto == Proto::Claude && claude_still_waiting(session, ctx.serial);
                end_turn_early(session, generation, *turn, waiting);
            }
            break;
        }
    }
    if matches!(ctx.proto, Proto::Acp(_)) {
        settle_grok_reply(session, &mut state);
    }
    let mut error = state.error.take();
    match ended {
        // It answered and says it went well: an error it got past is not news.
        Some(None) if state.got_text => error = None,
        Some(None) => {}
        // A turn that said nothing keeps why. A resume of a session that is
        // gone ends this way, and the id in it tells `session_is_dead`.
        Some(Some(why)) => {
            if !state.got_text {
                error = Some(error.unwrap_or(why));
            }
        }
        None => {
            let (status, stderr) = exit.as_ref().map_or((None, ""), |(s, e)| (*s, e.as_str()));
            if !state.got_text {
                let code = status.and_then(|s| s.code()).unwrap_or(1);
                if code != 0 {
                    let tail = strip_tui_noise(stderr);
                    let msg = if tail.is_empty() {
                        format!("CLI exited with status {code}")
                    } else {
                        tail
                    };
                    error = Some(error.unwrap_or(msg));
                }
            } else if status.is_some_and(|s| s.success()) {
                error = None;
            }
        }
    }
    let outcome = TurnOutcome {
        session_id: state.session_id.clone(),
        got_text: state.got_text,
        error,
        compacted: state.compacted,
        watched: Vec::new(),
        subagents: ctx.proto == Proto::Claude && claude_still_waiting(session, ctx.serial),
    };
    if matches!(ctx.proto, Proto::Acp(_)) {
        keep_grok_state(session, ctx.serial, state.next_turn());
    }
    ReadTurn {
        unheard: !heard,
        outcome,
    }
}

/// The Claude subagents this process still has out, after the reply.
fn claude_still_waiting(session: &HeadlessSession, serial: u64) -> bool {
    session
        .inner
        .lock()
        .ok()
        .and_then(|inner| {
            let live = inner.live.as_ref().filter(|l| l.serial == serial)?;
            live.claude_state
                .as_ref()
                .map(|state| !state.claude_waiting.is_empty())
        })
        .unwrap_or(false)
}

/// What the next turn and the lines between turns go on from.
fn keep_grok_state(session: &HeadlessSession, serial: u64, state: ParseState) {
    if let Ok(mut inner) = session.inner.lock() {
        if let Some(live) = inner.live.as_mut().filter(|l| l.serial == serial) {
            live.grok_state = Some(state);
        }
    }
}

/// One ACP line of a turn: reply text, tool cards and side-chat notes, read
/// as grok's streaming-json was. True on the line the turn ends at, with what
/// went wrong when it says so.
fn acp_line(
    session: &HeadlessSession,
    ctx: &TurnCtx,
    line: &str,
    state: &mut ParseState,
) -> (bool, Option<String>) {
    let Ok(v) = serde_json::from_str::<Value>(line.trim()) else {
        return (false, None);
    };
    // The answer to this turn's prompt.
    if v.get("method").is_none() && v.get("id").is_some() {
        let mine = matches!(ctx.end, TurnEnd::Response(id) if v.get("id").and_then(Value::as_u64) == Some(id));
        if !mine {
            return (false, None);
        }
        let failure = rpc_error(&v).or_else(|| {
            let reason = v.pointer("/result/stopReason").and_then(Value::as_str);
            stop_failure(ctx.proto, reason)
        });
        return (true, failure);
    }
    let (event, kind) = grok_event(&v);
    // grok ends each turn, a subagent's too, with this. Only its own ends a
    // reply it started by itself; the answer ends a prompted one.
    if kind == "turn_completed" {
        let own =
            event_session_id(&v).is_some() && event_session_id(&v) == state.session_id.as_deref();
        if own && ctx.end == TurnEnd::Completed {
            let reason = event.get("stop_reason").and_then(Value::as_str);
            return (true, stop_failure(ctx.proto, reason));
        }
        return (false, None);
    }
    if apply_grok_stdout(session, state, line).is_some() {
        if let Ok(mut inner) = session.inner.lock() {
            inner.last_output = Instant::now();
            inner.seq += 1;
        }
    }
    (false, None)
}

/// One app-server line of a turn, read as `codex exec --json` was: reply text
/// replaces the bubble, a command or tool is a card, and `turn/completed`
/// ends the turn. A compact in the stream or in the rollout file shows once.
fn codex_line(
    session: &HeadlessSession,
    line: &str,
    state: &mut ParseState,
    spoken: &mut HashMap<String, String>,
    rollout: &mut Option<crate::codex_rollout::Rollout>,
) -> (bool, Option<String>) {
    let Ok(v) = serde_json::from_str::<Value>(line.trim()) else {
        return (false, None);
    };
    if v.get("method").is_none() {
        // `turn/start` answers at once. An error is the turn failing to start.
        return (v.get("error").is_some(), rpc_error(&v));
    }
    let method = v.get("method").and_then(Value::as_str).unwrap_or("");
    let thread = v.pointer("/params/threadId").and_then(Value::as_str);
    if thread.is_some() && thread != state.session_id.as_deref() {
        return (false, None);
    }
    if !state.compacted {
        super::note_codex_compacts(rollout, state);
    }
    if codex_compact(&v) && !state.compacted {
        state.compacted = true;
        state.compact_unshown = true;
    }
    match method {
        "turn/completed" => {
            let status = v
                .pointer("/params/turn/status")
                .and_then(Value::as_str)
                .unwrap_or("");
            let message = v
                .pointer("/params/turn/error/message")
                .and_then(Value::as_str);
            let failure = match status {
                "failed" => Some(
                    message
                        .unwrap_or("codex could not finish the turn")
                        .to_string(),
                ),
                "interrupted" if !state.got_text => {
                    Some(message.unwrap_or("codex interrupted the turn").to_string())
                }
                _ => None,
            };
            (true, failure)
        }
        "item/agentMessage/delta" => {
            let Some(id) = v.pointer("/params/itemId").and_then(Value::as_str) else {
                return (false, None);
            };
            let delta = v
                .pointer("/params/delta")
                .and_then(Value::as_str)
                .unwrap_or("");
            if delta.is_empty() {
                return (false, None);
            }
            let text = spoken.entry(id.to_string()).or_default();
            text.push_str(delta);
            let exec = serde_json::json!({
                "type": "item.updated",
                "item": { "id": id, "type": "agent_message", "text": text },
            });
            let _ = stream_line(
                session,
                CliKind::Codex,
                &exec.to_string(),
                state,
                &mut String::new(),
            );
            (false, None)
        }
        "item/started" | "item/completed" => {
            if let Some(item) = v.pointer("/params/item") {
                if let Some(exec) = codex_exec_item(method, item, spoken) {
                    let _ = stream_line(session, CliKind::Codex, &exec, state, &mut String::new());
                }
            }
            (false, None)
        }
        _ => (false, None),
    }
}

/// A compact app-server says in the stream. The rollout file is the other
/// place, and `note_codex_compacts` reads that.
fn codex_compact(v: &Value) -> bool {
    let method = v.get("method").and_then(Value::as_str).unwrap_or("");
    if method == "thread/compacted" {
        return true;
    }
    matches!(method, "item/started" | "item/completed")
        && v.pointer("/params/item/type").and_then(Value::as_str) == Some("contextCompaction")
}

/// An app-server item as the `exec --json` item the tool cards and the reply
/// already read. An agent message is its final text; deltas built that text.
fn codex_exec_item(
    method: &str,
    item: &Value,
    spoken: &mut HashMap<String, String>,
) -> Option<String> {
    let kind = item.get("type").and_then(Value::as_str)?;
    let id = item.get("id").and_then(Value::as_str).unwrap_or("");
    let mapped = match kind {
        "agentMessage" if method == "item/completed" => {
            let text = item.get("text").and_then(Value::as_str).unwrap_or("");
            if text.is_empty() || spoken.get(id).is_some_and(|full| full == text) {
                return None;
            }
            spoken.insert(id.to_string(), text.to_string());
            serde_json::json!({ "id": id, "type": "agent_message", "text": text })
        }
        "commandExecution" => serde_json::json!({
            "id": id,
            "type": "command",
            "command": item.get("command").and_then(Value::as_str).unwrap_or(""),
        }),
        "mcpToolCall" => serde_json::json!({
            "id": id,
            "type": "mcp_tool_call",
            "name": item.get("tool").and_then(Value::as_str).unwrap_or("mcp"),
            "arguments": item.get("arguments").cloned().unwrap_or(Value::Null),
        }),
        "dynamicToolCall" => serde_json::json!({
            "id": id,
            "type": "tool",
            "name": item.get("tool").and_then(Value::as_str).unwrap_or("tool"),
            "arguments": item.get("arguments").cloned().unwrap_or(Value::Null),
        }),
        "fileChange" => serde_json::json!({
            "id": id,
            "type": "tool",
            "name": "file_change",
            "arguments": item.get("changes").cloned().unwrap_or(Value::Null),
        }),
        "webSearch" => serde_json::json!({
            "id": id,
            "type": "tool",
            "name": "web_search",
            "arguments": item.get("query").cloned().unwrap_or(Value::Null),
        }),
        _ => return None,
    };
    let ty = if method == "item/started" {
        "item.started"
    } else {
        "item.completed"
    };
    Some(serde_json::json!({ "type": ty, "item": mapped }).to_string())
}

/// Commands still `inProgress` when their item updates. The turn can end
/// while one runs; that list is what the bot watches.
fn codex_commands(
    existing: &[(String, crate::protocol::Watch)],
    v: &Value,
) -> Option<Vec<(String, String)>> {
    let method = v.get("method").and_then(Value::as_str)?;
    if method != "item/started" && method != "item/completed" {
        return None;
    }
    let item = v.pointer("/params/item")?;
    if item.get("type").and_then(Value::as_str) != Some("commandExecution") {
        return None;
    }
    let id = item
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if id.is_empty() {
        return None;
    }
    let what = item
        .get("command")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or("command")
        .to_string();
    let status = item.get("status").and_then(Value::as_str).unwrap_or("");
    let running = status == "inProgress" || (method == "item/started" && status.is_empty());
    let mut next: Vec<(String, String)> = existing
        .iter()
        .map(|(key, watch)| (key.clone(), watch.what.clone()))
        .collect();
    if running {
        if let Some(slot) = next.iter_mut().find(|(key, _)| key == &id) {
            slot.1 = what;
        } else {
            next.push((id, what));
        }
    } else {
        next.retain(|(key, _)| key != &id);
    }
    Some(next)
}

fn codex_turn_id(v: &Value) -> Option<String> {
    let method = v.get("method").and_then(Value::as_str).unwrap_or("");
    // `turn/completed` is the turn that just ended. Keeping its id would make
    // the next stop interrupt that one, and the new turn would run on.
    let id = if method == "turn/started" {
        v.pointer("/params/turn/id")
    } else if v.get("method").is_none() {
        v.pointer("/result/turn/id")
    } else {
        None
    }?;
    id.as_str().filter(|s| !s.is_empty()).map(str::to_string)
}

/// `--yolo` (`approval` `never`) answers a command approval itself, and grants
/// the permissions a prompt asked for. Anything else is declined or refused:
/// Crew does not invent the user's answer, and a command without `--yolo`
/// does not get one.
fn codex_approval(method: &str, v: &Value, approval: Option<&str>) -> Option<Value> {
    let yolo = approval == Some("never");
    if !yolo {
        return match method {
            "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
                Some(serde_json::json!({ "decision": "decline" }))
            }
            "execCommandApproval" | "applyPatchApproval" => Some(serde_json::json!({
                "decision": { "denied": { "rejection": "not approved" } }
            })),
            _ => None,
        };
    }
    match method {
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
            Some(serde_json::json!({ "decision": "accept" }))
        }
        "execCommandApproval" | "applyPatchApproval" => {
            Some(serde_json::json!({ "decision": "approved" }))
        }
        // The response is the profile it asked for, not a `decision`.
        "item/permissions/requestApproval" => {
            let permissions = v
                .pointer("/params/permissions")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            Some(serde_json::json!({ "permissions": permissions }))
        }
        _ => None,
    }
}

/// Why a turn that ended for `reason` failed: an end that is not the model
/// finishing, or a stop.
fn stop_failure(proto: Proto, reason: Option<&str>) -> Option<String> {
    match reason {
        None | Some("end_turn" | "cancelled") => None,
        Some(reason) => Some(format!("{} ended the turn with {reason}", proto.name())),
    }
}

/// What a failed `result` says went wrong, or None for one that went well.
/// Claude stays up after it, so this is all a turn hears: the stderr line a
/// one-shot process left on exit is in `errors` too.
fn result_failure(v: &Value) -> Option<String> {
    let subtype = v.get("subtype").and_then(Value::as_str).unwrap_or("");
    let failed =
        v.get("is_error").and_then(Value::as_bool) == Some(true) || subtype.starts_with("error");
    if !failed {
        return None;
    }
    let errors: Vec<&str> = v
        .get("errors")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    if !errors.is_empty() {
        return Some(errors.join("\n"));
    }
    if let Some(text) = v
        .get("result")
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
    {
        return Some(text.to_string());
    }
    let subtype = if subtype.is_empty() {
        "an error"
    } else {
        subtype
    };
    Some(format!("Claude ended the turn with {subtype}"))
}

fn keep_stderr(stderr: ChildStderr) -> JoinHandle<String> {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut tail = String::new();
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => tail.push_str(&String::from_utf8_lossy(&buf)),
            }
            if tail.len() > STDERR_KEEP {
                let mut cut = tail.len() - STDERR_KEEP;
                while !tail.is_char_boundary(cut) {
                    cut += 1;
                }
                tail.drain(..cut);
            }
        }
        tail
    })
}

fn read_stdout(
    session: Arc<HeadlessSession>,
    serial: u64,
    proto: Proto,
    stdout: ChildStdout,
    stderr: Option<JoinHandle<String>>,
) {
    let mut reader = BufReader::new(stdout);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let line = String::from_utf8_lossy(&buf);
        let line = line.trim_end_matches(['\n', '\r']);
        if !line.trim().is_empty() {
            route(&session, serial, proto, line.to_string());
        }
    }
    exited(&session, serial, stderr);
}

/// What one line means for the turns of a process.
#[derive(Default)]
struct Routing {
    /// The answer to the ACP request with this id.
    answer: Option<u64>,
    /// It ends the open turn when that turn ends this way.
    ends: Option<TurnEnd>,
    /// The CLI starts a reply with it.
    starts: bool,
    /// The CLI's list of tasks running in the background, as (id, what).
    tasks: Option<Vec<(String, String)>>,
    /// ACP: the session it is about. Only the process's own counts above.
    session: Option<String>,
    /// A JSON-RPC error. It ends the open turn: the request did not start.
    failed: bool,
}

fn routing(proto: Proto, v: &Value) -> Routing {
    match proto {
        Proto::Claude => Routing {
            ends: is_turn_end(CliKind::Claude, v).then_some(TurnEnd::Result),
            starts: is_claude_turn_start(v),
            tasks: claude_background(v),
            ..Routing::default()
        },
        Proto::Acp(cli) => {
            if v.get("method").is_none() {
                return Routing {
                    answer: v.get("id").and_then(Value::as_u64),
                    ..Routing::default()
                };
            }
            let (event, kind) = grok_event(v);
            let update = v.get("method").and_then(Value::as_str) == Some("session/update");
            // agy starts no reply by itself, and has no event that would end
            // one: a stray word of its between turns opens nothing.
            Routing {
                ends: (kind == "turn_completed").then_some(TurnEnd::Completed),
                starts: cli == AcpCli::Grok
                    && update
                    && matches!(
                        kind,
                        "agent_message_chunk" | "agent_thought_chunk" | "tool_call"
                    ),
                tasks: (kind == "background_tasks").then(|| acp_background(event)),
                session: event_session_id(v).map(str::to_string),
                ..Routing::default()
            }
        }
        Proto::Codex => {
            let method = v.get("method").and_then(Value::as_str).unwrap_or("");
            Routing {
                ends: (method == "turn/completed").then_some(TurnEnd::Completed),
                // A `turn/started` while a turn is open is that turn's. One
                // with no turn open is codex speaking again, as when a
                // command it left running finishes.
                starts: method == "turn/started",
                session: v
                    .pointer("/params/threadId")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                failed: v.get("method").is_none() && v.get("error").is_some(),
                ..Routing::default()
            }
        }
    }
}

/// grok's `background_tasks`: every task it started in the background, with
/// the ones still going marked running.
fn acp_background(event: &Value) -> Vec<(String, String)> {
    let tasks = event.get("tasks").and_then(Value::as_array);
    tasks
        .into_iter()
        .flatten()
        .filter(|task| {
            matches!(
                task.get("status").and_then(Value::as_str),
                Some("running" | "pending" | "starting" | "queued")
            )
        })
        .map(|task| {
            let key = task
                .get("task_id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let what = ["description", "display_command", "command"]
                .iter()
                .find_map(|k| {
                    task.get(*k)
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                })
                .unwrap_or_default();
            (key.to_string(), what.to_string())
        })
        .collect()
}

/// The id a codex line belongs to. `turn/completed` keeps its id here too,
/// and that id is the turn that ended, not the one a later stop interrupts.
fn codex_event_turn(v: &Value) -> Option<String> {
    if let Some(id) = codex_turn_id(v) {
        return Some(id);
    }
    for pointer in ["/params/turnId", "/params/turn/id"] {
        if let Some(id) = v
            .pointer(pointer)
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        {
            return Some(id.to_string());
        }
    }
    None
}

/// Where a method-less response lands. Setup uses other ids, so an error
/// there is delivered and does not end the prompt.
fn prompt_sink_at(turns: &VecDeque<Sink>, v: &Value) -> Option<usize> {
    if v.get("method").is_some() {
        return None;
    }
    let id = v.get("id").and_then(Value::as_u64).filter(|id| *id != 0)?;
    turns.iter().position(|turn| turn.prompt_id == id)
}

fn prompt_failed(routing: &Routing, v: &Value, prompt_id: u64) -> bool {
    routing.failed && prompt_id != 0 && v.get("id").and_then(Value::as_u64) == Some(prompt_id)
}

fn session_owns(inner: &HeadlessInner, proto: Proto, routing: &Routing) -> bool {
    let Some(live) = inner.live.as_ref() else {
        return false;
    };
    proto == Proto::Claude || routing.session.is_some() && routing.session == live.acp_session
}

/// The front sink is a prompt that was written and has no turn id yet.
fn unbound_prompted_user(inner: &HeadlessInner) -> bool {
    inner.live.as_ref().is_some_and(|live| {
        live.turns
            .front()
            .is_some_and(|turn| turn.prompted && !turn.own && turn.turn_id.is_none())
    })
}

/// A prompt Crew started and has not finished, or a sink waiting on one.
fn user_turn_pending(session: &HeadlessSession, generation: u64) -> bool {
    session.inner.lock().ok().is_some_and(|inner| {
        inner.generation == generation
            && (inner.user_turns > 0
                || inner
                    .live
                    .as_ref()
                    .is_some_and(|live| live.turns.iter().any(|turn| !turn.own)))
    })
}

/// Drop the interrupt target when the turn it names just ended. Another
/// turn's end leaves it, so a stop still cuts the prompt that is open.
fn clear_tracked(live: &mut LiveCli, ended: Option<String>) {
    let Some(current) = live.turn_id.clone() else {
        return;
    };
    let matches = ended.as_ref() == Some(&current);
    let no_holder = ended.is_none()
        && !live
            .turns
            .iter()
            .any(|turn| turn.turn_id.as_ref() == Some(&current));
    if matches || no_holder {
        live.turn_id = None;
    }
}

/// Read `line` as a turn the CLI opened. The sink sits in front of a prompt
/// that has not been written, so that prompt waits.
fn open_own_turn(
    inner: &mut HeadlessInner,
    proto: Proto,
    serial: u64,
    line: String,
    turn_id: Option<String>,
) -> Option<(Receiver<LiveLine>, u64, TurnCtx)> {
    let end = proto.own_end();
    let generation = inner.generation;
    let (tx, rx) = channel();
    let _ = tx.send(LiveLine::Line(line));
    {
        let live = inner.live.as_mut()?;
        let user_bound = live
            .turns
            .iter()
            .any(|turn| !turn.own && turn.turn_id.is_some());
        if !user_bound {
            if let Some(id) = turn_id.clone() {
                live.turn_id = Some(id);
            }
        }
        live.turns.push_front(Sink {
            generation,
            tx,
            end,
            prompt_id: 0,
            prompted: false,
            own: true,
            turn_id,
        });
    }
    inner.interrupted = false;
    if inner.status == AgentStatus::Idle {
        inner.status = AgentStatus::Working;
    }
    inner.last_output = Instant::now();
    open_turn(inner);
    Some((
        rx,
        generation,
        TurnCtx {
            proto,
            serial,
            end,
            own: true,
        },
    ))
}

/// A start line. The front sink takes it when the prompt was already written
/// and has no turn yet, or when that sink is itself an unbound turn of the
/// CLI's. Otherwise the CLI opened a new one.
fn open_or_give(
    inner: &mut HeadlessInner,
    proto: Proto,
    serial: u64,
    line: String,
    turn_id: Option<String>,
) -> Option<(Receiver<LiveLine>, u64, TurnCtx)> {
    let give_front = inner.live.as_ref().is_some_and(|live| {
        live.turns.front().is_some_and(|turn| {
            (turn.own && turn.turn_id.is_none())
                || (turn.prompted && !turn.own && turn.turn_id.is_none())
        })
    });
    if !give_front {
        return open_own_turn(inner, proto, serial, line, turn_id);
    }
    let live = inner.live.as_mut()?;
    let user = live.turns.front().is_some_and(|turn| !turn.own);
    if let Some(id) = turn_id.clone() {
        if let Some(front) = live.turns.front_mut() {
            if front.turn_id.is_none() {
                front.turn_id = Some(id.clone());
            }
        }
        let user_bound = live
            .turns
            .iter()
            .any(|turn| !turn.own && turn.turn_id.is_some());
        if user || !user_bound {
            live.turn_id = Some(id);
        }
    }
    if let Some(front) = live.turns.front() {
        let _ = front.tx.send(LiveLine::Line(line));
    }
    None
}

/// Give `line` to the sink it belongs to. A new own turn comes back for
/// `run_unprompted` to read.
fn deliver_line(
    inner: &mut HeadlessInner,
    proto: Proto,
    serial: u64,
    routing: &Routing,
    v: Option<&Value>,
    line: &mut Option<String>,
) -> Option<(Receiver<LiveLine>, u64, TurnCtx)> {
    let own = session_owns(inner, proto, routing);
    if let Some(id) = routing.answer {
        let live = inner.live.as_mut()?;
        let at = live
            .turns
            .iter()
            .position(|turn| turn.end == TurnEnd::Response(id));
        if let Some(at) = at {
            live.turns.drain(..at);
        }
        if let Some(front) = live.turns.front() {
            let _ = front
                .tx
                .send(LiveLine::Line(line.take().unwrap_or_default()));
            if at.is_some() {
                live.turns.pop_front();
            }
        }
        return None;
    }
    if let Some(v) = v {
        if let Some(at) = inner
            .live
            .as_ref()
            .and_then(|live| prompt_sink_at(&live.turns, v))
        {
            let live = inner.live.as_mut()?;
            if let Some(id) = codex_turn_id(v) {
                live.turns[at].turn_id = Some(id.clone());
                if !live.turns[at].own {
                    live.turn_id = Some(id);
                }
            }
            let failed = v.get("error").is_some();
            let _ = live.turns[at]
                .tx
                .send(LiveLine::Line(line.take().unwrap_or_default()));
            if failed {
                let ended = live.turns[at].turn_id.clone();
                live.turns.remove(at);
                clear_tracked(live, ended);
            }
            return None;
        }
    }
    if let Some(v) = v {
        if let Some(id) = codex_event_turn(v) {
            let matched = inner.live.as_ref().and_then(|live| {
                live.turns
                    .iter()
                    .position(|turn| turn.turn_id.as_deref() == Some(id.as_str()))
            });
            if let Some(at) = matched {
                let live = inner.live.as_mut()?;
                let ends = own && routing.ends.is_some_and(|end| end == live.turns[at].end);
                let _ = live.turns[at]
                    .tx
                    .send(LiveLine::Line(line.take().unwrap_or_default()));
                if ends {
                    let ended = live.turns[at].turn_id.clone();
                    live.turns.remove(at);
                    clear_tracked(live, ended);
                }
                return None;
            }
            if own && routing.starts {
                return open_or_give(
                    inner,
                    proto,
                    serial,
                    line.take().unwrap_or_default(),
                    Some(id),
                );
            }
            let close_unbound = routing.ends.is_some()
                && inner.live.as_ref().is_some_and(|live| {
                    live.turns
                        .front()
                        .is_some_and(|turn| turn.turn_id.is_none())
                        && live.turns.iter().all(|turn| turn.turn_id.is_none())
                });
            if !close_unbound {
                if own && routing.ends.is_none() && !unbound_prompted_user(inner) {
                    return open_or_give(
                        inner,
                        proto,
                        serial,
                        line.take().unwrap_or_default(),
                        Some(id),
                    );
                }
                if unbound_prompted_user(inner) && routing.ends.is_none() {
                    let live = inner.live.as_mut()?;
                    if let Some(front) = live.turns.front_mut() {
                        front.turn_id = Some(id.clone());
                    }
                    live.turn_id = Some(id);
                    if let Some(front) = live.turns.front() {
                        let _ = front
                            .tx
                            .send(LiveLine::Line(line.take().unwrap_or_default()));
                    }
                    return None;
                }
                // An end for a turn this process is not reading.
                line.take();
                return None;
            }
        }
    }
    if own && routing.starts {
        return open_or_give(inner, proto, serial, line.take().unwrap_or_default(), None);
    }
    let pop = inner.live.as_mut().and_then(|live| {
        let front = live.turns.front_mut()?;
        let ends = own && routing.ends.is_some_and(|end| end == front.end);
        let failed = v.is_some_and(|v| prompt_failed(routing, v, front.prompt_id));
        let _ = front
            .tx
            .send(LiveLine::Line(line.take().unwrap_or_default()));
        Some(ends || failed)
    });
    if pop == Some(true) {
        if let Some(live) = inner.live.as_mut() {
            let ended = live.turns.front().and_then(|turn| turn.turn_id.clone());
            live.turns.pop_front();
            clear_tracked(live, ended);
        }
    }
    None
}

/// Hand `line` to the turn it belongs to. A turn the CLI opened itself is
/// not the prompt's, even when a send is already marked working.
fn route(session: &Arc<HeadlessSession>, serial: u64, proto: Proto, line: String) {
    let v = serde_json::from_str::<Value>(line.trim()).ok();
    match (proto, v.as_ref()) {
        // Claude's answer to a stop's interrupt, ahead of the stopped turn's
        // `result`. It is no turn's line.
        (Proto::Claude, Some(v))
            if v.get("type").and_then(Value::as_str) == Some("control_response") =>
        {
            return;
        }
        // The CLI asks Crew something, such as leave to run a tool.
        (Proto::Acp(_) | Proto::Codex, Some(v))
            if v.get("method").is_some() && v.get("id").is_some() =>
        {
            answer_request(session, serial, v);
            return;
        }
        _ => {}
    }
    let routing = v.as_ref().map(|v| routing(proto, v)).unwrap_or_default();
    // Held across the classification, and across `write_prompt`'s write, so
    // a line already here cannot be counted as the prompt's start. Not held
    // across the stdout read: a line still sitting in the pipe can arrive
    // after the prompt is marked written.
    let _gate = session
        .route_gate
        .lock()
        .unwrap_or_else(|err| err.into_inner());
    let mut line = Some(line);
    let mut tasks = routing.tasks.clone();
    let mut emit = false;
    let mut between = None;
    let mut claude_notes: Vec<SubagentNote> = Vec::new();
    let mut release_at: Option<u64> = None;
    let start;
    {
        let Ok(mut guard) = session.inner.lock() else {
            return;
        };
        let inner = &mut *guard;
        let serial_ok = inner
            .live
            .as_ref()
            .is_some_and(|live| live.serial == serial);
        if !serial_ok {
            return;
        }
        if proto == Proto::Codex {
            if let Some(v) = v.as_ref() {
                if tasks.is_none() {
                    if let Some(live) = inner.live.as_ref() {
                        if let Some(next) = codex_commands(&live.background, v) {
                            tasks = Some(next);
                        }
                    }
                }
            }
        }
        if proto == Proto::Claude {
            if let Some(v) = v.as_ref() {
                if let Some(live) = inner.live.as_mut() {
                    let mut state = live.claude_state.take().unwrap_or_default();
                    claude_notes = claude_subagent_notes(v, &mut state);
                    note_claude_background(v, &mut state);
                    live.claude_state = Some(state);
                }
            }
        }
        // Claude speaks for itself only. An ACP line about a subagent's
        // session is the subagent's.
        let own = session_owns(inner, proto, &routing);
        let watch = tasks.take().filter(|_| own).map(|next| {
            let live = inner.live.as_mut().expect("serial checked");
            keep_background(&mut live.background, next);
            watch_of(&live.background)
        });
        if let Some(watch) = watch {
            if !inner.live_turn && inner.watch != watch {
                inner.watch = watch;
                inner.seq += 1;
                emit = true;
            }
        }
        start = deliver_line(inner, proto, serial, &routing, v.as_ref(), &mut line);
        if line.is_some() {
            if proto == Proto::Claude {
                if let Some(v) = v.as_ref() {
                    crate::usage::note_claude_event(v);
                }
                // The reply is already sealed. A subagent's report is a side
                // note, and the bot is idle once nothing it started is left.
                release_at = Some(inner.generation);
            } else if matches!(proto, Proto::Acp(_)) {
                if let Some(live) = inner.live.as_mut() {
                    // A subagent grok left running reports between turns.
                    between = live.grok_state.take();
                }
            }
        }
    }
    if emit {
        crate::daemon::emit_agent_frame(&session.id);
    }
    if let Some(generation) = release_at {
        for note in claude_notes.drain(..) {
            crate::transcript::push_subagent(&session.id, &note.key, &note.from, &note.text);
        }
        let state = session.inner.lock().ok().and_then(|mut inner| {
            inner
                .live
                .as_mut()
                .filter(|l| l.serial == serial)
                .and_then(|l| l.claude_state.take())
        });
        if let Some(state) = state {
            release_sealed_if_idle(session, generation, &state);
            if let Ok(mut inner) = session.inner.lock() {
                if let Some(live) = inner.live.as_mut().filter(|l| l.serial == serial) {
                    live.claude_state = Some(state);
                }
            }
        }
    }
    if let (Some(mut state), Some(line)) = (between, line.as_deref()) {
        note_sealed_grok_child(session, &mut state, line);
        keep_grok_state(session, serial, state);
    }
    if let Some((rx, generation, ctx)) = start {
        let turn_session = Arc::clone(session);
        if let Err(err) = std::thread::Builder::new()
            .name(format!("crew-turn-{}", session.id))
            .spawn(move || run_unprompted(turn_session, rx, generation, ctx))
        {
            eprintln!("[crew] {}: {}'s own reply: {err}", session.id, proto.name());
            if let Ok(mut inner) = session.inner.lock() {
                if let Some(live) = inner.live.as_mut() {
                    if live.turns.front().is_some_and(|turn| turn.own) {
                        live.turns.pop_front();
                    }
                }
                let holding = inner.generation == generation
                    && (inner.user_turns > 0
                        || inner
                            .live
                            .as_ref()
                            .is_some_and(|live| live.turns.iter().any(|turn| !turn.own)));
                if !holding {
                    settle(&mut inner, generation);
                    if inner.status == AgentStatus::Working {
                        inner.status = AgentStatus::Idle;
                    }
                }
            }
        }
    }
}

/// A reply the CLI started by itself. It reads like a prompted turn's and
/// ends the same way, with nothing to save for a prompt. While a prompt is
/// still open it does not settle that prompt or hand its text over as the
/// answer.
fn run_unprompted(
    session: Arc<HeadlessSession>,
    rx: Receiver<LiveLine>,
    generation: u64,
    ctx: TurnCtx,
) {
    let pending = user_turn_pending(&session, generation);
    let mut turn = crate::transcript::begin_turn(&session.id);
    if !pending {
        crate::daemon::turn_reopened(&session.id);
        crate::daemon::note_turn_failed(&session.id, false);
    }
    crate::daemon::emit_agent_frame(&session.id);
    let outcome = read_turn(&session, &rx, generation, &mut turn, &ctx).outcome;
    let failed = outcome.error.is_some() && !outcome.got_text;
    if !is_stale(&session, generation) {
        let error = outcome
            .error
            .as_deref()
            .map(strip_tui_noise)
            .filter(|err| !err.is_empty());
        if let Some(err) = error {
            if outcome.got_text {
                crate::transcript::push_system(&session.id, "crew", &err, None);
            } else {
                crate::transcript::on_assistant_delta(&session.id, &err);
            }
        }
    }
    crate::transcript::end_turn_gen(&session.id, Some(turn));
    if is_stale(&session, generation) {
        return;
    }
    if user_turn_pending(&session, generation) || own_turn_open(&session) {
        crate::daemon::emit_agent_frame(&session.id);
        return;
    }
    crate::daemon::note_turn_failed(&session.id, failed);
    crate::daemon::remote_turn_over(&session.id);
    if let Ok(mut inner) = session.inner.lock() {
        settle(&mut inner, generation);
        if inner.status != AgentStatus::Exited && inner.status != AgentStatus::Blocked {
            inner.status = AgentStatus::Idle;
        }
        inner.last_output = Instant::now();
        inner.seq += 1;
    }
    crate::daemon::emit_agent_frame(&session.id);
    crate::daemon::turn_ended(&session.id);
    crate::daemon::pump_inbox(&session.id);
}

/// The CLI asked Crew for something. Crew asks nobody: a bot that may not
/// run a tool without leave does not run it, and anything else is refused.
fn answer_request(session: &HeadlessSession, serial: u64, v: &Value) {
    let answered = session.inner.lock().ok().and_then(|inner| {
        let live = inner.live.as_ref().filter(|l| l.serial == serial)?;
        Some((Arc::clone(&live.stdin), live.approval.clone()))
    });
    let Some((stdin, approval)) = answered else {
        return;
    };
    let method = v.get("method").and_then(Value::as_str).unwrap_or_default();
    let id = v.get("id").cloned().unwrap_or(Value::Null);
    let reply = if let Some(result) = codex_approval(method, v, approval.as_deref()) {
        serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result })
    } else if method == "session/request_permission" {
        let options = v.pointer("/params/options").and_then(Value::as_array);
        let reject = options.into_iter().flatten().find(|o| {
            o.get("kind")
                .and_then(Value::as_str)
                .is_some_and(|k| k.starts_with("reject"))
        });
        let outcome = match reject.and_then(|o| o.get("optionId")) {
            Some(option) => serde_json::json!({ "outcome": "selected", "optionId": option }),
            None => serde_json::json!({ "outcome": "cancelled" }),
        };
        serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": { "outcome": outcome } })
    } else {
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32601, "message": format!("Crew does not answer {method}") },
        })
    };
    let _ = write_line(&stdin, &reply.to_string());
}

/// The process closed its stdout. The turn reading it hears how it exited;
/// the next turn starts a new one on the same session.
fn exited(session: &HeadlessSession, serial: u64, stderr: Option<JoinHandle<String>>) {
    let live = session.inner.lock().ok().and_then(|mut inner| {
        let inner = &mut *inner;
        if inner.live.as_ref().is_some_and(|l| l.serial == serial) {
            // The CLI is gone, and what it ran with it.
            if !inner.watch.is_empty() {
                inner.watch.clear();
                inner.seq += 1;
            }
            inner.live.take()
        } else {
            // Whoever took it stopped it.
            None
        }
    });
    let Some(mut live) = live else {
        return;
    };
    let status = live.child.wait().ok();
    let stderr = stderr.and_then(|h| h.join().ok()).unwrap_or_default();
    if let Some(front) = live.turns.pop_front() {
        let _ = front.tx.send(LiveLine::Exit(status, stderr));
    }
    crate::daemon::emit_agent_frame(&session.id);
}

/// The turn of `generation` is over. The process's background work shows
/// again while the agent waits for the next prompt.
pub(super) fn settle(inner: &mut HeadlessInner, generation: u64) {
    if inner.generation != generation {
        return;
    }
    inner.live_turn = false;
    if let Some(live) = inner.live.as_ref() {
        inner.watch = watch_of(&live.background);
    }
}

/// The session the turn of `generation` saved is the one the process holds.
pub(super) fn note_session(session: &HeadlessSession, generation: u64, id: &str) {
    if let Ok(mut inner) = session.inner.lock() {
        if inner.generation != generation {
            return;
        }
        if let Some(live) = inner.live.as_mut() {
            live.started.session_id = Some(id.to_string());
        }
    }
}

/// After `pull_turn`. `pulled` is the generation of the turn it took from the
/// process, if any. With `keep_cli` the CLI is asked to stop that turn, and
/// the process stays up with what it runs in the background. That holds for
/// a turn it has not answered yet too: Claude ends a prompt it was told to
/// stop before it began with a `result` of its own, and does none of it, and
/// an ACP CLI answers a cancelled prompt. Without `keep_cli` the process goes.
pub(super) fn stop(session: &Arc<HeadlessSession>, pulled: Option<u64>, keep_cli: bool) {
    if !keep_cli {
        close(session);
        return;
    }
    let Some(generation) = pulled else {
        return;
    };
    let target = session.inner.lock().ok().and_then(|mut inner| {
        let inner = &mut *inner;
        let live = inner.live.as_mut()?;
        let watch = watch_of(&live.background);
        let acp = live.acp_session.clone();
        let turn_id = live.turn_id.clone();
        // From the same counter as `turn/start`, so the two answers cannot share an id.
        let interrupt_id = (live.proto == Proto::Codex && acp.is_some() && turn_id.is_some())
            .then(|| live.take_id());
        let found = (
            Arc::clone(&live.stdin),
            live.serial,
            live.proto,
            acp,
            turn_id,
            interrupt_id,
        );
        inner.watch = watch;
        inner.seq += 1;
        Some(found)
    });
    let Some((stdin, serial, proto, acp, turn_id, interrupt_id)) = target else {
        return;
    };
    let request = match proto {
        Proto::Claude => {
            let id = STOP_ID.fetch_add(1, Ordering::Relaxed);
            serde_json::json!({
                "type": "control_request",
                "request_id": format!("crew-stop-{id}"),
                "request": { "subtype": "interrupt" },
            })
        }
        Proto::Acp(_) => match acp {
            Some(id) => serde_json::json!({
                "jsonrpc": "2.0",
                "method": "session/cancel",
                "params": { "sessionId": id },
            }),
            // Still opening its session: that sees the stop and closes it.
            None => return,
        },
        Proto::Codex => match (acp, turn_id, interrupt_id) {
            (Some(thread), Some(turn), Some(id)) => serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": "turn/interrupt",
                "params": { "threadId": thread, "turnId": turn },
            }),
            // The turn id arrives with `turn/started`. Until then there is
            // nothing to interrupt; the wait below sends it once there is,
            // and kills the process if the turn never closes.
            _ => {
                codex_stop_later(session, stdin, serial, generation);
                return;
            }
        },
    }
    .to_string();
    if write_line(&stdin, &request).is_err() {
        close_serial(session, serial);
        return;
    }
    // The CLI ends the stopped turn at once. One that does not is stuck, and
    // goes as a stop took it before.
    arm_stop_wait(session, serial, generation, proto);
}

/// Codex had no turn id when the stop landed. Send `turn/interrupt` once the
/// id shows up. Either way, a turn that is still open after `STOP_WAIT` goes,
/// process and all, as a stop that the CLI ignored does.
fn codex_stop_later(
    session: &Arc<HeadlessSession>,
    stdin: Arc<Mutex<ChildStdin>>,
    serial: u64,
    generation: u64,
) {
    let session = Arc::clone(session);
    let _ = std::thread::Builder::new()
        .name(format!("crew-stop-{}", session.id))
        .spawn(move || {
            let start = Instant::now();
            let mut sent = false;
            loop {
                if !sent {
                    let ids = session.inner.lock().ok().and_then(|mut inner| {
                        let live = inner.live.as_mut().filter(|l| l.serial == serial)?;
                        let thread = live.acp_session.clone()?;
                        let turn = live.turn_id.clone()?;
                        Some((thread, turn, live.take_id()))
                    });
                    if let Some((thread, turn, id)) = ids {
                        let request = serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "method": "turn/interrupt",
                            "params": { "threadId": thread, "turnId": turn },
                        })
                        .to_string();
                        if write_line(&stdin, &request).is_err() {
                            close_serial(&session, serial);
                            return;
                        }
                        sent = true;
                    }
                }
                let stuck = stop_still_open(&session, serial, generation);
                if !stuck {
                    return;
                }
                if start.elapsed() >= STOP_WAIT {
                    eprintln!(
                        "[crew] {}: codex did not stop its turn; killing it",
                        session.id
                    );
                    close_serial(&session, serial);
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        });
}

fn stop_still_open(session: &HeadlessSession, serial: u64, generation: u64) -> bool {
    session.inner.lock().is_ok_and(|inner| {
        inner.live.as_ref().is_some_and(|live| {
            live.serial == serial && live.turns.iter().any(|t| t.generation == generation)
        })
    })
}

/// Kill the process if the stopped turn is still open after `STOP_WAIT`.
fn arm_stop_wait(session: &Arc<HeadlessSession>, serial: u64, generation: u64, proto: Proto) {
    let session = Arc::clone(session);
    let _ = std::thread::Builder::new()
        .name(format!("crew-stop-{}", session.id))
        .spawn(move || {
            std::thread::sleep(STOP_WAIT);
            if stop_still_open(&session, serial, generation) {
                eprintln!(
                    "[crew] {}: {} did not stop its turn; killing it",
                    session.id,
                    proto.name()
                );
                close_serial(&session, serial);
            }
        });
}

/// Kill the process kept up between turns, if there is one.
pub(super) fn close(session: &HeadlessSession) {
    take_and_kill(session, None);
}

fn close_serial(session: &HeadlessSession, serial: u64) {
    take_and_kill(session, Some(serial));
}

fn take_and_kill(session: &HeadlessSession, serial: Option<u64>) {
    let live = session.inner.lock().ok().and_then(|mut inner| {
        let matches = inner
            .live
            .as_ref()
            .is_some_and(|l| serial.is_none_or(|s| l.serial == s));
        if !matches {
            return None;
        }
        if !inner.watch.is_empty() {
            inner.watch.clear();
            inner.seq += 1;
        }
        inner.live.take()
    });
    // Outside the lock: the CLI gets a moment to close.
    if let Some(mut live) = live {
        kill_all(&mut live.child);
    }
}

fn watch_of(background: &[(String, Watch)]) -> Vec<Watch> {
    background.iter().map(|(_, w)| w.clone()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_prompt_line_is_one_stream_json_user_message() {
        let prompt = "- a dash first\n\"quoted\" and \\ and 한글";
        let line = prompt_line(prompt);
        assert!(!line.contains('\n'), "{line}");
        let v: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["type"], "user");
        assert_eq!(v["message"]["role"], "user");
        assert_eq!(v["message"]["content"], prompt);
    }

    #[test]
    fn a_failed_result_says_why() {
        let gone = serde_json::json!({
            "type": "result",
            "subtype": "error_during_execution",
            "is_error": true,
            "errors": ["No conversation found with session ID: abc"],
        });
        assert_eq!(
            result_failure(&gone).as_deref(),
            Some("No conversation found with session ID: abc")
        );
        let said = serde_json::json!({"type": "result", "is_error": true, "result": "API Error"});
        assert_eq!(result_failure(&said).as_deref(), Some("API Error"));
        let bare = serde_json::json!({"type": "result", "subtype": "error_max_turns"});
        assert_eq!(
            result_failure(&bare).as_deref(),
            Some("Claude ended the turn with error_max_turns")
        );
        let fine = serde_json::json!({"type": "result", "subtype": "success", "is_error": false});
        assert_eq!(result_failure(&fine), None);
    }

    /// A command approval is accepted only when the thread policy is `never`.
    /// Anything else is declined, and a permissions ask is not granted.
    #[test]
    fn a_codex_approval_is_declined_unless_the_policy_is_never() {
        let command = serde_json::json!({
            "method": "item/commandExecution/requestApproval",
            "id": 7
        });
        let permissions = serde_json::json!({
            "method": "item/permissions/requestApproval",
            "id": 8,
            "params": { "permissions": { "network": { "enabled": true } } }
        });
        assert_eq!(
            codex_approval(
                "item/commandExecution/requestApproval",
                &command,
                Some("never")
            ),
            Some(serde_json::json!({ "decision": "accept" }))
        );
        assert_eq!(
            codex_approval(
                "item/commandExecution/requestApproval",
                &command,
                Some("on-request")
            ),
            Some(serde_json::json!({ "decision": "decline" }))
        );
        assert_eq!(
            codex_approval("item/commandExecution/requestApproval", &command, None),
            Some(serde_json::json!({ "decision": "decline" }))
        );
        assert_eq!(
            codex_approval(
                "item/permissions/requestApproval",
                &permissions,
                Some("never")
            )
            .unwrap()["permissions"]["network"]["enabled"],
            true
        );
        assert!(codex_approval(
            "item/permissions/requestApproval",
            &permissions,
            Some("on-request")
        )
        .is_none());
    }

    /// A start that arrived before the prompt was written is not that
    /// prompt's, and finishing it does not idle the prompt.
    #[test]
    fn a_self_started_turn_is_not_the_prompt_waiting_behind_it() {
        crate::paths::testing::with_home("self-turn", || {
            let (bare, serial, _) = codex_session("th", false);
            {
                let mut inner = bare.inner.lock().unwrap();
                inner.live.as_mut().unwrap().turns.clear();
                inner.live_turn = false;
            }
            let _bare = KillChild(Arc::clone(&bare));
            let started = Instant::now();
            route(&bare, serial, Proto::Codex, started_line("th", "alone"));
            assert!(
                started.elapsed() < Duration::from_secs(2),
                "a start with no sink waited"
            );
            route(&bare, serial, Proto::Codex, completed_line("th", "alone"));
            wait_own(&bare);
            {
                let inner = bare.inner.lock().unwrap();
                assert!(inner.live_turn);
                assert_eq!(inner.status, AgentStatus::Working);
            }
            let (session, serial, rx) = codex_session("th", false);
            let _guard = KillChild(Arc::clone(&session));
            let started = Instant::now();
            route(&session, serial, Proto::Codex, started_line("th", "self"));
            assert!(
                started.elapsed() < Duration::from_secs(2),
                "a start with no sink waited"
            );
            assert!(rx.try_recv().is_err(), "the prompt's sink took the start");
            {
                let inner = session.inner.lock().unwrap();
                let live = inner.live.as_ref().unwrap();
                assert!(live.turns.front().unwrap().own);
                assert!(!live.turns.back().unwrap().own);
                assert!(inner.live_turn);
            }
            route(&session, serial, Proto::Codex, completed_line("th", "self"));
            wait_own(&session);
            let inner = session.inner.lock().unwrap();
            assert!(inner.live_turn);
            assert_eq!(inner.status, AgentStatus::Working);
            assert!(inner.user_turns > 0);
            assert!(inner
                .live
                .as_ref()
                .unwrap()
                .turns
                .iter()
                .all(|turn| !turn.own));
        });
    }

    #[test]
    fn a_start_after_the_prompt_belongs_to_that_prompt() {
        crate::paths::testing::with_home("prompted-start", || {
            let (session, serial, rx) = codex_session("th", true);
            let _guard = KillChild(Arc::clone(&session));
            route(&session, serial, Proto::Codex, started_line("th", "user"));
            let got = match rx.try_recv() {
                Ok(LiveLine::Line(line)) => line,
                Ok(LiveLine::Exit(_, _)) => panic!("prompt sink got the process exit"),
                Err(_) => panic!("prompt sink missed the start"),
            };
            assert!(got.contains("user"), "{got}");
            let inner = session.inner.lock().unwrap();
            let front = inner.live.as_ref().unwrap().turns.front().unwrap();
            assert!(!front.own);
            assert_eq!(front.turn_id.as_deref(), Some("user"));
            assert_eq!(Arc::strong_count(&session), 2);
        });
    }

    fn wait_own(session: &Arc<HeadlessSession>) {
        let deadline = Instant::now() + Duration::from_secs(2);
        while Arc::strong_count(session) > 2 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(
            Arc::strong_count(session),
            2,
            "the own turn is still reading"
        );
    }

    fn started_line(thread: &str, turn: &str) -> String {
        format!(
            r#"{{"jsonrpc":"2.0","method":"turn/started","params":{{"threadId":"{thread}","turn":{{"id":"{turn}","status":"inProgress"}}}}}}"#
        )
    }

    fn completed_line(thread: &str, turn: &str) -> String {
        format!(
            r#"{{"jsonrpc":"2.0","method":"turn/completed","params":{{"threadId":"{thread}","turn":{{"id":"{turn}","status":"completed"}}}}}}"#
        )
    }

    /// A codex process with one user sink. `prompted` is whether the prompt
    /// has been written. The sink's prompt id is 4.
    fn codex_session(
        thread: &str,
        prompted: bool,
    ) -> (Arc<HeadlessSession>, u64, Receiver<LiveLine>) {
        use std::os::unix::process::CommandExt;
        let mut child = std::process::Command::new("sleep")
            .arg("60")
            .process_group(0)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        let stdin = child.stdin.take().unwrap();
        let (tx, rx) = channel();
        let serial = 7;
        let live = LiveCli {
            serial,
            proto: Proto::Codex,
            child,
            stdin: Arc::new(Mutex::new(stdin)),
            started: Started {
                argv: vec!["codex".into(), "app-server".into()],
                cwd: PathBuf::from("/tmp"),
                session_id: Some(thread.into()),
                setup: String::new(),
            },
            turns: VecDeque::from([Sink {
                generation: 3,
                tx,
                end: TurnEnd::Completed,
                prompt_id: 4,
                prompted,
                own: false,
                turn_id: None,
            }]),
            background: Vec::new(),
            acp_session: Some(thread.into()),
            next_id: 5,
            grok_state: None,
            claude_state: None,
            turn_id: None,
            approval: Some("never".into()),
            pid,
        };
        let session = Arc::new(HeadlessSession {
            id: "bot".into(),
            name: "bot".into(),
            cmd: vec!["codex".into()],
            cwd: PathBuf::from("/tmp"),
            inner: Mutex::new(HeadlessInner {
                status: AgentStatus::Working,
                last_output: Instant::now(),
                seq: 0,
                cols: 80,
                rows: 24,
                session_id: Some(thread.into()),
                child: None,
                generation: 3,
                interrupted: false,
                in_flight: None,
                first_output_timeout: None,
                watch: Vec::new(),
                live: Some(live),
                live_turn: true,
                user_turns: 1,
            }),
            route_gate: Mutex::new(()),
        });
        (session, serial, rx)
    }

    /// Kills the sleep the test parked as the resident CLI.
    struct KillChild(Arc<HeadlessSession>);

    impl Drop for KillChild {
        fn drop(&mut self) {
            let live = self
                .0
                .inner
                .lock()
                .ok()
                .and_then(|mut inner| inner.live.take());
            if let Some(mut live) = live {
                super::super::kill_all(&mut live.child);
            }
        }
    }
}
