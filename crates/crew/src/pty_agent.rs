use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use anyhow::Context;
use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};

use crate::config::AgentConfig;
use crate::paths;
use crate::protocol::AgentStatus;

pub struct PtySession {
    pub id: String,
    pub name: String,
    pub cmd: Vec<String>,
    pub cwd: PathBuf,
    pub inner: Mutex<PtyInner>,
}

pub struct PtyInner {
    pub writer: Box<dyn Write + Send>,
    pub master: Box<dyn portable_pty::MasterPty + Send>,
    pub child: Box<dyn portable_pty::Child + Send + Sync>,
    pub parser: vt100::Parser,
    pub status: AgentStatus,
    pub last_output: Instant,
    pub seq: u64,
    pub cols: u16,
    pub rows: u16,
}

pub fn spawn(
    cfg: &AgentConfig,
    cols: u16,
    rows: u16,
    fresh_session: bool,
    roster: &[AgentConfig],
) -> anyhow::Result<Arc<PtySession>> {
    if cfg.cmd.is_empty() {
        anyhow::bail!("agent {} has empty cmd", cfg.id);
    }
    let cwd = crate::config::Config::default_cwd(cfg);
    paths::create_cwd(&cwd)?;

    let argv = cfg.spawn_cmd_with(fresh_session, roster);
    let program = paths::resolve_program(&argv[0]);
    let mut builder = CommandBuilder::new(program.as_os_str());
    for arg in argv.iter().skip(1) {
        builder.arg(arg);
    }
    builder.cwd(&cwd);
    builder.env("TERM", "xterm-256color");
    builder.env("COLORTERM", "truecolor");
    builder.env("PATH", paths::enriched_path());
    builder.env("CREW_AGENT_ID", &cfg.id);
    builder.env("CREW_HOME", paths::home_dir());

    let pty_system = NativePtySystem::default();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .with_context(|| format!("open pty for {}", cfg.id))?;
    let child = pair
        .slave
        .spawn_command(builder)
        .with_context(|| format!("spawn {} ({})", cfg.id, argv.join(" ")))?;
    drop(pair.slave);

    let reader = pair.master.try_clone_reader().context("clone pty reader")?;
    let writer = pair.master.take_writer().context("take pty writer")?;

    let session = Arc::new(PtySession {
        id: cfg.id.clone(),
        name: cfg.display_name().to_string(),
        cmd: cfg.cmd.clone(),
        cwd,
        inner: Mutex::new(PtyInner {
            writer,
            master: pair.master,
            child,
            parser: vt100::Parser::new(rows, cols, 2000),
            status: AgentStatus::Idle,
            last_output: Instant::now(),
            seq: 0,
            cols,
            rows,
        }),
    });

    let reader_session = session.clone();
    std::thread::Builder::new()
        .name(format!("crew-pty-{}", cfg.id))
        .spawn(move || read_loop(reader_session, reader))
        .context("spawn pty reader thread")?;

    Ok(session)
}

fn read_loop(session: Arc<PtySession>, mut reader: Box<dyn Read + Send>) {
    let mut buf = [0u8; 4096];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => {
                if let Ok(mut inner) = session.inner.lock() {
                    inner.status = AgentStatus::Exited;
                    inner.seq += 1;
                }
                crate::daemon::on_pty_exit(&session.id);
                crate::daemon::emit_frame(&session);
                break;
            }
            Ok(n) => {
                {
                    let mut inner = match session.inner.lock() {
                        Ok(g) => g,
                        Err(_) => break,
                    };
                    inner.parser.process(&buf[..n]);
                    inner.last_output = Instant::now();
                    inner.seq += 1;
                    if inner.status != AgentStatus::Exited {
                        inner.status = classify(&inner.parser, true);
                    }
                }
                crate::daemon::on_pty_output(&session.id, &buf[..n]);
                crate::daemon::emit_frame(&session);
            }
            Err(err) => {
                if err.kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                if let Ok(mut inner) = session.inner.lock() {
                    inner.status = AgentStatus::Exited;
                    inner.seq += 1;
                }
                crate::daemon::emit_frame(&session);
                break;
            }
        }
    }
}

pub fn classify(parser: &vt100::Parser, recently_wrote: bool) -> AgentStatus {
    if recently_wrote {
        let text = parser.screen().contents();
        if looks_blocked(&text) {
            return AgentStatus::Blocked;
        }
        return AgentStatus::Working;
    }
    let text = parser.screen().contents();
    if looks_blocked(&text) {
        AgentStatus::Blocked
    } else {
        AgentStatus::Idle
    }
}

fn looks_blocked(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    const PATTERNS: &[&str] = &[
        "(y/n)",
        "[y/n]",
        "y/n",
        "yes/no",
        "allow this",
        "permission",
        "waiting for",
        "press enter",
        "do you want",
        "approve",
        "confirm",
        "blocked",
        "인증",
        "허용",
        "승인",
    ];
    PATTERNS
        .iter()
        .any(|p| lower.contains(p) || text.contains(p))
}

pub fn screen_text(inner: &PtyInner) -> String {
    inner.parser.screen().contents()
}
