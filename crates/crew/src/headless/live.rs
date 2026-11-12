//! Claude, grok and agy kept up between turns.
//!
//! A turn used to be its own process, and the CLI keeps that process up past
//! its answer while a task it put in the background runs. A send in that time
//! waited for the task, forever for a dev server, and stopping the CLI to let
//! it through stopped the task too. Now one process stays up and reads each
//! prompt from stdin: Claude as a stream-json line, grok and agy as an ACP
//! `session/prompt` request (JSON-RPC, a line each way). A turn ends at
//! Claude's `result` or at the answer to its request; the next prompt goes to
//! the same process, and its background tasks go on.
//!
//! One reader thread owns the process's stdout. Each turn gets the lines up
//! to its end over a channel. Lines that come while no turn is open are the
//! CLI's own: the task list, a subagent's notes, and the reply Claude or grok
//! starts by itself once a task ends, which becomes a turn of its own.

use std::collections::VecDeque;
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
    apply_grok_stdout, arm_first_output_watch, claude_background, cli_command, end_turn_early,
    event_session_id, grok_event, is_claude_turn_start, is_stale, is_turn_end, keep_background,
    kill_all, note_sealed_grok_child, note_stdout, settle_grok_reply, show_compacts, stream_line,
    strip_tui_noise, CliKind, HeadlessInner, HeadlessSession, ParseState, TurnOutcome,
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
}

/// How a process takes prompts and ends turns.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Proto {
    /// stream-json on stdin, a turn ends at `result`.
    Claude,
    /// ACP: a `session/prompt` request, a turn ends at its answer.
    Acp(AcpCli),
}

impl Proto {
    /// The CLI whose limit the first-output watch keeps. agy prints nothing
    /// before its answer, as on a turn of its own.
    fn cli(self) -> CliKind {
        match self {
            Proto::Claude => CliKind::Claude,
            Proto::Acp(AcpCli::Grok) => CliKind::Grok,
            Proto::Acp(AcpCli::Agy) => CliKind::Other,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Proto::Claude => "Claude",
            Proto::Acp(AcpCli::Grok) => "grok",
            Proto::Acp(AcpCli::Agy) => "agy",
        }
    }

    /// How a reply the CLI starts by itself ends.
    fn own_end(self) -> TurnEnd {
        match self {
            Proto::Claude => TurnEnd::Result,
            Proto::Acp(_) => TurnEnd::Completed,
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

/// How long a reply the CLI starts by itself waits for a prompt that is on
/// its way. That prompt's turn reads it.
const HANDOFF_WAIT: Duration = Duration::from_secs(30);

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
        if let (Proto::Acp(cli), Some(setup), false) = (launch.proto, launch.acp.as_ref(), reused) {
            let cwd = &launch.started.cwd;
            match open_session(session, &claimed, cli, setup, cwd, &rx, generation) {
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
                    });
                }
            }
        }
        let line = match launch.proto {
            Proto::Claude => prompt_line(prompt),
            Proto::Acp(_) => match acp_session(session, claimed.serial) {
                Some(id) => acp_prompt_line(claimed.prompt_id, &id, prompt),
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
            };
            let (prompt_id, end) = live.prompt_end();
            live.turns.push_back(Sink {
                generation,
                tx,
                end,
            });
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

/// The prompt, unless a stop got there first. A stop writes its interrupt
/// under the same stdin lock, so it lands after a prompt that went, and one
/// that lands before the prompt finds no turn to end: Claude would then run
/// the prompt in full, with nobody reading it.
fn write_prompt(
    session: &HeadlessSession,
    stdin: &Mutex<ChildStdin>,
    line: &str,
    generation: u64,
) -> Written {
    let Ok(mut stdin) = stdin.lock() else {
        return Written::Failed;
    };
    if is_stale(session, generation) {
        drop(stdin);
        if let Ok(mut inner) = session.inner.lock() {
            if let Some(live) = inner.live.as_mut() {
                live.turns.retain(|t| t.generation != generation);
            }
        }
        return Written::Stale;
    }
    match write_locked(&mut stdin, line) {
        Ok(()) => Written::Yes,
        Err(_) => Written::Failed,
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
}

/// What a turn starts from. Claude's is new each turn. An ACP turn goes on
/// from what the last one knew of grok's subagents, in the session the
/// process holds.
fn start_state(session: &HeadlessSession, ctx: &TurnCtx) -> ParseState {
    let Ok(mut inner) = session.inner.lock() else {
        return ParseState::default();
    };
    if ctx.proto == Proto::Claude {
        let mut state = ParseState::default();
        state.session_id = inner.session_id.clone();
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
            if ctx.proto != Proto::Claude {
                settle_grok_reply(session, &mut state);
            }
            // The process stays up, with what it runs in the background. The
            // agent is idle, and the next send goes to it.
            if state.got_text {
                end_turn_early(session, generation, *turn, false);
            }
            break;
        }
    }
    if ctx.proto != Proto::Claude {
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
    };
    if ctx.proto != Proto::Claude {
        keep_grok_state(session, ctx.serial, state.next_turn());
    }
    ReadTurn {
        unheard: !heard,
        outcome,
    }
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

/// Hand `line` to the turn reading this process, or read it here when none is.
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
        (Proto::Acp(_), Some(v)) if v.get("method").is_some() && v.get("id").is_some() => {
            answer_request(session, serial, v);
            return;
        }
        _ => {}
    }
    let routing = v.as_ref().map(|v| routing(proto, v)).unwrap_or_default();
    let waited_since = Instant::now();
    let mut line = Some(line);
    let mut tasks = routing.tasks;
    loop {
        let mut emit = false;
        let mut start = None;
        let mut between = None;
        {
            let Ok(mut guard) = session.inner.lock() else {
                return;
            };
            let inner = &mut *guard;
            let Some(live) = inner.live.as_mut().filter(|l| l.serial == serial) else {
                return;
            };
            // Claude speaks for itself only. An ACP line about a subagent's
            // session is the subagent's.
            let own = proto == Proto::Claude
                || routing.session.is_some() && routing.session == live.acp_session;
            if let Some(next) = tasks.take().filter(|_| own) {
                keep_background(&mut live.background, next);
                if !inner.live_turn {
                    let watch = watch_of(&live.background);
                    if inner.watch != watch {
                        inner.watch = watch;
                        inner.seq += 1;
                        emit = true;
                    }
                }
            }
            if let Some(id) = routing.answer {
                // A prompt's answer ends its turn. Turns ahead of it that never
                // closed, such as a reply grok started by itself and was
                // stopped in, go with it. Any other answer is to the setup of
                // the turn starting the process.
                let at = live
                    .turns
                    .iter()
                    .position(|t| t.end == TurnEnd::Response(id));
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
            } else if let Some(front) = live.turns.front() {
                let _ = front
                    .tx
                    .send(LiveLine::Line(line.take().unwrap_or_default()));
                if own && routing.ends.is_some_and(|end| end == front.end) {
                    live.turns.pop_front();
                }
            } else if own && routing.starts {
                // A prompt is on its way, and its turn reads this reply, or
                // the last turn is still closing.
                let busy = inner.live_turn || inner.status == AgentStatus::Working;
                if busy && waited_since.elapsed() < HANDOFF_WAIT {
                    drop(guard);
                    if emit {
                        crate::daemon::emit_agent_frame(&session.id);
                    }
                    std::thread::sleep(Duration::from_millis(20));
                    continue;
                }
                if inner.live_turn {
                    eprintln!(
                        "[crew] {}: a reply {} started had no turn to go to",
                        session.id,
                        proto.name()
                    );
                } else {
                    // The CLI answers again on its own, as when a task it put
                    // in the background ends: a turn nobody prompted. So is
                    // one a prompt said it was coming for and never did.
                    let (tx, rx) = channel();
                    let _ = tx.send(LiveLine::Line(line.take().unwrap_or_default()));
                    let end = proto.own_end();
                    live.turns.push_back(Sink {
                        generation: inner.generation,
                        tx,
                        end,
                    });
                    inner.interrupted = false;
                    if inner.status == AgentStatus::Idle {
                        inner.status = AgentStatus::Working;
                    }
                    inner.last_output = Instant::now();
                    open_turn(inner);
                    let ctx = TurnCtx { proto, serial, end };
                    start = Some((rx, inner.generation, ctx));
                }
            } else if proto == Proto::Claude {
                if let Some(v) = v.as_ref() {
                    crate::usage::note_claude_event(v);
                }
            } else {
                // A subagent grok left running reports between turns.
                between = live.grok_state.take();
            }
        }
        if emit {
            crate::daemon::emit_agent_frame(&session.id);
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
                    settle(&mut inner, generation);
                    if inner.status == AgentStatus::Working {
                        inner.status = AgentStatus::Idle;
                    }
                }
            }
        }
        return;
    }
}

/// The CLI asked Crew for something. Crew asks nobody: a bot that may not
/// run a tool without leave does not run it, and anything else is refused.
fn answer_request(session: &HeadlessSession, serial: u64, v: &Value) {
    let stdin = session.inner.lock().ok().and_then(|inner| {
        let live = inner.live.as_ref().filter(|l| l.serial == serial)?;
        Some(Arc::clone(&live.stdin))
    });
    let Some(stdin) = stdin else {
        return;
    };
    let method = v.get("method").and_then(Value::as_str).unwrap_or_default();
    let id = v.get("id").cloned().unwrap_or(Value::Null);
    let reply = if method == "session/request_permission" {
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

/// A reply the CLI started by itself. It reads like a prompted turn's and
/// ends the same way, with nothing to save for a prompt.
fn run_unprompted(
    session: Arc<HeadlessSession>,
    rx: Receiver<LiveLine>,
    generation: u64,
    ctx: TurnCtx,
) {
    let mut turn = crate::transcript::begin_turn(&session.id);
    crate::daemon::turn_reopened(&session.id);
    crate::daemon::note_turn_failed(&session.id, false);
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
        let live = inner.live.as_ref()?;
        inner.watch = watch_of(&live.background);
        inner.seq += 1;
        let acp = live.acp_session.clone();
        Some((Arc::clone(&live.stdin), live.serial, live.proto, acp))
    });
    let Some((stdin, serial, proto, acp)) = target else {
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
    }
    .to_string();
    if write_line(&stdin, &request).is_err() {
        close_serial(session, serial);
        return;
    }
    // The CLI ends the stopped turn at once. One that does not is stuck, and
    // goes as a stop took it before.
    let session = Arc::clone(session);
    let _ = std::thread::Builder::new()
        .name(format!("crew-stop-{}", session.id))
        .spawn(move || {
            std::thread::sleep(STOP_WAIT);
            let stuck = session.inner.lock().is_ok_and(|inner| {
                inner.live.as_ref().is_some_and(|live| {
                    live.serial == serial && live.turns.iter().any(|t| t.generation == generation)
                })
            });
            if stuck {
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
}
