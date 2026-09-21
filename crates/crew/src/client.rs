use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{bail, Context};

use crate::config::AgentConfig;
use crate::config::Channel;
use crate::paths;
use crate::protocol::{AgentInfo, ChannelInfo, Event, Request};

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
        | Request::Reset { .. }
        | Request::AddRoutine { .. }
        | Request::RemoveRoutine { .. }
        | Request::SetRoutineEnabled { .. }
        | Request::RunRoutine { .. }
        | Request::EditRoutine { .. }
        | Request::RoutineRuns { .. }
        | Request::Interrupt { .. }
        | Request::Approve { .. }
        | Request::AnswerChoice { .. }
        | Request::Search { .. }
        | Request::ListChannels
        | Request::ChannelMessages { .. }
        | Request::AddChannel { .. }
        | Request::JoinChannel { .. }
        | Request::LeaveChannel { .. }
        | Request::RemoveChannel { .. }
        | Request::SetChannel { .. }
        | Request::Shutdown => Some(ANSWER_TIMEOUT),
    }
}

pub fn rpc(req: Request) -> anyhow::Result<Event> {
    let answer = answer_timeout(&req);
    rpc_within(req, answer)
}

fn rpc_within(req: Request, answer: Option<Duration>) -> anyhow::Result<Event> {
    let mut stream = connect()?;
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
            | (Request::Reset { .. }, Event::Reset { .. } | Event::Ok)
            | (Request::AddRoutine { .. }, Event::Ok | Event::Agents { .. })
            | (Request::RemoveRoutine { .. }, Event::Ok | Event::Agents { .. })
            | (Request::SetRoutineEnabled { .. }, Event::Ok | Event::Agents { .. })
            | (Request::RunRoutine { .. }, Event::Ok | Event::Agents { .. })
            | (Request::EditRoutine { .. }, Event::Ok | Event::Agents { .. })
            | (Request::RoutineRuns { .. }, Event::RoutineRuns { .. })
            | (Request::Interrupt { .. }, Event::Ok)
            | (Request::Approve { .. }, Event::Ok)
            | (Request::Ask { .. }, Event::Answered { .. } | Event::Error { .. })
            | (Request::AnswerChoice { .. }, Event::Ok)
            | (Request::Search { .. }, Event::Search { .. })
            | (Request::ListChannels, Event::Channels { .. } | Event::Agents { .. })
            | (Request::ChannelMessages { .. }, Event::ChannelMessages { .. })
            | (
                Request::AddChannel { .. },
                Event::Ok | Event::Channels { .. } | Event::Agents { .. },
            )
            | (
                Request::JoinChannel { .. },
                Event::Ok | Event::Channels { .. } | Event::Agents { .. },
            )
            | (
                Request::LeaveChannel { .. },
                Event::Ok | Event::Channels { .. } | Event::Agents { .. },
            )
            | (
                Request::RemoveChannel { .. },
                Event::Ok | Event::Channels { .. } | Event::Agents { .. },
            )
            | (
                Request::SetChannel { .. },
                Event::Ok | Event::Channels { .. } | Event::Agents { .. },
            )
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

/// How long a daemon gets to answer before it counts as wedged rather than
/// busy. It has to cover a roster open, which spawns one CLI per bot — and how
/// long that takes depends on the bots, the machine and the CLIs, none of
/// which this can see. Guess too low and a healthy daemon gets killed 18
/// seconds into starting, so the guess is overridable.
const READY_TIMEOUT: Duration = Duration::from_secs(20);

fn ready_timeout() -> Duration {
    std::env::var("CREW_READY_TIMEOUT")
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .filter(|secs| *secs > 0)
        .map(Duration::from_secs)
        .unwrap_or(READY_TIMEOUT)
}

/// Each step of stopping one. A daemon that ignores `Shutdown` gets SIGTERM,
/// and one that ignores that gets SIGKILL — without the last step a daemon
/// wedged in `shutdown_agents` would hold its lock forever and no daemon could
/// ever start again.
const STOP_STEP: Duration = Duration::from_secs(5);

fn poll_until(timeout: Duration, mut ready: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if ready() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn log_tail() -> String {
    let log = std::fs::read_to_string(paths::log_path()).unwrap_or_default();
    log.lines()
        .rev()
        .take(12)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n")
}

fn spawn_daemon() -> anyhow::Result<std::process::Child> {
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
    cmd.spawn().context("spawn crew daemon")
}

/// Ownership is the lock; answering is the socket. Keeping those apart is what
/// lets this tell "starting" from "wedged" from "gone" — the socket alone
/// cannot, because it is absent for all three.
/// Whether the daemon answering on this home is this binary's version, and
/// whether that matters to this caller. Shared by both paths into
/// `ensure_daemon`: a caller that lost a start race is talking to somebody
/// else's daemon and has the same reason to check.
fn usable_daemon() -> bool {
    paths::daemon_version_matches(env!("CARGO_PKG_VERSION"))
        // A packaged update replaces Crew.app in place. Agent children must
        // keep talking to the still-running daemon; the desktop and the CLI
        // restart it so the new binary takes over.
        || running_as_agent()
}

pub fn ensure_daemon() -> anyhow::Result<()> {
    if paths::daemon_is_owned() {
        // Someone owns the home. Give them the time a roster open takes.
        if poll_until(ready_timeout(), paths::is_socket_live) {
            if usable_daemon() {
                return Ok(());
            }
        } else if running_as_agent() {
            bail!(
                "daemon owns {} but is not answering; agent processes will not restart it",
                paths::home_dir().display()
            );
        }
        // Either the wrong version, or it owns the home and will not answer.
        // Both mean the same thing here: it has to let go first.
        stop_daemon().context("stop the daemon that owns this home")?;
    } else if running_as_agent() {
        bail!(
            "daemon is not running ({}); agent processes will not start one",
            paths::socket_path().display()
        );
    }

    paths::ensure_home()?;
    // The socket is not ours to remove. A daemon merely slow to answer still
    // owns that path, and unlinking it strands it on an inode nobody can
    // reach. The daemon clears it on the way in, holding the lock.
    let mut child = spawn_daemon()?;
    let ours_exited = |child: &mut std::process::Child| matches!(child.try_wait(), Ok(Some(_)));
    let answering = poll_until(ready_timeout(), || {
        // Our child exiting is not the end of it: with the lock refusing a
        // second daemon, the loser of a start race exits in milliseconds while
        // the winner is still opening its roster. Keep waiting for whoever
        // owns the home, and only give up once nobody does.
        paths::is_socket_live() || (ours_exited(&mut child) && !paths::daemon_is_owned())
    }) && paths::is_socket_live();
    // Reap it whenever it ends, and never here: the daemon outlives this call,
    // so killing it would take down the one we just started, and dropping the
    // handle unreaped leaves a zombie under a long-lived desktop process.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    if answering && usable_daemon() {
        return Ok(());
    }
    if answering {
        // Somebody else's daemon won the race, and it is the wrong version.
        stop_daemon().context("stop the daemon that won the race")?;
        return ensure_daemon();
    }
    bail!("daemon did not start. log tail:\n{}", log_tail())
}

/// Returns only once nobody owns the home, so the caller may start one.
pub fn stop_daemon() -> anyhow::Result<()> {
    let owner = paths::daemon_owner()?;
    // Ask first, whoever owns it — and even if the lock says nobody does,
    // because a socket that answers is a daemon regardless of what happened
    // to the lock file.
    if paths::is_socket_live() {
        let _ = rpc(Request::Shutdown);
        // The same budget the start path gets: `shutdown_agents` seals every
        // transcript and kills every agent, which is the work `READY_TIMEOUT`
        // is sized for on the way in.
        if stopped(ready_timeout()) {
            cleanup();
            return Ok(());
        }
    }
    match owner {
        paths::Owner::Free => {
            cleanup();
            Ok(())
        }
        // Escalate. The lock is released by the kernel when the process ends,
        // so ending it is the whole job. Signalling kills without running
        // `shutdown_agents`, which is why it comes after asking.
        paths::Owner::Pid(pid) => {
            for signal in [libc::SIGTERM, libc::SIGKILL] {
                if unsafe { libc::kill(pid, signal) } == -1 {
                    let err = std::io::Error::last_os_error();
                    // Already gone is the outcome we wanted.
                    if err.raw_os_error() != Some(libc::ESRCH) {
                        return Err(
                            anyhow::Error::from(err).context(format!("signal daemon {pid}"))
                        );
                    }
                }
                if stopped(STOP_STEP) {
                    cleanup();
                    return Ok(());
                }
            }
            bail!(
                "daemon {pid} did not stop; it still owns {}",
                paths::home_dir().display()
            )
        }
        paths::Owner::Unnameable => bail!(
            "something owns {} and will not say which process; stop it by hand",
            paths::lock_path().display()
        ),
    }
}

/// Nobody owns the home and nothing is answering on it.
fn stopped(timeout: Duration) -> bool {
    poll_until(timeout, || {
        !paths::daemon_is_owned() && !paths::is_socket_live()
    })
}

fn cleanup() {
    // These name whoever owns the home, so they are only ours to clear once
    // nobody does. The lock is asked first and the socket second: a lock file
    // that was deleted under a running daemon reads as free, and clearing on
    // that alone would strand it on an inode nobody can reach.
    if paths::daemon_is_owned() || paths::is_socket_live() {
        return;
    }
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
        Event::Told { from, to } => println!("ok {from} → {to}"),
        Event::Cloned { id } => println!("ok {id}"),
        Event::Channels { channels } => return print_channels(&channels),
        Event::ChannelMessages { channel, messages } => {
            println!("# #{channel} ({} messages)", messages.len());
            for m in messages {
                let text = m.text.replace('\n', "\\n");
                println!("{}  {}  {text}", m.role.as_str(), m.from);
            }
        }
        Event::ChannelMessage {
            channel, message, ..
        } => {
            let text = message.text.replace('\n', "\\n");
            println!(
                "#{channel}\t{}\t{}\t{}\t{text}",
                message.role.as_str(),
                message.from,
                message.id
            );
        }
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

pub fn print_routines(
    agents: &[AgentInfo],
    channels: &[ChannelInfo],
    filter: Option<&str>,
) -> anyhow::Result<()> {
    let mut hosts: Vec<(String, Vec<crate::config::Routine>)> = agents
        .iter()
        .map(|a| (a.id.clone(), a.routines.clone()))
        .collect();
    hosts.extend(
        channels
            .iter()
            .map(|c| (format!("#{}", c.id), c.routines.clone())),
    );
    print_routine_rows(&hosts, filter)
}

/// One row per routine: host, id, name, schedule, on/off, last run. Channels are
/// listed as `#room`.
fn routine_rows(
    hosts: &[(String, Vec<crate::config::Routine>)],
    filter: Option<&str>,
) -> anyhow::Result<Vec<String>> {
    if let Some(id) = filter {
        if !hosts.iter().any(|(host, _)| host == id) {
            bail!("unknown bot or channel {id}");
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
            rows.push(format!(
                "{}\t{}\t{}\t{}\t{}\t{}",
                host,
                r.id,
                r.name,
                r.schedule,
                if r.enabled { "on" } else { "off" },
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
    let rows = routine_rows(hosts, filter)?;
    if rows.is_empty() {
        println!("(no routines)");
    }
    for row in rows {
        println!("{row}");
    }
    Ok(())
}

pub fn print_channels(channels: &[ChannelInfo]) -> anyhow::Result<()> {
    if channels.is_empty() {
        println!("(no channels)");
        return Ok(());
    }
    for c in channels {
        println!(
            "{}\t{}\t{}",
            c.id,
            c.name,
            if c.members.is_empty() {
                "-".to_string()
            } else {
                c.members.join(",")
            }
        );
    }
    Ok(())
}

pub fn print_channels_from_config(channels: &[Channel]) -> anyhow::Result<()> {
    if channels.is_empty() {
        println!("(no channels)");
        return Ok(());
    }
    for c in channels {
        println!(
            "{}\t{}\t{}",
            c.id,
            c.name,
            if c.members.is_empty() {
                "-".to_string()
            } else {
                c.members.join(",")
            }
        );
    }
    Ok(())
}

pub fn print_routines_from_config(
    agents: &[AgentConfig],
    channels: &[Channel],
    filter: Option<&str>,
) -> anyhow::Result<()> {
    let mut hosts: Vec<(String, Vec<crate::config::Routine>)> = agents
        .iter()
        .map(|a| (a.id.clone(), a.routines.clone()))
        .collect();
    hosts.extend(
        channels
            .iter()
            .map(|c| (format!("#{}", c.id), c.routines.clone())),
    );
    print_routine_rows(&hosts, filter)
}

#[cfg(test)]
mod tests {
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

    fn routine(name: &str) -> Routine {
        let mut r = Routine::new(name.into(), "0 9 * * *".into(), "brief".into()).unwrap();
        r.id = format!("id-{name}");
        r
    }

    fn hosts() -> Vec<(String, Vec<Routine>)> {
        vec![
            ("alpha".into(), vec![routine("daily")]),
            ("#room".into(), vec![routine("standup")]),
            ("beta".into(), Vec::new()),
        ]
    }

    #[test]
    fn rows_cover_bots_and_channels() {
        let rows = routine_rows(&hosts(), None).unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows[0].starts_with("alpha\tid-daily\tdaily\t0 9 * * *\ton\t-"));
        assert!(rows[1].starts_with("#room\tid-standup\tstandup"));
    }

    #[test]
    fn a_filter_picks_one_host_and_rejects_unknown_ones() {
        let rows = routine_rows(&hosts(), Some("#room")).unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].starts_with("#room\t"));
        // A host with no routines still resolves; it just prints nothing.
        assert!(routine_rows(&hosts(), Some("beta")).unwrap().is_empty());
        assert!(routine_rows(&hosts(), Some("room")).is_err());
        assert!(routine_rows(&hosts(), Some("nope")).is_err());
    }
}
