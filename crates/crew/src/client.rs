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

pub fn rpc(req: Request) -> anyhow::Result<Event> {
    let mut stream = connect()?;
    let line = req.to_line()?;
    writeln!(stream, "{line}")?;
    stream.flush()?;
    let mut reader = BufReader::new(stream);
    let mut buf = String::new();
    loop {
        buf.clear();
        let n = reader.read_line(&mut buf)?;
        if n == 0 {
            bail!("daemon closed the connection");
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

pub fn connect() -> anyhow::Result<UnixStream> {
    UnixStream::connect(paths::socket_path()).with_context(|| {
        format!(
            "cannot connect to daemon at {}",
            paths::socket_path().display()
        )
    })
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

pub fn ensure_daemon() -> anyhow::Result<()> {
    if paths::is_socket_live() {
        return Ok(());
    }
    if std::env::var("CREW_AGENT_ID")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .is_some()
    {
        bail!(
            "daemon is not running ({}); agent processes will not start one",
            paths::socket_path().display()
        );
    }
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
}

pub fn print_event(ev: Event) -> anyhow::Result<()> {
    match ev {
        Event::Agents { agents, .. } => {
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
                    a.status.ko_label(),
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
            println!("# {agent} ({})", status.ko_label());
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
        Event::Error { message } => bail!("{message}"),
        Event::Ok | Event::Pong | Event::Shutdown => println!("ok"),
        other => println!("{}", other.to_line()?),
    }
    Ok(())
}

pub fn print_routines(agents: &[AgentInfo], filter: Option<&str>) -> anyhow::Result<()> {
    if let Some(id) = filter {
        if !agents.iter().any(|a| a.id == id) {
            anyhow::bail!("unknown agent {id}");
        }
    }
    let mut any = false;
    for a in agents {
        if let Some(id) = filter {
            if a.id != id {
                continue;
            }
        }
        for r in &a.routines {
            any = true;
            println!(
                "{}\t{}\t{}\t{}\t{}\t{}",
                a.id,
                r.id,
                r.name,
                r.schedule,
                if r.enabled { "on" } else { "off" },
                r.last_run.as_deref().unwrap_or("-")
            );
        }
    }
    if !any {
        println!("(no routines)");
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
    filter: Option<&str>,
) -> anyhow::Result<()> {
    if let Some(id) = filter {
        if !agents.iter().any(|a| a.id == id) {
            anyhow::bail!("unknown agent {id}");
        }
    }
    let mut any = false;
    for a in agents {
        if let Some(id) = filter {
            if a.id != id {
                continue;
            }
        }
        for r in &a.routines {
            any = true;
            println!(
                "{}\t{}\t{}\t{}\t{}\t{}",
                a.id,
                r.id,
                r.name,
                r.schedule,
                if r.enabled { "on" } else { "off" },
                r.last_run.as_deref().unwrap_or("-")
            );
        }
    }
    if !any {
        println!("(no routines)");
    }
    Ok(())
}
