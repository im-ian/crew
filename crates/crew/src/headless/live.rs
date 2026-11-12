//! Claude kept up between turns.
//!
//! A Claude turn used to be its own process, and Claude keeps that process up
//! past its `result` while a task it put in the background runs. A send in
//! that time waited for the task, forever for a dev server, and stopping the
//! CLI to let it through stopped the task too. Now one process stays up and
//! reads each prompt from stdin as a stream-json line. A turn ends at its
//! `result`; the next prompt goes to the same process, and its background
//! tasks go on.
//!
//! One reader thread owns the process's stdout. Each turn gets the lines up
//! to its `result` over a channel. Lines that come while no turn is open are
//! Claude's own: the task list, and the reply it starts by itself once a task
//! ends, which becomes a turn of its own.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, ExitStatus, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use anyhow::Context;
use serde_json::Value;

use super::{
    arm_first_output_watch, claude_background, cli_command, end_turn_early, is_claude_turn_start,
    is_stale, is_turn_end, keep_background, kill_all, note_stdout, show_compacts, stream_line,
    strip_tui_noise, CliKind, HeadlessInner, HeadlessSession, ParseState, TurnOutcome,
};
use crate::protocol::{AgentStatus, Watch};

pub(super) struct LiveCli {
    /// Which process this is, so a reader can tell its own from the next.
    serial: u64,
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    started: Started,
    /// Turns given this process's lines, oldest first. Each ends at its
    /// `result`, including one that was stopped.
    turns: VecDeque<Sink>,
    /// Claude's latest list of tasks running in the background.
    background: Vec<(String, Watch)>,
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
}

struct Sink {
    generation: u64,
    tx: Sender<LiveLine>,
}

enum LiveLine {
    Line(String),
    /// The process is gone: its exit status and what it wrote to stderr.
    Exit(Option<ExitStatus>, String),
}

static SERIAL: AtomicU64 = AtomicU64::new(1);
static STOP_ID: AtomicU64 = AtomicU64::new(1);

/// How long Claude has to end a stopped turn with its `result` before the
/// process is killed, as a stop did before. It answers at once.
const STOP_WAIT: Duration = if cfg!(test) {
    Duration::from_secs(1)
} else {
    Duration::from_secs(10)
};

/// How long a reply Claude starts by itself waits for a prompt that is on
/// its way. That prompt's turn reads it.
const HANDOFF_WAIT: Duration = Duration::from_secs(30);

/// The stderr kept for a turn that fails.
const STDERR_KEEP: usize = 16 * 1024;

/// One prompted turn on the live process. A process kept from an earlier
/// turn that died before it read the prompt is started again, once.
pub(super) fn run_turn(
    session: &Arc<HeadlessSession>,
    argv: &[String],
    started: Started,
    prompt: &str,
    generation: u64,
    turn: &mut u64,
) -> anyhow::Result<TurnOutcome> {
    if argv.is_empty() {
        anyhow::bail!("empty command");
    }
    let line = prompt_line(prompt);
    let mut armed = false;
    let mut fresh = false;
    loop {
        let (tx, rx) = channel();
        let (stdin, reused) = claim(session, argv, &started, generation, tx, fresh)?;
        match write_prompt(session, &stdin, &line, generation) {
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
            arm_first_output_watch(Arc::clone(session), generation, CliKind::Claude);
            armed = true;
        }
        let read = read_turn(session, &rx, generation, turn);
        if read.unheard && reused && !fresh && !is_stale(session, generation) {
            fresh = true;
            continue;
        }
        return Ok(read.outcome);
    }
}

/// The process this turn writes to, with the turn's sink in its line. One
/// kept from an earlier turn is reused while it runs and nothing it was
/// started with changed; otherwise it goes and a new one starts.
fn claim(
    session: &Arc<HeadlessSession>,
    argv: &[String],
    started: &Started,
    generation: u64,
    tx: Sender<LiveLine>,
    fresh: bool,
) -> anyhow::Result<(Arc<Mutex<ChildStdin>>, bool)> {
    let old = {
        let mut inner = session.inner.lock().expect("headless inner");
        if inner.generation != generation {
            anyhow::bail!("turn cancelled");
        }
        let inner = &mut *inner;
        let keep = !fresh
            && inner.live.as_mut().is_some_and(|live| {
                live.started == *started && matches!(live.child.try_wait(), Ok(None))
            });
        if keep {
            let live = inner.live.as_mut().expect("kept");
            live.turns.push_back(Sink { generation, tx });
            let stdin = Arc::clone(&live.stdin);
            open_turn(inner);
            return Ok((stdin, true));
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
    let cancelled = {
        let mut inner = session.inner.lock().expect("headless inner");
        if inner.generation != generation {
            Some(child)
        } else {
            inner.live = Some(LiveCli {
                serial,
                child,
                stdin: Arc::clone(&stdin),
                started: started.clone(),
                turns: VecDeque::from([Sink { generation, tx }]),
                background: Vec::new(),
            });
            open_turn(&mut inner);
            None
        }
    };
    if let Some(mut child) = cancelled {
        kill_all(&mut child);
        anyhow::bail!("turn cancelled");
    }
    let stderr = stderr.map(keep_stderr);
    let reader = Arc::clone(session);
    if let Err(err) = std::thread::Builder::new()
        .name(format!("crew-live-{}", session.id))
        .spawn(move || read_stdout(reader, serial, stdout, stderr))
    {
        close(session);
        return Err(err).context("spawn the live CLI reader");
    }
    Ok((stdin, false))
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

/// This turn's lines, up to its `result` or the process's exit.
fn read_turn(
    session: &Arc<HeadlessSession>,
    rx: &Receiver<LiveLine>,
    generation: u64,
    turn: &mut u64,
) -> ReadTurn {
    let mut state = ParseState::default();
    if let Ok(inner) = session.inner.lock() {
        state.session_id = inner.session_id.clone();
    }
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
        let turn_end = stream_line(session, CliKind::Claude, &line, &mut state, &mut plain);
        show_compacts(session, &mut state);
        if let Some(id) = state.session_id.as_ref() {
            if let Ok(mut inner) = session.inner.lock() {
                inner.session_id = Some(id.clone());
            }
        }
        if turn_end {
            ended = Some(
                serde_json::from_str::<Value>(line.trim())
                    .ok()
                    .and_then(|v| result_failure(&v)),
            );
            // The process stays up, with what it runs in the background. The
            // agent is idle, and the next send goes to it.
            if state.got_text {
                end_turn_early(session, generation, *turn, false);
            }
            break;
        }
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
    ReadTurn {
        unheard: !heard,
        outcome: TurnOutcome {
            session_id: state.session_id,
            got_text: state.got_text,
            error,
            compacted: state.compacted,
            watched: Vec::new(),
        },
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
            route(&session, serial, line.to_string());
        }
    }
    exited(&session, serial, stderr);
}

/// Hand `line` to the turn reading this process, or read it here when none is.
fn route(session: &Arc<HeadlessSession>, serial: u64, line: String) {
    let v = serde_json::from_str::<Value>(line.trim()).ok();
    // Claude's answer to a stop's interrupt, ahead of the stopped turn's
    // `result`. It is no turn's line.
    if v.as_ref()
        .and_then(|v| v.get("type"))
        .and_then(Value::as_str)
        == Some("control_response")
    {
        return;
    }
    let result = v.as_ref().is_some_and(|v| is_turn_end(CliKind::Claude, v));
    let starts = v.as_ref().is_some_and(is_claude_turn_start);
    let tasks = v.as_ref().and_then(claude_background);
    let waited_since = Instant::now();
    let mut line = Some(line);
    let mut tasks = tasks;
    loop {
        let mut emit = false;
        let mut start = None;
        {
            let Ok(mut guard) = session.inner.lock() else {
                return;
            };
            let inner = &mut *guard;
            let Some(live) = inner.live.as_mut().filter(|l| l.serial == serial) else {
                return;
            };
            if let Some(next) = tasks.take() {
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
            if let Some(front) = live.turns.front() {
                let _ = front
                    .tx
                    .send(LiveLine::Line(line.take().unwrap_or_default()));
                if result {
                    live.turns.pop_front();
                }
            } else if starts {
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
                        "[crew] {}: a reply Claude started had no turn to go to",
                        session.id
                    );
                } else {
                    // Claude answers again on its own, as when a task it put
                    // in the background ends: a turn nobody prompted. So is
                    // one a prompt said it was coming for and never did.
                    let (tx, rx) = channel();
                    let _ = tx.send(LiveLine::Line(line.take().unwrap_or_default()));
                    live.turns.push_back(Sink {
                        generation: inner.generation,
                        tx,
                    });
                    inner.interrupted = false;
                    if inner.status == AgentStatus::Idle {
                        inner.status = AgentStatus::Working;
                    }
                    inner.last_output = Instant::now();
                    open_turn(inner);
                    start = Some((rx, inner.generation));
                }
            } else if let Some(v) = v.as_ref() {
                crate::usage::note_claude_event(v);
            }
        }
        if emit {
            crate::daemon::emit_agent_frame(&session.id);
        }
        if let Some((rx, generation)) = start {
            let turn_session = Arc::clone(session);
            if let Err(err) = std::thread::Builder::new()
                .name(format!("crew-turn-{}", session.id))
                .spawn(move || run_unprompted(turn_session, rx, generation))
            {
                eprintln!("[crew] {}: Claude's own reply: {err}", session.id);
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

/// A reply Claude started by itself. It reads like a prompted turn's and ends
/// the same way, with nothing to save for a prompt.
fn run_unprompted(session: Arc<HeadlessSession>, rx: Receiver<LiveLine>, generation: u64) {
    let mut turn = crate::transcript::begin_turn(&session.id);
    crate::daemon::turn_reopened(&session.id);
    crate::daemon::note_turn_failed(&session.id, false);
    crate::daemon::emit_agent_frame(&session.id);
    let outcome = read_turn(&session, &rx, generation, &mut turn).outcome;
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
/// process, if any. With `keep_cli` Claude is asked to stop that turn, and
/// the process stays up with what it runs in the background. That holds for
/// a turn it has not answered yet too: Claude ends a prompt it was told to
/// stop before it began with a `result` of its own, and does none of it.
/// Without `keep_cli` the process goes.
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
        Some((Arc::clone(&live.stdin), live.serial))
    });
    let Some((stdin, serial)) = target else {
        return;
    };
    let id = STOP_ID.fetch_add(1, Ordering::Relaxed);
    let request = serde_json::json!({
        "type": "control_request",
        "request_id": format!("crew-stop-{id}"),
        "request": { "subtype": "interrupt" },
    })
    .to_string();
    if write_line(&stdin, &request).is_err() {
        close_serial(session, serial);
        return;
    }
    // Claude ends the stopped turn with a `result` at once. One that does not
    // is stuck, and goes as a stop took it before.
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
                    "[crew] {}: Claude did not stop its turn; killing it",
                    session.id
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
