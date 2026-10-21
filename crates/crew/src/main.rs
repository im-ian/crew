use clap::{Args, Parser, Subcommand};

mod avatar;
mod choice;
mod client;
mod config;
mod cron;
mod daemon;
mod desktop;
mod groups;
mod headless;
mod interrupt;
mod memory;
mod models;
mod nl_routine;
mod notify;
mod paths;
mod protocol;
mod pty_agent;
mod routine_log;
mod rows;
mod search;
mod skills;
mod targeting;
mod tool_card;
mod transcript;
#[cfg(debug_assertions)]
mod ui_dev;

use config::{
    empty_to_none, parse_hex_color, resolve_add_cmd, write_roster, AgentCli, AgentConfig,
    AvatarShape, Config, Effort, Routine,
};
use protocol::{Event, Request};

#[derive(Parser)]
#[command(name = "crew", about = "Local multi-agent crew (desktop)", version)]
struct Cli {
    #[command(subcommand)]
    cmd: Option<Cmd>,
}

#[derive(Subcommand)]
enum Cmd {
    /// Run the background PTY / message-bus server
    Daemon,
    /// Stop the background daemon without touching agent config
    Stop,
    /// Open the desktop window
    App,
    /// Inject a line of text into an agent's PTY
    Send {
        agent: String,
        #[arg(trailing_var_arg = true, allow_hyphen_values = true, required = true)]
        message: Vec<String>,
    },
    /// Send a marked 1:1 envelope to an agent
    Tell {
        /// Recipient agent id
        to: String,
        /// Sender id. Defaults to $CREW_AGENT_ID, else `user`
        #[arg(long)]
        from: Option<String>,
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        message: Vec<String>,
    },
    /// Ask the human user to pick or type in this chat; print their answer
    Ask {
        #[arg(short, long)]
        question: Option<String>,
        #[arg(short, long = "option")]
        options: Vec<String>,
        #[arg(short = 'i', long = "input")]
        inputs: Vec<String>,
        #[arg(long)]
        hint: Option<String>,
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        rest: Vec<String>,
    },
    /// Print the current PTY screen for an agent
    Snapshot { agent: String },
    /// Print the chat transcript for an agent
    Messages { agent: String },
    /// Wipe conversation / PTY and spawn a fresh session for the same agent
    Reset {
        agent: String,
        /// Also clear the agent's routines list
        #[arg(long)]
        drop_routines: bool,
    },
    /// Manage agents
    #[command(subcommand)]
    Agent(AgentCmd),
    /// Scheduled routines for a bot
    #[command(subcommand)]
    Routine(RoutineCmd),
    /// Persistent per-agent notes (`$CREW_HOME/memory/AGENT.md`)
    #[command(subcommand)]
    Memory(MemoryCmd),
}

#[derive(Subcommand)]
enum AgentCmd {
    List,
    Add {
        id: String,
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        cwd: Option<String>,
        #[arg(long)]
        model: Option<String>,
        #[arg(long, value_enum)]
        effort: Option<Effort>,
        /// Fill default argv for grok / claude / codex. Ignored if --cmd is set.
        #[arg(long, value_enum)]
        cli: Option<AgentCli>,
        /// Command to spawn. Put this last so later flags (e.g. --always-approve) stay in cmd.
        #[arg(long, num_args = 1.., allow_hyphen_values = true)]
        cmd: Vec<String>,
    },
    Remove {
        id: String,
    },
    Clone {
        id: String,
        #[arg(long)]
        name: Option<String>,
    },
    Set {
        /// Agent id. Defaults to $CREW_AGENT_ID.
        #[arg(value_name = "ID")]
        id: Option<String>,
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        model: Option<String>,
        #[arg(long, value_enum)]
        effort: Option<Effort>,
        #[arg(long)]
        unset_model: bool,
        #[arg(long)]
        unset_effort: bool,
        #[arg(long)]
        title: Option<String>,
        #[arg(long)]
        description: Option<String>,
        #[arg(long)]
        role: Option<String>,
        #[arg(long)]
        unset_title: bool,
        #[arg(long)]
        unset_description: bool,
        #[arg(long)]
        unset_role: bool,
        #[arg(long, conflicts_with = "unset_avatar")]
        avatar: Option<String>,
        #[arg(long)]
        unset_avatar: bool,
        #[arg(long, value_enum)]
        shape: Option<AvatarShape>,
        #[arg(long)]
        color: Option<String>,
        #[arg(long)]
        cwd: Option<String>,
        #[arg(long)]
        unset_cwd: bool,
    },
}

#[derive(Subcommand)]
enum RoutineCmd {
    /// List routines. Defaults to $CREW_AGENT_ID, or every bot outside a session.
    List {
        agent: Option<String>,
    },
    /// Add a routine. --schedule is 5-field cron or a short Korean/English sentence.
    Add {
        /// Agent id. Defaults to $CREW_AGENT_ID.
        #[arg(value_name = "AGENT")]
        agent: Option<String>,
        #[arg(long)]
        name: String,
        #[arg(long)]
        schedule: String,
        #[arg(long)]
        prompt: String,
    },
    /// Change a routine's name, schedule, or prompt. Fields left out stay.
    Edit {
        #[command(flatten)]
        target: RoutineRef,
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        schedule: Option<String>,
        #[arg(long)]
        prompt: Option<String>,
    },
    /// Delete a routine.
    Remove(RoutineRef),
    /// Stop a routine from firing until it is resumed.
    Pause(RoutineRef),
    /// Let a paused routine fire again.
    Resume(RoutineRef),
    /// Fire immediately (test hook). Does not wait for cron.
    Run(RoutineRef),
}

// `KEY` alone is a routine of $CREW_AGENT_ID, so a bot can name its own
// routine without knowing its id. `AGENT KEY` still works from a terminal.
#[derive(Args)]
struct RoutineRef {
    /// Routine id or name, or the bot id when KEY follows
    #[arg(value_name = "AGENT|KEY")]
    first: String,
    /// Routine id or name
    #[arg(value_name = "KEY")]
    second: Option<String>,
}

impl RoutineRef {
    fn resolve(self, what: &str) -> anyhow::Result<(String, String)> {
        match self.second {
            Some(key) => Ok((self.first, key)),
            None => Ok((require_agent_id(None, what)?, self.first)),
        }
    }
}

#[derive(Subcommand)]
enum MemoryCmd {
    /// Print `$CREW_HOME/memory/AGENT.md`
    Show { agent: Option<String> },
    /// Replace memory. Text from args, or stdin if omitted.
    Set {
        #[arg(long, short)]
        agent: Option<String>,
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        text: Vec<String>,
    },
    /// Append a note. PTY sessions may omit --agent and use $CREW_AGENT_ID.
    Append {
        #[arg(long, short)]
        agent: Option<String>,
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        text: Vec<String>,
    },
}

fn main() {
    if let Err(err) = run() {
        eprintln!("crew: {err:#}");
        std::process::exit(1);
    }
}

fn run() -> anyhow::Result<()> {
    let cli = Cli::parse();
    match cli.cmd {
        None => desktop::run(),
        Some(Cmd::Daemon) => {
            let rt = tokio::runtime::Runtime::new()?;
            rt.block_on(daemon::run())
        }
        Some(Cmd::Stop) => client::stop_daemon(),
        Some(Cmd::App) => desktop::run(),
        Some(Cmd::Send { agent, message }) => {
            client::ensure_daemon()?;
            let text = message.join(" ");
            client::print_event(client::rpc(Request::Send { agent, text })?)
        }
        Some(Cmd::Tell { to, from, message }) => run_tell(to, from, message),
        Some(Cmd::Ask {
            question,
            options,
            inputs,
            hint,
            rest,
        }) => run_ask(question, options, inputs, hint, rest),
        Some(Cmd::Snapshot { agent }) => {
            client::ensure_daemon()?;
            client::print_event(client::rpc(Request::Snapshot { agent })?)
        }
        Some(Cmd::Messages { agent }) => {
            client::ensure_daemon()?;
            client::print_event(client::rpc(Request::Messages { agent })?)
        }
        Some(Cmd::Reset {
            agent,
            drop_routines,
        }) => {
            client::ensure_daemon()?;
            match client::rpc(Request::Reset {
                agent,
                drop_routines,
            })? {
                Event::Error { message } => anyhow::bail!("{message}"),
                ev => client::print_event(ev),
            }
        }
        Some(Cmd::Agent(AgentCmd::List)) => {
            if paths::is_socket_live() {
                client::print_event(client::rpc(Request::List)?)
            } else {
                let cfg = Config::load()?;
                if cfg.agents.is_empty() {
                    println!("(no agents)");
                }
                for a in cfg.agents {
                    println!(
                        "{}\t{}\toff\t{}\t{}\t{}\t{}",
                        a.id,
                        a.display_name(),
                        a.model.as_deref().unwrap_or("-"),
                        a.effort.map(|e| e.as_str()).unwrap_or("-"),
                        Config::default_cwd(&a).display(),
                        a.cmd.join(" ")
                    );
                }
                Ok(())
            }
        }
        Some(Cmd::Agent(AgentCmd::Add {
            id,
            name,
            cmd,
            cwd,
            model,
            effort,
            cli,
        })) => {
            let cmd = resolve_add_cmd(cli, cmd)?;
            let id = id.trim().to_string();
            // With no daemon this writes straight into agents.json, so the
            // daemon's guard never sees it. Refuse here too, before anything
            // is created on disk for an id that is not going to be accepted.
            if !config::valid_agent_id(&id) {
                anyhow::bail!("{}", config::id_rule(&id));
            }
            let name = name.unwrap_or_else(|| id.clone());
            let cwd = Some(
                cwd.filter(|s| !s.trim().is_empty())
                    .unwrap_or_else(|| config::default_add_cwd(&id)),
            );
            if let Some(ref cwd) = cwd {
                paths::create_cwd(&paths::expand_tilde(cwd))?;
            }
            if paths::is_socket_live() {
                match client::rpc(Request::AddAgent {
                    id,
                    name,
                    cmd,
                    cwd,
                    model,
                    effort,
                })? {
                    Event::Error { message } => anyhow::bail!("{message}"),
                    ev => client::print_event(ev),
                }
            } else {
                let mut cfg = Config::load()?;
                if cfg.agents.iter().any(|a| a.id == id) {
                    anyhow::bail!("agent {id} already exists");
                }
                let mut agent = AgentConfig::new(id, name, cmd, cwd);
                agent.model = model.filter(|m| !m.is_empty());
                agent.effort = effort;
                cfg.agents.push(agent);
                cfg.save()?;
                write_roster(&cfg.agents)?;
                Ok(())
            }
        }
        Some(Cmd::Agent(AgentCmd::Set {
            id,
            name,
            model,
            effort,
            unset_model,
            unset_effort,
            title,
            description,
            role,
            unset_title,
            unset_description,
            unset_role,
            avatar,
            unset_avatar,
            shape,
            color,
            cwd,
            unset_cwd,
        })) => {
            if name.is_none()
                && model.is_none()
                && effort.is_none()
                && title.is_none()
                && description.is_none()
                && role.is_none()
                && avatar.is_none()
                && shape.is_none()
                && color.is_none()
                && cwd.is_none()
                && !unset_model
                && !unset_effort
                && !unset_title
                && !unset_description
                && !unset_role
                && !unset_avatar
                && !unset_cwd
            {
                anyhow::bail!(
                    "nothing to set; pass --name, --model, --effort, --title, --description, --role, --avatar, --shape, --color, --cwd, or an --unset-* flag"
                );
            }
            let id = require_agent_id(id, "agent set")?;
            if paths::is_socket_live() {
                match client::rpc(Request::SetAgent {
                    id,
                    model,
                    effort,
                    unset_model,
                    unset_effort,
                    title,
                    description,
                    role,
                    unset_title,
                    unset_description,
                    unset_role,
                    avatar,
                    unset_avatar,
                    shape,
                    color,
                    name,
                    cwd,
                    unset_cwd,
                })? {
                    Event::Error { message } => anyhow::bail!("{message}"),
                    ev => client::print_event(ev),
                }
            } else {
                let mut cfg = Config::load()?;
                let agent = cfg
                    .agents
                    .iter_mut()
                    .find(|a| a.id == id)
                    .ok_or_else(|| anyhow::anyhow!("unknown agent {id}"))?;
                apply_agent_set(
                    agent,
                    model,
                    effort,
                    unset_model,
                    unset_effort,
                    title,
                    description,
                    role,
                    unset_title,
                    unset_description,
                    unset_role,
                    avatar,
                    unset_avatar,
                    shape,
                    color,
                    name,
                    cwd,
                    unset_cwd,
                )?;
                cfg.save()?;
                write_roster(&cfg.agents)?;
                Ok(())
            }
        }
        Some(Cmd::Agent(AgentCmd::Remove { id })) => {
            if paths::is_socket_live() {
                match client::rpc(Request::RemoveAgent { id })? {
                    Event::Error { message } => anyhow::bail!("{message}"),
                    ev => client::print_event(ev),
                }
            } else {
                let mut cfg = Config::load()?;
                let before = cfg.agents.len();
                cfg.agents.retain(|a| a.id != id);
                if cfg.agents.len() == before {
                    anyhow::bail!("unknown agent {id}");
                }
                crate::avatar::clear(&id);
                crate::memory::remove(&id);
                cfg.save()?;
                write_roster(&cfg.agents)?;
                Ok(())
            }
        }
        Some(Cmd::Agent(AgentCmd::Clone { id, name })) => {
            if paths::is_socket_live() {
                match client::rpc(Request::CloneAgent { id, name })? {
                    Event::Error { message } => anyhow::bail!("{message}"),
                    ev => client::print_event(ev),
                }
            } else {
                let mut cfg = Config::load()?;
                let src = cfg
                    .agents
                    .iter()
                    .find(|a| a.id == id)
                    .cloned()
                    .ok_or_else(|| anyhow::anyhow!("unknown agent {id}"))?;
                let ids: Vec<String> = cfg.agents.iter().map(|a| a.id.clone()).collect();
                let mut agent = src.duplicate(name.as_deref(), ids.iter().map(|s| s.as_str()));
                agent.avatar = crate::avatar::copy_for(src.avatar.as_deref(), &agent.id);
                crate::memory::copy(&id, &agent.id)?;
                let new_id = agent.id.clone();
                cfg.agents.push(agent);
                cfg.save()?;
                write_roster(&cfg.agents)?;
                println!("ok {new_id}");
                Ok(())
            }
        }
        Some(Cmd::Routine(sub)) => run_routine(sub),
        Some(Cmd::Memory(sub)) => run_memory(sub),
    }
}

fn run_memory(cmd: MemoryCmd) -> anyhow::Result<()> {
    match cmd {
        MemoryCmd::Show { agent } => {
            let id = memory_agent(agent, &mut Vec::new())?;
            print!("{}", crate::memory::read(&id));
            Ok(())
        }
        MemoryCmd::Set { agent, mut text } => {
            let id = memory_agent(agent, &mut text)?;
            let body = memory_body(text)?;
            crate::memory::write(&id, &body)?;
            Ok(())
        }
        MemoryCmd::Append { agent, mut text } => {
            let id = memory_agent(agent, &mut text)?;
            let body = memory_body(text)?;
            if body.trim().is_empty() {
                anyhow::bail!("memory append needs text");
            }
            crate::memory::append(&id, &body)?;
            Ok(())
        }
    }
}

fn session_agent_id() -> Option<String> {
    std::env::var("CREW_AGENT_ID")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn require_agent_id(explicit: Option<String>, what: &str) -> anyhow::Result<String> {
    explicit
        .and_then(empty_to_none)
        .or_else(session_agent_id)
        .ok_or_else(|| anyhow::anyhow!("{what} needs an agent id (or CREW_AGENT_ID)"))
}

fn memory_agent(flag: Option<String>, rest: &mut Vec<String>) -> anyhow::Result<String> {
    if let Some(id) = flag.and_then(empty_to_none) {
        return Ok(id);
    }
    if let Some(id) = session_agent_id() {
        return Ok(id);
    }
    if !rest.is_empty() {
        return Ok(rest.remove(0));
    }
    anyhow::bail!("memory needs an agent id (or CREW_AGENT_ID)")
}

fn memory_body(text: Vec<String>) -> anyhow::Result<String> {
    if !text.is_empty() {
        return Ok(text.join(" "));
    }
    use std::io::{self, IsTerminal, Read};
    if io::stdin().is_terminal() {
        anyhow::bail!("memory needs text (args or stdin)");
    }
    let mut buf = String::new();
    io::stdin().read_to_string(&mut buf)?;
    Ok(buf)
}

fn connect_for_tell() -> anyhow::Result<()> {
    // Agents already have a parent daemon; never spawn a second one.
    if std::env::var("CREW_AGENT_ID")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .is_some()
    {
        if !paths::is_socket_live() {
            anyhow::bail!("daemon is not running ({})", paths::socket_path().display());
        }
        Ok(())
    } else {
        client::ensure_daemon()
    }
}

fn run_ask(
    question: Option<String>,
    mut options: Vec<String>,
    inputs: Vec<String>,
    hint: Option<String>,
    rest: Vec<String>,
) -> anyhow::Result<()> {
    connect_for_tell()?;
    let agent = require_agent_id(None, "ask")?;
    let question = match question.and_then(empty_to_none) {
        Some(q) => {
            options.extend(rest);
            q
        }
        None => {
            let mut rest = rest;
            if rest.is_empty() {
                anyhow::bail!("ask needs a question");
            }
            let q = rest.remove(0);
            options.extend(rest);
            q
        }
    };
    client::print_event(client::rpc(Request::Ask {
        agent,
        question,
        options,
        inputs,
        hint: hint.and_then(empty_to_none),
    })?)
}

fn run_tell(to: String, from: Option<String>, message: Vec<String>) -> anyhow::Result<()> {
    connect_for_tell()?;
    let from = client::tell_from(from);
    let to = to.trim().to_string();
    if to.is_empty() {
        anyhow::bail!("tell needs a recipient");
    }
    let text = message.join(" ");
    if text.trim().is_empty() {
        anyhow::bail!("tell needs a message");
    }
    client::print_event(client::rpc(Request::Tell { from, to, text })?)
}


fn apply_agent_set(
    agent: &mut AgentConfig,
    model: Option<String>,
    effort: Option<Effort>,
    unset_model: bool,
    unset_effort: bool,
    title: Option<String>,
    description: Option<String>,
    role: Option<String>,
    unset_title: bool,
    unset_description: bool,
    unset_role: bool,
    avatar: Option<String>,
    unset_avatar: bool,
    shape: Option<AvatarShape>,
    color: Option<String>,
    name: Option<String>,
    cwd: Option<String>,
    unset_cwd: bool,
) -> anyhow::Result<()> {
    if unset_model {
        agent.model = None;
    } else if let Some(model) = model {
        agent.model = empty_to_none(model);
    }
    if unset_effort {
        agent.effort = None;
    } else if let Some(effort) = effort {
        agent.effort = Some(effort);
    }
    if unset_title {
        agent.title = None;
    } else if let Some(title) = title {
        agent.title = empty_to_none(title);
    }
    if unset_description {
        agent.description = None;
    } else if let Some(description) = description {
        agent.description = empty_to_none(description);
    }
    if unset_role {
        agent.role = None;
    } else if let Some(role) = role {
        agent.role = empty_to_none(role);
    }
    if let Some(shape) = shape {
        agent.avatar_shape = Some(shape);
    }
    if let Some(color) = color {
        agent.avatar_color = Some(parse_hex_color(&color)?);
    }
    if let Some(name) = name {
        let name = name.trim();
        if !name.is_empty() {
            agent.name = name.to_string();
        }
    }
    if unset_cwd {
        agent.cwd = None;
    } else if let Some(cwd) = cwd {
        agent.cwd = empty_to_none(cwd);
    }
    crate::avatar::apply(agent, avatar, unset_avatar)?;
    Ok(())
}

fn run_routine(cmd: RoutineCmd) -> anyhow::Result<()> {
    let agent = match cmd {
        RoutineCmd::List { agent } => {
            let agent = agent.and_then(empty_to_none).or_else(session_agent_id);
            return print_routine_list(agent.as_deref());
        }
        RoutineCmd::Add {
            agent,
            name,
            schedule,
            prompt,
        } => {
            let agent = require_agent_id(agent, "routine add")?;
            let (name, schedule, prompt) =
                crate::nl_routine::resolve_routine_fields(name, schedule, prompt)?;
            if paths::is_socket_live() {
                routine_rpc(Request::AddRoutine {
                    agent: agent.clone(),
                    name,
                    schedule,
                    prompt,
                })?;
            } else {
                add_offline_routine(&agent, name, schedule, prompt)?;
            }
            agent
        }
        RoutineCmd::Edit {
            target,
            name,
            schedule,
            prompt,
        } => {
            let (agent, key) = target.resolve("routine edit")?;
            if name.is_none() && schedule.is_none() && prompt.is_none() {
                anyhow::bail!("routine edit needs --name, --schedule, or --prompt");
            }
            if paths::is_socket_live() {
                routine_rpc(Request::EditRoutine {
                    agent: agent.clone(),
                    key,
                    name,
                    schedule,
                    prompt,
                })?;
            } else {
                mutate_offline_routine(&agent, &key, |routines, idx| {
                    routines[idx].edit(name, schedule, prompt)
                })?;
            }
            agent
        }
        RoutineCmd::Remove(target) => {
            let (agent, key) = target.resolve("routine remove")?;
            if paths::is_socket_live() {
                routine_rpc(Request::RemoveRoutine {
                    agent: agent.clone(),
                    key,
                })?;
            } else {
                mutate_offline_routine(&agent, &key, |routines, idx| {
                    routines.remove(idx);
                    Ok(())
                })?;
            }
            agent
        }
        RoutineCmd::Pause(target) => {
            let (agent, key) = target.resolve("routine pause")?;
            set_routine_enabled(&agent, key, false)?;
            agent
        }
        RoutineCmd::Resume(target) => {
            let (agent, key) = target.resolve("routine resume")?;
            set_routine_enabled(&agent, key, true)?;
            agent
        }
        RoutineCmd::Run(target) => {
            let (agent, key) = target.resolve("routine run")?;
            client::ensure_daemon()?;
            return match client::rpc(Request::RunRoutine { agent, key })? {
                Event::Error { message } => anyhow::bail!("{message}"),
                ev => client::print_event(ev),
            };
        }
    };
    // The caller is often a bot in chat. A bare "ok" let it report a schedule
    // it never saw; the saved row and its next run let a misread show.
    print_routine_list(Some(&agent))
}

// From agents.json, not the daemon's List: the daemon writes the file before
// it answers a change, and List leaves out a bot whose session never started,
// so a saved change on that bot read back as "unknown bot".
fn print_routine_list(agent: Option<&str>) -> anyhow::Result<()> {
    let cfg = Config::load()?;
    client::print_routines_from_config(&cfg.agents, agent)
}

fn routine_rpc(req: Request) -> anyhow::Result<()> {
    match client::rpc(req)? {
        Event::Error { message } => anyhow::bail!("{message}"),
        _ => Ok(()),
    }
}

fn set_routine_enabled(agent: &str, key: String, enabled: bool) -> anyhow::Result<()> {
    if paths::is_socket_live() {
        routine_rpc(Request::SetRoutineEnabled {
            agent: agent.to_string(),
            key,
            enabled,
            notify: false,
        })
    } else {
        mutate_offline_routine(agent, &key, |routines, idx| {
            routines[idx].enabled = enabled;
            Ok(())
        })
    }
}

fn add_offline_routine(
    target: &str,
    name: String,
    schedule: String,
    prompt: String,
) -> anyhow::Result<()> {
    let routine = Routine::new(name, schedule, prompt)?;
    let mut cfg = Config::load()?;
    let slot = cfg
        .agents
        .iter_mut()
        .find(|a| a.id == target)
        .ok_or_else(|| anyhow::anyhow!("unknown agent {target}"))?;
    slot.routines.push(routine);
    cfg.save()?;
    Ok(())
}

fn mutate_offline_routine(
    agent: &str,
    key: &str,
    f: impl FnOnce(&mut Vec<Routine>, usize) -> anyhow::Result<()>,
) -> anyhow::Result<()> {
    let mut cfg = Config::load()?;
    let slot = cfg
        .agents
        .iter_mut()
        .find(|a| a.id == agent)
        .ok_or_else(|| anyhow::anyhow!("unknown agent {agent}"))?;
    let idx = config::find_routine_index(&slot.routines, key)
        .ok_or_else(|| anyhow::anyhow!("unknown routine {key}"))?;
    f(&mut slot.routines, idx)?;
    cfg.save()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    fn parse_ok(args: &[&str]) -> Cli {
        Cli::try_parse_from(args).expect("parse")
    }

    #[test]
    fn ask_flags_and_trailing_args() {
        match parse_ok(&[
            "crew",
            "ask",
            "--question",
            "어느 쪽을 고를래?",
            "--option",
            "A",
            "--option",
            "B",
            "--option",
            "C",
        ])
        .cmd
        {
            Some(Cmd::Ask {
                question,
                options,
                inputs,
                hint,
                rest,
            }) => {
                assert_eq!(question.as_deref(), Some("어느 쪽을 고를래?"));
                assert_eq!(options, vec!["A", "B", "C"]);
                assert!(inputs.is_empty());
                assert!(hint.is_none());
                assert!(rest.is_empty());
            }
            _ => panic!("expected ask"),
        }
        match parse_ok(&["crew", "ask", "어느 쪽을 고를래?", "A", "B", "C"]).cmd {
            Some(Cmd::Ask {
                question,
                options,
                rest,
                ..
            }) => {
                assert!(question.is_none());
                assert!(options.is_empty());
                assert_eq!(rest, vec!["어느 쪽을 고를래?", "A", "B", "C"]);
            }
            _ => panic!("expected ask"),
        }
        match parse_ok(&[
            "crew",
            "ask",
            "--question",
            "로그인",
            "--hint",
            "이 계정으로 로그인해주세요.",
            "--input",
            "아이디",
            "--input",
            "비밀번호",
        ])
        .cmd
        {
            Some(Cmd::Ask {
                question,
                options,
                inputs,
                hint,
                rest,
            }) => {
                assert_eq!(question.as_deref(), Some("로그인"));
                assert!(options.is_empty());
                assert_eq!(inputs, vec!["아이디", "비밀번호"]);
                assert_eq!(hint.as_deref(), Some("이 계정으로 로그인해주세요."));
                assert!(rest.is_empty());
            }
            _ => panic!("expected ask"),
        }
    }

    #[test]
    fn agent_set_accepts_name() {
        match parse_ok(&["crew", "agent", "set", "grok", "--name", "그록봇 테스터"]).cmd {
            Some(Cmd::Agent(AgentCmd::Set { id, name, .. })) => {
                assert_eq!(id.as_deref(), Some("grok"));
                assert_eq!(name.as_deref(), Some("그록봇 테스터"));
            }
            _ => panic!("expected agent set"),
        }
    }

    #[test]
    fn agent_set_name_can_omit_id() {
        match parse_ok(&["crew", "agent", "set", "--name", "그록봇 테스터"]).cmd {
            Some(Cmd::Agent(AgentCmd::Set { id, name, .. })) => {
                assert!(id.is_none());
                assert_eq!(name.as_deref(), Some("그록봇 테스터"));
            }
            _ => panic!("expected agent set"),
        }
    }

    #[test]
    fn routine_add_can_omit_agent() {
        match parse_ok(&[
            "crew",
            "routine",
            "add",
            "--name",
            "아침",
            "--schedule",
            "평일 8시에 브리핑",
            "--prompt",
            "오늘 할 일",
        ])
        .cmd
        {
            Some(Cmd::Routine(RoutineCmd::Add {
                agent,
                name,
                schedule,
                prompt,
            })) => {
                assert!(agent.is_none());
                assert_eq!(name, "아침");
                assert_eq!(schedule, "평일 8시에 브리핑");
                assert_eq!(prompt, "오늘 할 일");
            }
            _ => panic!("expected routine add"),
        }
    }

    #[test]
    fn apply_agent_set_renames() {
        let mut agent = AgentConfig::new("grok".into(), "Grok".into(), vec!["grok".into()], None);
        apply_agent_set(
            &mut agent,
            None,
            None,
            false,
            false,
            None,
            None,
            None,
            false,
            false,
            false,
            None,
            false,
            None,
            None,
            Some("그록봇 테스터".into()),
            None,
            false,
        )
        .unwrap();
        assert_eq!(agent.display_name(), "그록봇 테스터");
    }

    #[test]
    fn require_agent_id_prefers_explicit() {
        assert_eq!(
            require_agent_id(Some("grok".into()), "agent set").unwrap(),
            "grok"
        );
    }

    #[test]
    fn routine_ref_takes_a_bot_and_key_or_just_a_key() {
        match parse_ok(&["crew", "routine", "remove", "grok", "아침"]).cmd {
            Some(Cmd::Routine(RoutineCmd::Remove(target))) => {
                assert_eq!(
                    target.resolve("routine remove").unwrap(),
                    ("grok".into(), "아침".into())
                );
            }
            _ => panic!("expected routine remove"),
        }
        match parse_ok(&["crew", "routine", "edit", "아침", "--schedule", "0 9 * * 1-5"]).cmd {
            Some(Cmd::Routine(RoutineCmd::Edit {
                target,
                name,
                schedule,
                prompt,
            })) => {
                assert_eq!(target.first, "아침");
                assert!(target.second.is_none());
                assert!(name.is_none() && prompt.is_none());
                assert_eq!(schedule.as_deref(), Some("0 9 * * 1-5"));
            }
            _ => panic!("expected routine edit"),
        }
    }

    #[test]
    fn routine_edit_keeps_fields_left_out() {
        let mut r = Routine::new("아침".into(), "0 8 * * *".into(), "브리핑".into()).unwrap();
        r.edit(None, Some("0 9 * * 1-5".into()), Some("  ".into()))
            .unwrap();
        assert_eq!(r.name, "아침");
        assert_eq!(r.schedule, "0 9 * * 1-5");
        assert_eq!(r.prompt, "브리핑");
        assert!(r.edit(None, Some("61 * * * *".into()), None).is_err());
    }
}
