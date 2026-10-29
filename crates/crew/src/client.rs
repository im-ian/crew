use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{bail, Context};

use crate::config::AgentConfig;
use crate::paths;
use crate::protocol::{Event, Request};

/// A request the daemon answers out of its own state. Everything it does for
/// one is bounded, so silence past this means wedged rather than busy.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(15);

/// The liveness probe, and the only request whose job is to notice trouble.
/// The window polls it every second, so it has to give up inside that.
const PING_TIMEOUT: Duration = Duration::from_millis(900);

/// One short line into a socket buffer. Taking this long means nobody is
/// draining it.
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);

/// How long the whole exchange may take. `None` is for the two that are not
/// questions: `Ask` waits on a person, and `Subscribe` is a stream the daemon
/// keeps pushing to. Every other variant is a question the daemon answers, and
/// leaving them unbounded parked the caller for good when a socket took the
/// connection and then went quiet.
///
/// Matched exhaustively on purpose: a new long-running request should not
/// inherit a fifteen-second guillotine from a catch-all.
fn answer_timeout(req: &Request) -> Option<Duration> {
    match req {
        Request::Ask { .. } | Request::Subscribe => None,
        Request::Ping => Some(PING_TIMEOUT),
        Request::List
        | Request::Send { .. }
        | Request::Tell { .. }
        | Request::Input { .. }
        | Request::Resize { .. }
        | Request::Snapshot { .. }
        | Request::Messages { .. }
        | Request::AddAgent { .. }
        | Request::CloneAgent { .. }
        | Request::RemoveAgent { .. }
        | Request::SetAgent { .. }
        | Request::SetCli { .. }
        | Request::Reset { .. }
        | Request::AddRoutine { .. }
        | Request::RemoveRoutine { .. }
        | Request::SetRoutineEnabled { .. }
        | Request::RunRoutine { .. }
        | Request::EditRoutine { .. }
        | Request::RoutineRuns { .. }
        | Request::Interrupt { .. }
        | Request::CancelQueued { .. }
        | Request::EditQueued { .. }
        | Request::SendQueued { .. }
        | Request::Approve { .. }
        | Request::AnswerChoice { .. }
        | Request::Search { .. }
        | Request::Shutdown => Some(ANSWER_TIMEOUT),
    }
}

pub fn rpc(req: Request) -> anyhow::Result<Event> {
    let answer = answer_timeout(&req);
    rpc_within(req, answer)
}

/// Like `rpc`, but a dead socket is brought back first and the request is
/// tried once more. The window polls this from `daemon_ping`. Message fetches
/// stay on `rpc`: they run on the UI thread several times a second, and
/// waiting out a daemon start there would freeze the window.
///
/// One extra try, not a loop. A daemon that cannot stay up has to surface on
/// the banner instead of being spawned again inside the same call.
pub fn rpc_connected(req: Request) -> anyhow::Result<Event> {
    rpc_recovering(req, !running_as_agent(), ensure_daemon)
}

fn rpc_recovering(
    req: Request,
    allow_restart: bool,
    bring_up: impl FnOnce() -> anyhow::Result<()>,
) -> anyhow::Result<Event> {
    let answer = answer_timeout(&req);
    match rpc_within(req.clone(), answer) {
        Ok(ev) => Ok(ev),
        Err(err) if allow_restart && wants_reconnect(&req) && connection_lost(&err) => {
            // A daemon that accepted and then dropped this one socket is still
            // there. Starting another would unlink it (issue #25).
            if !paths::is_socket_live() {
                bring_up()?;
            }
            rpc_within(req, answer)
        }
        Err(err) => Err(err),
    }
}

fn wants_reconnect(req: &Request) -> bool {
    // `stop_daemon` reaches `Shutdown` while it may already be inside
    // `ensure_daemon`. Restarting from that failure would put the daemon back
    // and then deadlock on the spawn lock.
    !matches!(req, Request::Shutdown)
}

/// The socket never connected, or the daemon went away on it. A timeout is
/// not this: the daemon accepted, and killing it would drop the turn it is in.
fn connection_lost(err: &anyhow::Error) -> bool {
    let top = err.to_string();
    if top.contains("cannot connect to daemon") || top.contains("daemon closed the connection") {
        return true;
    }
    err.chain().any(|cause| {
        cause.downcast_ref::<std::io::Error>().is_some_and(|io| {
            matches!(
                io.kind(),
                std::io::ErrorKind::ConnectionRefused
                    | std::io::ErrorKind::ConnectionReset
                    | std::io::ErrorKind::ConnectionAborted
                    | std::io::ErrorKind::NotConnected
                    | std::io::ErrorKind::BrokenPipe
            )
        })
    })
}

fn rpc_within(req: Request, answer: Option<Duration>) -> anyhow::Result<Event> {
    let mut stream = connect()?;
    // `connect` arms every socket with `ANSWER_TIMEOUT`. Ask waits on a
    // person and Subscribe is a stream, so that default would cut them off.
    if answer.is_none() {
        stream.set_read_timeout(None).map_err(stalled)?;
    }
    let line = req.to_line()?;
    writeln!(stream, "{line}").map_err(stalled)?;
    stream.flush().map_err(stalled)?;
    // The budget is for the exchange, not for one read. The loop below skips
    // events that do not answer this request, and re-arming the full timeout
    // each time would let a daemon dribbling one unrelated event a second keep
    // a caller here forever.
    let deadline = answer.map(|answer| Instant::now() + answer);
    let mut reader = BufReader::new(stream);
    let mut buf = String::new();
    loop {
        if let Some(deadline) = deadline {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(no_answer());
            }
            reader.get_ref().set_read_timeout(Some(left))?;
        }
        buf.clear();
        let n = reader.read_line(&mut buf).map_err(stalled)?;
        if n == 0 {
            bail!("daemon closed the connection");
        }
        // The daemon's own reader skips these; a blank line is not a protocol
        // error to report back.
        if buf.trim().is_empty() {
            continue;
        }
        let ev = Event::from_line(buf.trim_end())?;
        match (&req, &ev) {
            (Request::Ping, Event::Pong)
            | (Request::List, Event::Agents { .. })
            | (Request::Send { .. }, Event::Ok)
            | (Request::Tell { .. }, Event::Told { .. } | Event::Ok)
            | (Request::Input { .. }, Event::Ok)
            | (Request::Resize { .. }, Event::Ok)
            | (Request::Snapshot { .. }, Event::Snapshot { .. })
            | (Request::Messages { .. }, Event::Messages { .. })
            | (Request::AddAgent { .. }, Event::Ok | Event::Agents { .. })
            | (
                Request::CloneAgent { .. },
                Event::Cloned { .. } | Event::Ok | Event::Agents { .. },
            )
            | (Request::RemoveAgent { .. }, Event::Ok | Event::Agents { .. })
            | (Request::SetAgent { .. }, Event::Ok | Event::Agents { .. })
            | (Request::SetCli { .. }, Event::Ok | Event::Agents { .. })
            | (Request::Reset { .. }, Event::Reset { .. } | Event::Ok)
            | (Request::AddRoutine { .. }, Event::Ok | Event::Agents { .. })
            | (Request::RemoveRoutine { .. }, Event::Ok | Event::Agents { .. })
            | (Request::SetRoutineEnabled { .. }, Event::Ok | Event::Agents { .. })
            | (Request::RunRoutine { .. }, Event::Ok | Event::Agents { .. })
            | (Request::EditRoutine { .. }, Event::Ok | Event::Agents { .. })
            | (Request::RoutineRuns { .. }, Event::RoutineRuns { .. })
            | (Request::Interrupt { .. }, Event::Ok)
            | (Request::CancelQueued { .. }, Event::Ok)
            | (Request::EditQueued { .. }, Event::Ok)
            | (Request::SendQueued { .. }, Event::Ok)
            | (Request::Approve { .. }, Event::Ok)
            | (Request::Ask { .. }, Event::Answered { .. } | Event::Error { .. })
            | (Request::AnswerChoice { .. }, Event::Ok)
            | (Request::Search { .. }, Event::Search { .. })
            | (Request::Shutdown, Event::Shutdown | Event::Ok)
            | (_, Event::Error { .. }) => return Ok(ev),
            _ => continue,
        }
    }
}

fn no_answer() -> anyhow::Error {
    anyhow::anyhow!(
        "daemon took the connection but did not answer ({})",
        paths::socket_path().display()
    )
}

/// A stall and a real IO error read the same from a caller's side unless the
/// timeout is named; keep the OS error as the cause so EAGAIN and ETIMEDOUT
/// stay distinguishable.
fn stalled(err: std::io::Error) -> anyhow::Error {
    match err.kind() {
        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut => {
            anyhow::Error::from(err).context(no_answer().to_string())
        }
        _ => err.into(),
    }
}

/// Deadlines belong to the connection, so nothing that reaches for one gets an
/// untimed socket. `rpc_within` narrows the read budget per request.
pub fn connect() -> anyhow::Result<UnixStream> {
    let stream = UnixStream::connect(paths::socket_path()).with_context(|| {
        format!(
            "cannot connect to daemon at {}",
            paths::socket_path().display()
        )
    })?;
    stream.set_write_timeout(Some(WRITE_TIMEOUT))?;
    stream.set_read_timeout(Some(ANSWER_TIMEOUT))?;
    Ok(stream)
}

pub fn tell_from(explicit: Option<String>) -> String {
    let explicit = explicit.and_then(|s| {
        let t = s.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    });
    if let Some(from) = explicit {
        return from;
    }
    std::env::var("CREW_AGENT_ID")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "user".into())
}

fn running_as_agent() -> bool {
    std::env::var("CREW_AGENT_ID")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .is_some()
}

/// One start at a time. The window's ping can overlap itself, and two spawns
/// would each unlink the other's socket (issue #25).
static SPAWN: Mutex<()> = Mutex::new(());

/// A start that just failed. Pings already in flight would otherwise each
/// spawn again, and a hot poll is five times a second.
static SPAWN_FAILURE: Mutex<Option<(Instant, String)>> = Mutex::new(None);

const SPAWN_BACKOFF: Duration = Duration::from_secs(2);

fn daemon_usable() -> bool {
    paths::is_socket_live()
        && (paths::daemon_version_matches(env!("CARGO_PKG_VERSION")) || running_as_agent())
}

fn lock_spawn_failure() -> std::sync::MutexGuard<'static, Option<(Instant, String)>> {
    SPAWN_FAILURE.lock().unwrap_or_else(|err| err.into_inner())
}

fn clear_spawn_failure() {
    *lock_spawn_failure() = None;
}

fn remember_spawn_failure(message: String) {
    *lock_spawn_failure() = Some((Instant::now(), message));
}

fn recent_spawn_failure() -> Option<anyhow::Error> {
    match lock_spawn_failure().as_ref() {
        Some((at, message)) if at.elapsed() < SPAWN_BACKOFF => Some(anyhow::anyhow!("{message}")),
        _ => None,
    }
}

pub fn ensure_daemon() -> anyhow::Result<()> {
    if daemon_usable() {
        clear_spawn_failure();
        return Ok(());
    }
    if running_as_agent() {
        bail!(
            "daemon is not running ({}); agent processes will not start one",
            paths::socket_path().display()
        );
    }
    let _guard = SPAWN.lock().unwrap_or_else(|err| err.into_inner());
    if paths::is_socket_live() {
        if paths::daemon_version_matches(env!("CARGO_PKG_VERSION")) {
            clear_spawn_failure();
            return Ok(());
        }
        // A packaged update replaces Crew.app in place. The desktop process
        // restarts the daemon so the new binary takes over. Agents never
        // reach this: `daemon_usable` already returned for them.
        let _ = stop_daemon();
    } else if let Some(err) = recent_spawn_failure() {
        return Err(err);
    }
    if let Err(err) = start_daemon() {
        remember_spawn_failure(err.to_string());
        return Err(err);
    }
    clear_spawn_failure();
    Ok(())
}

fn start_daemon() -> anyhow::Result<()> {
    paths::ensure_home()?;
    if paths::socket_path().exists() {
        paths::remove_stale_socket();
    }

    let exe = std::env::current_exe().context("current_exe")?;
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(paths::log_path())?;
    let mut cmd = Command::new(exe);
    cmd.arg("daemon")
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    cmd.spawn().context("spawn crew daemon")?;

    let deadline = Instant::now() + Duration::from_secs(4);
    while Instant::now() < deadline {
        if paths::is_socket_live() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(50));
    }
    let tail = std::fs::read_to_string(paths::log_path()).unwrap_or_default();
    let tail = tail
        .lines()
        .rev()
        .take(12)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n");
    bail!("daemon did not start. log tail:\n{tail}")
}

pub fn stop_daemon() -> anyhow::Result<()> {
    if paths::is_socket_live() {
        match rpc(Request::Shutdown) {
            Ok(_) => {
                wait_dead(Duration::from_secs(2));
                cleanup();
                return Ok(());
            }
            Err(_) => {}
        }
    }
    if let Some(pid) = paths::read_pid() {
        let _ = Command::new("kill").arg(pid.to_string()).status();
        wait_dead(Duration::from_secs(2));
    }
    cleanup();
    Ok(())
}

fn wait_dead(timeout: Duration) {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if !paths::is_socket_live() {
            return;
        }
        thread::sleep(Duration::from_millis(40));
    }
}

fn cleanup() {
    paths::remove_stale_socket();
    paths::remove_pid();
    paths::remove_daemon_version();
}

pub fn print_event(ev: Event) -> anyhow::Result<()> {
    match ev {
        Event::Agents { agents, .. } => {
            let lang = crate::paths::locale();
            if agents.is_empty() {
                println!("(no agents)");
            }
            for a in agents {
                let model = a.model.as_deref().unwrap_or("-");
                let effort = a
                    .effort
                    .map(|e| e.as_str().to_string())
                    .unwrap_or_else(|| "-".into());
                println!(
                    "{:<12} {:<12} {:<8} {:<16} {:<8} {}  {}",
                    a.id,
                    a.name,
                    a.status.label(&lang),
                    model,
                    effort,
                    a.cwd,
                    a.cmd.join(" ")
                );
            }
        }
        Event::Reset {
            agent,
            archive,
            drop_routines,
        } => {
            println!(
                "ok {agent} archived {archive}{}",
                if drop_routines { " drop_routines" } else { "" }
            );
        }
        Event::Snapshot {
            agent,
            text,
            status,
            ..
        } => {
            println!("# {agent} ({})", status.label(&crate::paths::locale()));
            print!("{text}");
            if !text.ends_with('\n') {
                println!();
            }
        }
        Event::Told { from, to } => {
            println!("ok {from} → {to}");
            // A bot reads this mid-turn, and its tell starts only once that turn ends.
            if from != "user" {
                println!("{to} starts only after your turn ends. End your turn now. Do not wait or check for the answer.");
            }
        }
        Event::Cloned { id } => println!("ok {id}"),
        Event::Messages { agent, messages } => {
            println!("# {agent} ({} messages)", messages.len());
            for m in messages {
                let text = m.text.replace('\n', "\\n");
                println!("{}  {}  {text}", m.role.as_str(), m.from);
            }
        }
        Event::Message { agent, message } => {
            let text = message.text.replace('\n', "\\n");
            println!(
                "{agent}\t{}\t{}\t{}\t{text}",
                message.role.as_str(),
                message.from,
                message.id
            );
        }
        Event::Answered { text } => {
            print!("{text}");
            if !text.ends_with('\n') {
                println!();
            }
        }
        Event::Error { message } => bail!("{message}"),
        Event::Ok | Event::Pong | Event::Shutdown => println!("ok"),
        other => println!("{}", other.to_line()?),
    }
    Ok(())
}

/// One row per routine: host, id, name, schedule, on/off, next run, last run.
fn routine_rows(
    hosts: &[(String, Vec<crate::config::Routine>)],
    filter: Option<&str>,
    now: libc::time_t,
) -> anyhow::Result<Vec<String>> {
    if let Some(id) = filter {
        if !hosts.iter().any(|(host, _)| host == id) {
            bail!("unknown bot {id}");
        }
    }
    let mut rows = Vec::new();
    for (host, routines) in hosts {
        if let Some(id) = filter {
            if host != id {
                continue;
            }
        }
        for r in routines {
            let next = if r.enabled {
                crate::cron::next_after(&r.schedule, now)
                    .ok()
                    .flatten()
                    .map(|t| t.minute_key())
            } else {
                None
            };
            rows.push(format!(
                "{}\t{}\t{}\t{}\t{}\t{}\t{}",
                host,
                r.id,
                r.name,
                r.schedule,
                if r.enabled { "on" } else { "off" },
                next.as_deref().unwrap_or("-"),
                r.last_run.as_deref().unwrap_or("-")
            ));
        }
    }
    Ok(rows)
}

fn print_routine_rows(
    hosts: &[(String, Vec<crate::config::Routine>)],
    filter: Option<&str>,
) -> anyhow::Result<()> {
    let rows = routine_rows(hosts, filter, crate::cron::unix_now()?)?;
    if rows.is_empty() {
        println!("(no routines)");
    } else {
        println!("bot\tid\tname\tschedule\tstate\tnext\tlast");
    }
    for row in rows {
        println!("{row}");
    }
    Ok(())
}

pub fn print_routines_from_config(
    agents: &[AgentConfig],
    filter: Option<&str>,
) -> anyhow::Result<()> {
    let hosts: Vec<(String, Vec<crate::config::Routine>)> = agents
        .iter()
        .map(|a| (a.id.clone(), a.routines.clone()))
        .collect();
    print_routine_rows(&hosts, filter)
}

#[cfg(test)]
mod tests {
    use std::io::{BufRead, BufReader, Write};

    use super::*;
    use crate::config::Routine;

    #[test]
    fn a_person_gets_as_long_as_they_need_and_nobody_else_does() {
        assert_eq!(
            answer_timeout(&Request::Ask {
                agent: "a".into(),
                question: "?".into(),
                options: Vec::new(),
                inputs: Vec::new(),
                hint: None,
                multi: false,
            }),
            None,
            "Ask waits on a person"
        );
        assert_eq!(answer_timeout(&Request::Ping), Some(PING_TIMEOUT));
        assert_eq!(answer_timeout(&Request::List), Some(ANSWER_TIMEOUT));
    }

    /// A daemon can take the connection and then never answer — an accept loop
    /// wedged on a lock, or one killed between the connect and the reply. That
    /// used to park the caller for good.
    ///
    /// Run on a worker with a deadline, because the regression this guards is
    /// "blocks forever": asserting inline would hang the suite instead of
    /// failing it.
    #[test]
    fn a_socket_that_never_answers_gives_up() {
        paths::testing::with_home("rpc", || {
            paths::ensure_home().expect("home");
            let listener =
                std::os::unix::net::UnixListener::bind(paths::socket_path()).expect("bind");
            // Accept and say nothing, holding the connection open.
            let quiet = thread::spawn(move || listener.accept().map(|(s, _)| s));

            let (tx, rx) = std::sync::mpsc::channel();
            thread::spawn(move || {
                let _ = tx.send(
                    rpc_within(Request::Ping, Some(Duration::from_millis(200)))
                        .map(|ev| format!("{ev:?}"))
                        .map_err(|err| format!("{err:#}")),
                );
            });
            let err = rx
                .recv_timeout(Duration::from_secs(5))
                .expect("rpc must return, not park")
                .expect_err("a silent daemon is not an answer");
            assert!(err.contains("did not answer"), "{err}");
            drop(quiet.join().expect("accept"));
        });
    }

    /// `connect` puts a fifteen-second read deadline on the socket. Ask's
    /// budget is `None`, and leaving the socket deadline in place fails the
    /// command while the person is still looking at the card.
    #[test]
    fn an_ask_waits_past_the_socket_deadline() {
        paths::testing::with_home("ask-wait", || {
            paths::ensure_home().expect("home");
            let listener =
                std::os::unix::net::UnixListener::bind(paths::socket_path()).expect("bind");
            let slow = thread::spawn(move || {
                let (mut stream, _) = listener.accept().expect("accept");
                let mut line = String::new();
                let mut reader = BufReader::new(stream.try_clone().expect("clone"));
                reader.read_line(&mut line).expect("read");
                thread::sleep(ANSWER_TIMEOUT + Duration::from_millis(300));
                let answered = Event::Answered {
                    text: "고름".into(),
                }
                .to_line()
                .expect("line");
                writeln!(stream, "{answered}").expect("write");
            });
            let ev = rpc_within(
                Request::Ask {
                    agent: "a".into(),
                    question: "어느 쪽?".into(),
                    options: vec!["고름".into()],
                    inputs: Vec::new(),
                    hint: None,
                    multi: false,
                },
                None,
            )
            .expect("ask outlives the socket deadline");
            assert!(
                matches!(ev, Event::Answered { ref text } if text == "고름"),
                "{ev:?}"
            );
            slow.join().expect("listener");
        });
    }

    /// A stream and a question are not the same shape, and the loop skips
    /// events that do not answer the request — so a deadline that re-armed per
    /// read would never fire against a daemon pushing frames.
    #[test]
    fn a_stream_is_not_a_question() {
        assert_eq!(answer_timeout(&Request::Subscribe), None);
        assert!(
            PING_TIMEOUT < Duration::from_secs(1),
            "the window polls it every second"
        );
    }

    fn answer_pong(listener: std::os::unix::net::UnixListener) {
        let (mut stream, _) = listener.accept().expect("accept");
        let mut line = String::new();
        let mut reader = BufReader::new(stream.try_clone().expect("clone"));
        reader.read_line(&mut line).expect("read");
        let pong = Event::Pong.to_line().expect("pong");
        writeln!(stream, "{pong}").expect("write");
    }

    #[test]
    fn a_dead_daemon_is_brought_back_for_the_same_ping() {
        paths::testing::with_home("reconn", || {
            paths::ensure_home().expect("home");
            let mut started = false;
            let ev = rpc_recovering(Request::Ping, true, || {
                started = true;
                let listener =
                    std::os::unix::net::UnixListener::bind(paths::socket_path()).expect("bind");
                thread::spawn(move || answer_pong(listener));
                Ok(())
            })
            .expect("ping after restart");
            assert!(started, "nothing was listening");
            assert!(matches!(ev, Event::Pong), "{ev:?}");
        });
    }

    #[test]
    fn a_daemon_that_drops_one_socket_is_not_replaced() {
        paths::testing::with_home("reconn-drop", || {
            paths::ensure_home().expect("home");
            let listener =
                std::os::unix::net::UnixListener::bind(paths::socket_path()).expect("bind");
            thread::spawn(move || {
                // The failed call, then the liveness probe, then the retry.
                for _ in 0..2 {
                    let (stream, _) = listener.accept().expect("accept");
                    drop(stream);
                }
                answer_pong(listener);
            });
            let mut started = false;
            let ev = rpc_recovering(Request::Ping, true, || {
                started = true;
                Ok(())
            })
            .expect("retry on the same daemon");
            assert!(!started, "a live socket must not be unlinked");
            assert!(matches!(ev, Event::Pong), "{ev:?}");
        });
    }

    #[test]
    fn a_quiet_daemon_is_left_alone() {
        paths::testing::with_home("reconn-quiet", || {
            paths::ensure_home().expect("home");
            let listener =
                std::os::unix::net::UnixListener::bind(paths::socket_path()).expect("bind");
            let quiet = thread::spawn(move || listener.accept().map(|(s, _)| s));
            let mut started = false;
            let err = rpc_recovering(Request::Ping, true, || {
                started = true;
                Ok(())
            })
            .expect_err("silence is not a dead socket");
            assert!(!started);
            assert!(format!("{err:#}").contains("did not answer"), "{err:#}");
            drop(quiet.join().expect("accept"));
        });
    }

    #[test]
    fn stopping_does_not_start_another_daemon() {
        paths::testing::with_home("reconn-stop", || {
            paths::ensure_home().expect("home");
            let mut started = false;
            let err = rpc_recovering(Request::Shutdown, true, || {
                started = true;
                Ok(())
            })
            .expect_err("nothing is listening");
            assert!(!started);
            assert!(format!("{err:#}").contains("cannot connect"), "{err:#}");
        });
    }

    #[test]
    fn a_timeout_is_not_a_lost_connection() {
        let hung = anyhow::anyhow!("daemon took the connection but did not answer (/tmp/x)");
        assert!(!connection_lost(&hung));
        let timed = anyhow::Error::from(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "timed out",
        ));
        assert!(!connection_lost(&timed));
        assert!(connection_lost(&anyhow::anyhow!(
            "cannot connect to daemon at /tmp/x"
        )));
        assert!(connection_lost(&anyhow::anyhow!(
            "daemon closed the connection"
        )));
        assert!(connection_lost(&anyhow::Error::from(std::io::Error::new(
            std::io::ErrorKind::BrokenPipe,
            "pipe",
        ))));
    }

    fn routine(name: &str) -> Routine {
        let mut r = Routine::new(name.into(), "0 9 * * *".into(), "brief".into()).unwrap();
        r.id = format!("id-{name}");
        r
    }

    fn hosts() -> Vec<(String, Vec<Routine>)> {
        vec![
            ("alpha".into(), vec![routine("daily")]),
            ("beta".into(), vec![routine("standup")]),
            ("gamma".into(), Vec::new()),
        ]
    }

    #[test]
    fn rows_cover_each_bots_routines() {
        let rows = routine_rows(&hosts(), None, 1_790_000_000).unwrap();
        assert_eq!(rows.len(), 2);
        let cols: Vec<&str> = rows[0].split('\t').collect();
        assert_eq!(cols[..5], ["alpha", "id-daily", "daily", "0 9 * * *", "on"]);
        assert!(cols[5].ends_with("T09:00"), "next run: {}", cols[5]);
        assert_eq!(cols[6], "-");
        assert!(rows[1].starts_with("beta\tid-standup\tstandup"));
    }

    #[test]
    fn a_filter_picks_one_host_and_rejects_unknown_ones() {
        let rows = routine_rows(&hosts(), Some("beta"), 0).unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].starts_with("beta\t"));
        // A host with no routines still resolves; it just prints nothing.
        assert!(routine_rows(&hosts(), Some("gamma"), 0).unwrap().is_empty());
        assert!(routine_rows(&hosts(), Some("nope"), 0).is_err());
    }
}
