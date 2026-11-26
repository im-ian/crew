//! Tauri commands for the desktop window.
//!
//! A command declared `#[tauri::command]` runs on the main thread, so anything
//! that waits — a daemon round-trip, a daemon start, a child process — freezes
//! the window for as long as it takes. Those are declared
//! `#[tauri::command(async)]` instead, which hands them to a worker. See the
//! test at the bottom of this file, which holds the rule.

use std::sync::Mutex;

use tauri::Manager;

use crate::client;
use crate::config::{
    empty_to_none, resolve_add_cmd, unique_agent_id, AgentCli, AvatarShape, Effort,
};
use crate::groups::SidebarGroup;
use crate::protocol::{AgentInfo, ChatMessage, CloneParts, Event, Request};

fn parse_effort(effort: Option<String>) -> Result<Option<Effort>, String> {
    match effort.as_deref() {
        None | Some("") => Ok(None),
        Some("low") => Ok(Some(Effort::Low)),
        Some("medium") => Ok(Some(Effort::Medium)),
        Some("high") => Ok(Some(Effort::High)),
        Some(other) => Err(format!("effort must be low, medium, or high (got {other})")),
    }
}

fn parse_shape(shape: Option<String>) -> Result<Option<AvatarShape>, String> {
    match shape.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(s) => AvatarShape::from_key(s)
            .map(Some)
            .map_err(|e| e.to_string()),
    }
}

// Off the main thread: `grok models` is a subprocess, and the picker asks
// for every CLI each time it opens.
#[tauri::command(async)]
pub(crate) fn list_models(cli: String) -> Result<crate::models::ModelList, String> {
    if cli.trim().eq_ignore_ascii_case("custom") {
        return Ok(crate::models::ModelList {
            installed: true,
            ..crate::models::ModelList::default()
        });
    }
    let cli = AgentCli::from_key(&cli).map_err(|e| e.to_string())?;
    crate::models::list_models(cli).map_err(|e| e.to_string())
}

/// The default AI and the ones a turn falls back to, in order. None until
/// the window first saves it, so the old single default can move in.
#[tauri::command]
pub(crate) fn get_fallback_ais() -> Option<Vec<crate::fallback::Candidate>> {
    crate::fallback::load()
}

/// Crew's templates, then the user's, in the app's language.
#[tauri::command]
pub(crate) fn list_templates() -> Vec<crate::templates::Template> {
    crate::templates::list(crate::paths::locale() == "en")
}

/// Returns it as saved, with its id when it is new.
#[tauri::command]
pub(crate) fn save_template(
    template: crate::templates::Template,
) -> Result<crate::templates::Template, String> {
    crate::templates::save(template).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn remove_template(id: String) -> Result<(), String> {
    crate::templates::remove(id.trim()).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn set_fallback_ais(list: Vec<crate::fallback::Candidate>) -> Result<(), String> {
    crate::fallback::save(&list).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub(crate) fn list_agents() -> Result<Vec<AgentInfo>, String> {
    client::ensure_daemon().map_err(|e| e.to_string())?;
    match client::rpc(Request::List) {
        Ok(Event::Agents { mut agents, .. }) => {
            for a in &mut agents {
                a.avatar = crate::avatar::data_url_for(a.avatar.as_deref());
            }
            Ok(agents)
        }
        Ok(Event::Error { message }) => Err(message),
        Ok(_) => Err("unexpected daemon response".into()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command(async)]
pub(crate) fn send_message(
    agent: String,
    text: String,
    steer: bool,
    id: Option<String>,
) -> Result<(), String> {
    match client::rpc(Request::Send {
        agent,
        text,
        steer,
        id,
    }) {
        Ok(Event::Ok) => Ok(()),
        Ok(Event::Error { message }) => Err(message),
        Ok(_) => Err("unexpected daemon response".into()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command(async)]
pub(crate) fn stop_agent(agent: String) -> Result<(), String> {
    match client::rpc(Request::Interrupt { agent }) {
        Ok(Event::Ok) => Ok(()),
        Ok(Event::Error { message }) => Err(message),
        Ok(_) => Err("unexpected daemon response".into()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command(async)]
pub(crate) fn cancel_queued(agent: String, message_id: String) -> Result<(), String> {
    match client::rpc(Request::CancelQueued { agent, message_id }) {
        Ok(Event::Ok) => Ok(()),
        Ok(Event::Error { message }) => Err(message),
        Ok(_) => Err("unexpected daemon response".into()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command(async)]
pub(crate) fn send_queued(agent: String, message_id: String) -> Result<(), String> {
    match client::rpc(Request::SendQueued { agent, message_id }) {
        Ok(Event::Ok) => Ok(()),
        Ok(Event::Error { message }) => Err(message),
        Ok(_) => Err("unexpected daemon response".into()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command(async)]
pub(crate) fn edit_queued(agent: String, message_id: String, text: String) -> Result<(), String> {
    match client::rpc(Request::EditQueued {
        agent,
        message_id,
        text,
    }) {
        Ok(Event::Ok) => Ok(()),
        Ok(Event::Error { message }) => Err(message),
        Ok(_) => Err("unexpected daemon response".into()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command(async)]
pub(crate) fn approve_agent(agent: String, allow: bool, always: bool) -> Result<(), String> {
    match client::rpc(Request::Approve {
        agent,
        allow,
        always,
    }) {
        Ok(Event::Ok) => Ok(()),
        Ok(Event::Error { message }) => Err(message),
        Ok(_) => Err("unexpected daemon response".into()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command(async)]
pub(crate) fn answer_choice(
    agent: String,
    message_id: String,
    answers: Vec<Vec<String>>,
    closed: bool,
    values: Option<Vec<Vec<String>>>,
    others: Option<Vec<String>>,
) -> Result<(), String> {
    match client::rpc(Request::AnswerChoice {
        agent,
        message_id,
        answers,
        values: values.unwrap_or_default(),
        others: others.unwrap_or_default(),
        closed,
    }) {
        Ok(Event::Ok) => Ok(()),
        Ok(Event::Error { message }) => Err(message),
        Ok(_) => Err("unexpected daemon response".into()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command(async)]
pub(crate) fn tell_message(from: Option<String>, to: String, text: String) -> Result<(), String> {
    let from = client::tell_from(from);
    match client::rpc(Request::Tell {
        from,
        to,
        text,
        now: false,
        fyi: false,
    }) {
        Ok(Event::Told { .. }) | Ok(Event::Ok) => Ok(()),
        Ok(Event::Error { message }) => Err(message),
        Ok(_) => Err("unexpected daemon response".into()),
        Err(err) => Err(err.to_string()),
    }
}

#[derive(Clone, serde::Serialize)]
pub(crate) struct SnapshotView {
    agent: String,
    text: String,
    status: crate::protocol::AgentStatus,
}

#[tauri::command(async)]
pub(crate) fn get_snapshot(agent: String) -> Result<SnapshotView, String> {
    match client::rpc(Request::Snapshot { agent }) {
        Ok(Event::Snapshot {
            agent,
            text,
            status,
            ..
        }) => Ok(SnapshotView {
            agent,
            text,
            status,
        }),
        Ok(Event::Error { message }) => Err(message),
        Ok(_) => Err("unexpected daemon response".into()),
        Err(err) => Err(err.to_string()),
    }
}

/// How much of each named CLI's plan is used. Reads files, so off the main thread.
#[tauri::command(async)]
pub(crate) fn plan_usage(clis: Vec<String>) -> Vec<crate::usage::PlanUsage> {
    crate::usage::snapshot(&clis)
}

#[tauri::command]
pub(crate) fn list_groups() -> Result<Vec<SidebarGroup>, String> {
    crate::groups::load().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn set_groups(groups: Vec<SidebarGroup>) -> Result<(), String> {
    crate::groups::save(&groups).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn get_group_memory(group: String) -> Result<String, String> {
    let group = group.trim();
    if group.is_empty() {
        return Err("group is required".into());
    }
    Ok(crate::memory::read_group(group))
}

/// `base` is the notes the dialog loaded. False means a bot changed them since
/// and nothing was written.
#[tauri::command]
pub(crate) fn set_group_memory(group: String, text: String, base: String) -> Result<bool, String> {
    let group = group.trim();
    if group.is_empty() {
        return Err("group is required".into());
    }
    crate::memory::write_group_if_unchanged(group, &base, &text).map_err(|e| e.to_string())
}

/// Only an explicit delete drops the notes. A layout saved without a group,
/// say before the window loaded the file, must not take them along.
#[tauri::command]
pub(crate) fn remove_group_memory(group: String) -> Result<(), String> {
    let group = group.trim();
    if group.is_empty() {
        return Err("group is required".into());
    }
    crate::memory::remove_group(group);
    Ok(())
}

/// The end of a chat, not all of it: a long one sent whole on every switch
/// and every poll held the window up. See `transcript::page_start`.
#[tauri::command(async)]
pub(crate) fn get_messages_page(
    agent: String,
    start: Option<usize>,
    end: Option<usize>,
    tail: usize,
    need: Option<String>,
    since_ts: Option<u64>,
) -> Result<MessagesPage, String> {
    match client::rpc(Request::MessagesPage {
        agent,
        start,
        end,
        tail,
        need,
        since_ts,
    }) {
        Ok(Event::MessagesPage {
            messages,
            start,
            total,
            ..
        }) => Ok(MessagesPage {
            messages,
            start,
            total,
        }),
        Ok(Event::Error { message }) => Err(message),
        Ok(_) => Err("unexpected daemon response".into()),
        Err(err) => Err(err.to_string()),
    }
}

/// The end of a chat for the window: rows from `start` of `total`.
#[derive(Debug, Clone, serde::Serialize)]
pub(crate) struct MessagesPage {
    messages: Vec<ChatMessage>,
    start: usize,
    total: usize,
}

#[tauri::command(async)]
pub(crate) fn get_messages(agent: String) -> Result<Vec<ChatMessage>, String> {
    match client::rpc(Request::Messages { agent }) {
        Ok(Event::Messages { messages, .. }) => Ok(messages),
        Ok(Event::Error { message }) => Err(message),
        Ok(_) => Err("unexpected daemon response".into()),
        Err(err) => Err(err.to_string()),
    }
}

/// Why the daemon could not be started, if it could not. A window with no
/// daemon can only say `cannot connect to <socket>`, which describes the hole
/// rather than what made it. Poisoning must not lose it — that would leave
/// exactly the bare message this exists to replace.
static START_ERROR: Mutex<Option<String>> = Mutex::new(None);

fn set_start_error(err: Option<String>) {
    *START_ERROR.lock().unwrap_or_else(|e| e.into_inner()) = err;
}

fn start_error() -> Option<String> {
    START_ERROR
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

/// What the window says when the socket will not answer. The recorded reason
/// wins while it is still the reason — see `daemon_ping`, which drops it as
/// soon as a daemon answers, so a later disconnect does not blame a file the
/// user has already fixed.
fn ping_failure(err: String) -> String {
    start_error().unwrap_or(err)
}

// Async so a daemon start stays off the UI thread. The ping is what the window
// polls, and it is the call that brings a dead daemon back. `get_messages`
// polls faster and must keep failing without spawning.
#[tauri::command(async)]
pub(crate) fn daemon_ping() -> Result<(), String> {
    match client::rpc_connected(Request::Ping) {
        Ok(Event::Pong) => {
            set_start_error(None);
            Ok(())
        }
        Ok(Event::Error { message }) => Err(message),
        Ok(_) => Err("unexpected daemon response".into()),
        Err(err) => Err(ping_failure(err.to_string())),
    }
}

#[tauri::command(async)]
pub(crate) fn reset_agent(agent: String, drop_routines: bool) -> Result<String, String> {
    match client::rpc(Request::Reset {
        agent,
        drop_routines,
    }) {
        Ok(Event::Reset { archive, .. }) => Ok(archive),
        Ok(Event::Ok) => Ok(String::new()),
        Ok(Event::Error { message }) => Err(message),
        Ok(_) => Err("unexpected daemon response".into()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command(async)]
pub(crate) fn set_agent(
    id: String,
    model: Option<String>,
    effort: Option<String>,
    unset_model: bool,
    unset_effort: bool,
    title: Option<String>,
    description: Option<String>,
    role: Option<String>,
    unset_title: bool,
    unset_description: bool,
    unset_role: bool,
    shape: Option<String>,
    color: Option<String>,
    name: Option<String>,
    cwd: Option<String>,
    unset_cwd: bool,
) -> Result<(), String> {
    let effort = parse_effort(effort)?;
    let shape = parse_shape(shape)?;
    let color = color.and_then(empty_to_none);
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
        avatar: None,
        unset_avatar: false,
        shape,
        color,
        name,
        cwd: cwd.and_then(empty_to_none),
        unset_cwd,
    }) {
        Ok(Event::Ok) | Ok(Event::Agents { .. }) => Ok(()),
        Ok(Event::Error { message }) => Err(message),
        Ok(_) => Err("unexpected daemon response".into()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command(async)]
pub(crate) fn set_agent_cli(id: String, cli: String, cmd: Option<String>) -> Result<(), String> {
    let cmd = match cmd.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(raw) => crate::config::split_cmd(raw).map_err(|e| e.to_string())?,
        None => Vec::new(),
    };
    match client::rpc(Request::SetCli { id, cli, cmd }) {
        Ok(Event::Ok) | Ok(Event::Agents { .. }) => Ok(()),
        Ok(Event::Error { message }) => Err(message),
        Ok(_) => Err("unexpected daemon response".into()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub(crate) fn add_agent(
    name: String,
    cli: String,
    model: Option<String>,
    effort: Option<String>,
    role: Option<String>,
    description: Option<String>,
    cmd: Option<String>,
    cwd: Option<String>,
    quiet: Option<bool>,
    id: Option<String>,
    shape: Option<String>,
    color: Option<String>,
) -> Result<String, String> {
    client::ensure_daemon().map_err(|e| e.to_string())?;
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("name is required".into());
    }
    let (cmd, headless) = if cli.trim().eq_ignore_ascii_case("custom") {
        let argv =
            crate::config::split_cmd(cmd.as_deref().unwrap_or("")).map_err(|e| e.to_string())?;
        let headless = crate::config::headless_cmd(true, &argv);
        (argv, headless)
    } else {
        let cli = AgentCli::from_key(&cli).map_err(|e| e.to_string())?;
        let argv = resolve_add_cmd(Some(cli), Vec::new()).map_err(|e| e.to_string())?;
        (argv, false)
    };
    let effort = parse_effort(effort)?;
    let model = model.and_then(empty_to_none);
    let role = role.and_then(empty_to_none);
    let description = description.and_then(empty_to_none);
    let avatar_shape = parse_shape(shape)?;
    // An id from `reserve_agent_ids`: the window put it in its group first,
    // so the bot is in that group from the moment it exists.
    let id = match id.and_then(empty_to_none) {
        Some(id) => id,
        None => {
            let existing = list_agents()?;
            unique_agent_id(&name, existing.iter().map(|a| a.id.as_str()))
        }
    };
    match client::rpc(Request::AddAgent {
        id: id.clone(),
        name,
        cmd,
        cwd: cwd.and_then(empty_to_none),
        model,
        effort,
        headless,
        quiet: quiet.unwrap_or(false),
        role,
        description,
        avatar_shape,
        avatar_color: color.and_then(empty_to_none),
    }) {
        Ok(Event::Ok) | Ok(Event::Agents { .. }) => {}
        Ok(Event::Error { message }) => return Err(message),
        Ok(_) => return Err("unexpected daemon response".into()),
        Err(err) => return Err(err.to_string()),
    }
    Ok(id)
}

/// Ids for bots about to be made, one per name, unused by any bot now and by
/// each other. The window puts them in a new group before it makes the bots.
#[tauri::command(async)]
pub(crate) fn reserve_agent_ids(names: Vec<String>) -> Result<Vec<String>, String> {
    client::ensure_daemon().map_err(|e| e.to_string())?;
    let mut taken: Vec<String> = list_agents()?.into_iter().map(|a| a.id).collect();
    Ok(reserve_ids(&names, &mut taken))
}

fn reserve_ids(names: &[String], taken: &mut Vec<String>) -> Vec<String> {
    names
        .iter()
        .map(|name| {
            let id = unique_agent_id(name.trim(), taken.iter().map(String::as_str));
            taken.push(id.clone());
            id
        })
        .collect()
}

#[tauri::command(async)]
pub(crate) fn clone_agent(
    id: String,
    name: Option<String>,
    parts: Option<CloneParts>,
) -> Result<String, String> {
    client::ensure_daemon().map_err(|e| e.to_string())?;
    let id = id.trim().to_string();
    if id.is_empty() {
        return Err("id is required".into());
    }
    let name = name.and_then(empty_to_none);
    let parts = parts.unwrap_or_default();
    match client::rpc(Request::CloneAgent { id, name, parts }) {
        Ok(Event::Cloned { id }) => Ok(id),
        Ok(Event::Ok) => Err("clone succeeded without a new id".into()),
        Ok(Event::Error { message }) => Err(message),
        Ok(_) => Err("unexpected daemon response".into()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command(async)]
pub(crate) fn remove_agent(id: String) -> Result<(), String> {
    client::ensure_daemon().map_err(|e| e.to_string())?;
    match client::rpc(Request::RemoveAgent { id }) {
        Ok(Event::Ok) | Ok(Event::Agents { .. }) => Ok(()),
        Ok(Event::Error { message }) => Err(message),
        Ok(_) => Err("unexpected daemon response".into()),
        Err(err) => Err(err.to_string()),
    }
}

fn group_archive_rpc(
    action: &str,
    id: String,
    stop: bool,
    slot: Option<usize>,
) -> Result<serde_json::Value, String> {
    client::ensure_daemon().map_err(|e| e.to_string())?;
    match client::rpc(Request::GroupArchive {
        action: action.to_string(),
        id,
        stop,
        slot,
    }) {
        Ok(Event::GroupArchive { info }) => Ok(info),
        Ok(Event::Error { message }) => Err(message),
        Ok(_) => Err("unexpected daemon response".into()),
        Err(err) => Err(err.to_string()),
    }
}

/// Put a group away with its bots: off the sidebar, its bots off the daemon,
/// everything they were kept. A group with bots at work needs `stop`, the
/// user's yes to stopping them. `slot` is where the window had the group.
#[tauri::command(async)]
pub(crate) fn archive_group(
    id: String,
    stop: bool,
    slot: Option<usize>,
) -> Result<serde_json::Value, String> {
    group_archive_rpc("archive", id, stop, slot)
}

/// The archived groups, newest first, each with its bots' faces.
#[tauri::command(async)]
pub(crate) fn list_archived_groups() -> Vec<crate::group_archive::ArchivedInfo> {
    crate::group_archive::infos()
}

/// Bring an archived group back, its bots with their routines as they were.
#[tauri::command(async)]
pub(crate) fn restore_group(id: String) -> Result<serde_json::Value, String> {
    group_archive_rpc("restore", id, false, None)
}

/// Delete an archived group for good, its bots and their chats with it.
#[tauri::command(async)]
pub(crate) fn delete_archived_group(id: String) -> Result<serde_json::Value, String> {
    group_archive_rpc("delete", id, false, None)
}

fn rpc_set_avatar(id: String, avatar: Option<String>, unset_avatar: bool) -> Result<(), String> {
    match client::rpc(Request::SetAgent {
        id,
        model: None,
        effort: None,
        unset_model: false,
        unset_effort: false,
        title: None,
        description: None,
        role: None,
        unset_title: false,
        unset_description: false,
        unset_role: false,
        avatar,
        unset_avatar,
        shape: None,
        color: None,
        name: None,
        cwd: None,
        unset_cwd: false,
    }) {
        Ok(Event::Ok) | Ok(Event::Agents { .. }) => Ok(()),
        Ok(Event::Error { message }) => Err(message),
        Ok(_) => Err("unexpected daemon response".into()),
        Err(err) => Err(err.to_string()),
    }
}

fn remote_rpc(req: Request) -> Result<Event, String> {
    client::ensure_daemon().map_err(|e| e.to_string())?;
    match client::rpc(req) {
        Ok(Event::Error { message }) => Err(message),
        Ok(ev) => Ok(ev),
        Err(err) => Err(err.to_string()),
    }
}

/// The health check of 원격 봇 추가. See `docs/router.md`.
#[tauri::command(async)]
pub(crate) fn remote_probe(url: String) -> Result<crate::remote::RemoteServer, String> {
    match remote_rpc(Request::RemoteProbe { url })? {
        Event::RemoteServer { server } => Ok(server),
        _ => Err("unexpected daemon response".into()),
    }
}

/// Make the local representative, then sign it up. A refused signup takes the
/// bot back, so a taken name leaves nothing behind.
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub(crate) fn remote_join(
    url: String,
    alias: String,
    name: String,
    invite: Option<String>,
    cli: String,
    avatar: Option<String>,
    avatar_shape: Option<String>,
    avatar_color: Option<String>,
    role: Option<String>,
) -> Result<String, String> {
    let alias = alias.trim().to_lowercase();
    if !crate::remote::valid_alias(&alias) {
        return Err(if crate::paths::locale() == "en" {
            "An alias is up to 32 lowercase letters, digits, - or _".into()
        } else {
            "별칭은 32자 이하의 영문 소문자·숫자·-·_만 쓸 수 있어요".into()
        });
    }
    let cwd = crate::remote::work_dir(&alias);
    crate::paths::create_cwd(&cwd).map_err(|e| e.to_string())?;
    // A custom command comes next, from `set_agent_cli`: start on the default.
    let cli = if cli.trim().eq_ignore_ascii_case("custom") {
        "grok".to_string()
    } else {
        cli
    };
    let id = add_agent(
        name.clone(),
        cli,
        None,
        None,
        role,
        None,
        None,
        Some(cwd.display().to_string()),
        None,
        None,
        None,
        None,
    )?;
    let joined = (|| {
        if avatar_shape.is_some() || avatar_color.is_some() {
            set_agent(
                id.clone(),
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
                avatar_shape,
                avatar_color,
                None,
                None,
                false,
            )?;
        }
        if let Some(data) = avatar.and_then(empty_to_none) {
            set_avatar(id.clone(), data, None)?;
        }
        match remote_rpc(Request::RemoteJoin {
            url,
            alias,
            name: name.trim().to_string(),
            invite: invite.and_then(empty_to_none),
            bot: id.clone(),
        })? {
            Event::Ok => Ok(()),
            _ => Err("unexpected daemon response".to_string()),
        }
    })();
    match joined {
        Ok(()) => Ok(id),
        Err(err) => {
            let _ = remove_agent(id);
            Err(err)
        }
    }
}

#[tauri::command(async)]
pub(crate) fn remote_list() -> Result<Vec<crate::remote::RemoteInfo>, String> {
    match remote_rpc(Request::RemoteList)? {
        Event::Remotes { mut remotes } => {
            for r in &mut remotes {
                for m in &mut r.members {
                    m.avatar = m.avatar.take().filter(|a| a.starts_with("data:"));
                }
            }
            Ok(remotes)
        }
        _ => Err("unexpected daemon response".into()),
    }
}

#[tauri::command(async)]
pub(crate) fn remote_set(
    alias: String,
    trusted: Option<Vec<String>>,
    blocked: Option<Vec<String>>,
) -> Result<(), String> {
    remote_rpc(Request::RemoteSet {
        alias,
        trusted,
        blocked,
    })
    .map(|_| ())
}

#[tauri::command(async)]
pub(crate) fn remote_leave(alias: String) -> Result<(), String> {
    remote_rpc(Request::RemoteLeave { alias }).map(|_| ())
}

#[derive(serde::Serialize)]
pub(crate) struct TeamMemory {
    text: String,
    version: u64,
}

#[tauri::command(async)]
pub(crate) fn team_memory_get(alias: String) -> Result<TeamMemory, String> {
    match remote_rpc(Request::TeamMemory {
        alias: Some(alias),
        bot: None,
    })? {
        Event::TeamMemory { text, version, .. } => Ok(TeamMemory { text, version }),
        _ => Err("unexpected daemon response".into()),
    }
}

/// `false`: someone changed the notes first, and nothing was written.
#[tauri::command(async)]
pub(crate) fn team_memory_set(alias: String, text: String, version: u64) -> Result<bool, String> {
    match remote_rpc(Request::TeamMemorySet {
        alias: Some(alias),
        bot: None,
        text,
        version: Some(version),
    })? {
        Event::Ok => Ok(true),
        Event::TeamMemoryConflict => Ok(false),
        _ => Err("unexpected daemon response".into()),
    }
}

#[tauri::command(async)]
pub(crate) fn set_avatar(id: String, data: String, name: Option<String>) -> Result<(), String> {
    client::ensure_daemon().map_err(|e| e.to_string())?;
    let id = id.trim().to_string();
    if id.is_empty() {
        return Err("id is required".into());
    }
    let bytes = crate::avatar::decode_input(&data).map_err(|e| e.to_string())?;
    let dest = crate::avatar::install_from_bytes(&id, &bytes, name.as_deref())
        .map_err(|e| e.to_string())?;
    rpc_set_avatar(id, Some(dest.to_string_lossy().into_owned()), false)
}

#[tauri::command(async)]
pub(crate) fn clear_avatar(id: String) -> Result<(), String> {
    client::ensure_daemon().map_err(|e| e.to_string())?;
    let id = id.trim().to_string();
    if id.is_empty() {
        return Err("id is required".into());
    }
    rpc_set_avatar(id, None, true)
}

#[tauri::command(async)]
pub(crate) fn add_routine(
    agent: String,
    name: String,
    schedule: String,
    prompt: String,
) -> Result<(), String> {
    match client::rpc(Request::AddRoutine {
        agent,
        name,
        schedule,
        prompt,
    }) {
        Ok(Event::Ok) | Ok(Event::Agents { .. }) => Ok(()),
        Ok(Event::Error { message }) => Err(message),
        Ok(_) => Err("unexpected daemon response".into()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command(async)]
pub(crate) fn remove_routine(agent: String, key: String) -> Result<(), String> {
    match client::rpc(Request::RemoveRoutine { agent, key }) {
        Ok(Event::Ok) | Ok(Event::Agents { .. }) => Ok(()),
        Ok(Event::Error { message }) => Err(message),
        Ok(_) => Err("unexpected daemon response".into()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command(async)]
pub(crate) fn set_routine_enabled(agent: String, key: String, enabled: bool) -> Result<(), String> {
    match client::rpc(Request::SetRoutineEnabled {
        agent,
        key,
        enabled,
        notify: true,
    }) {
        Ok(Event::Ok) | Ok(Event::Agents { .. }) => Ok(()),
        Ok(Event::Error { message }) => Err(message),
        Ok(_) => Err("unexpected daemon response".into()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command(async)]
pub(crate) fn run_routine(agent: String, key: String) -> Result<(), String> {
    match client::rpc(Request::RunRoutine { agent, key }) {
        Ok(Event::Ok) | Ok(Event::Agents { .. }) => Ok(()),
        Ok(Event::Error { message }) => Err(message),
        Ok(_) => Err("unexpected daemon response".into()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command(async)]
pub(crate) fn edit_routine(
    agent: String,
    key: String,
    name: Option<String>,
    schedule: Option<String>,
    prompt: Option<String>,
) -> Result<(), String> {
    match client::rpc(Request::EditRoutine {
        agent,
        key,
        name,
        schedule,
        prompt,
    }) {
        Ok(Event::Ok) | Ok(Event::Agents { .. }) => Ok(()),
        Ok(Event::Error { message }) => Err(message),
        Ok(_) => Err("unexpected daemon response".into()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command(async)]
pub(crate) fn list_routine_runs(
    agent: String,
    key: String,
) -> Result<Vec<crate::routine_log::RoutineRun>, String> {
    match client::rpc(Request::RoutineRuns { agent, key }) {
        Ok(Event::RoutineRuns { runs, .. }) => Ok(runs),
        Ok(Event::Error { message }) => Err(message),
        Ok(_) => Err("unexpected daemon response".into()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command(async)]
pub(crate) fn search_crew(query: String) -> Result<Vec<crate::search::SearchHit>, String> {
    match client::rpc(Request::Search { query }) {
        Ok(Event::Search { hits }) => Ok(hits),
        Ok(Event::Error { message }) => Err(message),
        Ok(_) => Err("unexpected daemon response".into()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command]
pub(crate) fn list_skills() -> Result<Vec<crate::skills::Skill>, String> {
    Ok(crate::skills::list())
}

#[tauri::command]
pub(crate) fn lookup_skill(query: String) -> Result<Option<crate::skills::Skill>, String> {
    Ok(crate::skills::lookup(&query))
}

#[tauri::command]
pub(crate) fn save_skill(
    name: String,
    body: String,
    previous: Option<String>,
    overwrite: Option<String>,
) -> Result<crate::skills::Saved, String> {
    crate::skills::save(&name, &body, previous.as_deref(), overwrite.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn remove_skill(name: String) -> Result<(), String> {
    crate::skills::remove(&name).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn peek_pending_focus() -> Result<Option<crate::notify::FocusTarget>, String> {
    Ok(crate::notify::peek_focus())
}

#[tauri::command]
pub(crate) fn take_pending_focus() -> Result<Option<crate::notify::FocusTarget>, String> {
    Ok(crate::notify::take_focus())
}

#[tauri::command]
pub(crate) fn set_dock_badge(app: tauri::AppHandle, count: i32) -> Result<(), String> {
    let Some(win) = app.get_webview_window("main") else {
        return Ok(());
    };
    let n = if count > 0 { Some(count as i64) } else { None };
    win.set_badge_count(n).map_err(|e| e.to_string())
}

/// Mirror the UI language so daemon-side strings (notifications, CLI) match it.
#[tauri::command]
pub(crate) fn set_locale(app: tauri::AppHandle, locale: String) -> Result<(), String> {
    crate::paths::write_locale(&locale);
    relabel_split_menu(&app);
    Ok(())
}

/// Window menu entries that split the chat. The window hears the id as a
/// `split` event; the same keys work there without the menu.
const SPLIT_MENU: [(&str, &str); 3] = [
    ("split-row", "CmdOrCtrl+D"),
    ("split-col", "CmdOrCtrl+Shift+D"),
    ("split-close", ""),
];

fn split_menu_label(id: &str, en: bool) -> &'static str {
    match (id, en) {
        ("split-row", false) => "좌우로 나누기",
        ("split-row", true) => "Split Left and Right",
        ("split-col", false) => "위아래로 나누기",
        ("split-col", true) => "Split Top and Bottom",
        (_, false) => "분할 닫기",
        (_, true) => "Close Split",
    }
}

fn app_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, WINDOW_SUBMENU_ID};
    let menu = Menu::default(app)?;
    let Some(window) = menu.get(WINDOW_SUBMENU_ID).and_then(|m| m.as_submenu().cloned()) else {
        return Ok(menu);
    };
    let en = crate::paths::locale() == "en";
    window.append(&PredefinedMenuItem::separator(app)?)?;
    for (id, keys) in SPLIT_MENU {
        let accel = (!keys.is_empty()).then_some(keys);
        window.append(&MenuItem::with_id(app, id, split_menu_label(id, en), true, accel)?)?;
    }
    Ok(menu)
}

fn relabel_split_menu(app: &tauri::AppHandle) {
    use tauri::menu::WINDOW_SUBMENU_ID;
    let Some(window) = app
        .menu()
        .and_then(|m| m.get(WINDOW_SUBMENU_ID))
        .and_then(|m| m.as_submenu().cloned())
    else {
        return;
    };
    let en = crate::paths::locale() == "en";
    for (id, _) in SPLIT_MENU {
        if let Some(item) = window.get(id).and_then(|m| m.as_menuitem().cloned()) {
            let _ = item.set_text(split_menu_label(id, en));
        }
    }
}

/// Mirror the settings switch so alerts still respect it after the window closes.
#[tauri::command]
pub(crate) fn set_notifications(enabled: bool) -> Result<(), String> {
    crate::paths::write_notifications_enabled(enabled);
    Ok(())
}

/// Mirror the lead-only switch: the daemon sends the alerts, window or not.
#[tauri::command]
pub(crate) fn set_lead_only_notify(enabled: bool) -> Result<(), String> {
    crate::paths::write_lead_only_notify(enabled);
    Ok(())
}

/// What the daemon's alerts are set to. The daemon's files are the one value:
/// a window and a paired phone both read it here and change it with the two
/// commands above, so neither shows what the other overwrote.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NotifyPrefs {
    pub enabled: bool,
    pub lead_only: bool,
}

#[tauri::command]
pub(crate) fn get_notify_prefs() -> NotifyPrefs {
    NotifyPrefs {
        enabled: crate::paths::notifications_enabled(),
        lead_only: crate::paths::lead_only_notify(),
    }
}

/// Installed Nerd Fonts for private-use icons, preferred names first.
/// Each entry is the `local()` names of one family (full, PostScript, family).
#[tauri::command]
pub(crate) fn list_nerd_fonts() -> Vec<Vec<String>> {
    crate::nerd_font::installed_nerd_faces()
}

/// Mirror how the window shows chat, so a paired phone can show it the same.
#[tauri::command]
pub(crate) fn set_display_prefs(prefs: crate::paths::DisplayPrefs) -> Result<(), String> {
    crate::paths::write_display_prefs(&prefs);
    Ok(())
}

/// The window's fonts and text size, and the name the user goes by. A phone
/// reads them; the laptop's window is where they change.
#[tauri::command]
pub(crate) fn get_display_prefs() -> Result<crate::paths::DisplayPrefs, String> {
    Ok(crate::paths::display_prefs())
}

/// Mirror the name the user goes by, so a bot's next turn can call them by it.
#[tauri::command]
pub(crate) fn set_user_name(name: String) -> Result<(), String> {
    crate::paths::write_user_name(&name);
    Ok(())
}

/// An open sheet, preview, or menu is using Escape. macOS then keeps fullscreen.
#[tauri::command]
pub(crate) fn set_escape_layer(open: bool) {
    crate::escape_layer::set_layer_open(open);
}

/// Blank when the person cancels. A trailing slash is the dialog's, not part of the folder.
fn folder_from_picker(stdout: &str) -> Option<String> {
    let path = stdout.trim();
    if path.is_empty() {
        return None;
    }
    let trimmed = path.trim_end_matches(['/', '\\']);
    Some(if trimmed.is_empty() {
        "/".to_string()
    } else {
        trimmed.to_string()
    })
}

fn choose_folder_script(prompt: &str) -> String {
    format!(
        "try\nPOSIX path of (choose folder with prompt \"{prompt}\")\non error number -128\nreturn \"\"\nend try"
    )
}

/// Native folder chooser. Cancel is `Ok(None)`, not an error.
#[tauri::command(async)]
pub(crate) fn pick_folder() -> Result<Option<String>, String> {
    let prompt = if crate::paths::locale() == "en" {
        "Group folder"
    } else {
        "그룹 폴더"
    };
    let output = std::process::Command::new("osascript")
        .arg("-e")
        .arg(choose_folder_script(prompt))
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        let err = err.trim();
        if err.is_empty() {
            return Ok(None);
        }
        return Err(err.to_string());
    }
    let path = folder_from_picker(&String::from_utf8_lossy(&output.stdout));
    let Some(path) = path else {
        return Ok(None);
    };
    if !std::path::Path::new(&path).is_dir() {
        return Err(format!("not a folder: {path}"));
    }
    Ok(Some(path))
}

/// A text or code file to draw beside the chat. Up to 1 MiB, cut at a line.
/// `rel` is how the bot wrote a relative path and `base` the folder it works
/// in; when `path` is not there, the file is looked for under `base`.
#[tauri::command(async)]
pub(crate) fn read_text_file(
    path: String,
    base: Option<String>,
    rel: Option<String>,
) -> Result<crate::files::TextFile, String> {
    crate::files::read_text_near(&path, base.as_deref(), rel.as_deref())
}

#[tauri::command(async)]
pub(crate) fn open_path(path: String) -> Result<(), String> {
    let raw = path.trim();
    if raw.is_empty() {
        return Err("path is empty".into());
    }
    let p = crate::paths::expand_tilde(raw);
    if !p.exists() {
        return Err(format!("file not found: {}", p.display()));
    }
    std::process::Command::new("open")
        .arg(&p)
        .status()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// The webview drops `target=_blank`. Hand a web or mail link to `open`.
#[tauri::command(async)]
pub(crate) fn open_url(url: String) -> Result<(), String> {
    let raw = web_url(&url)?;
    std::process::Command::new("open")
        .arg(raw)
        .status()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// One argument for `open`. A space, a control character, or any other scheme stays out.
fn web_url(url: &str) -> Result<&str, String> {
    let raw = url.trim();
    if raw.is_empty() || raw.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("url is not a web link".into());
    }
    let lower = raw.to_ascii_lowercase();
    let prefix = ["https://", "http://", "mailto:"]
        .into_iter()
        .find(|prefix| lower.starts_with(prefix));
    let Some(prefix) = prefix else {
        return Err("url is not a web link".into());
    };
    let rest = &raw[prefix.len()..];
    // `https://` and `mailto:` name nothing. `http:///etc` is not a host.
    if rest.is_empty() || rest.starts_with('/') {
        return Err("url is not a web link".into());
    }
    Ok(raw)
}

/// What each dropped path is: "dir", "file", or "missing". The composer
/// attaches a folder as a folder.
#[tauri::command(async)]
pub(crate) fn path_kinds(paths: Vec<String>) -> Vec<&'static str> {
    paths.iter().map(|p| path_kind(std::path::Path::new(p))).collect()
}

fn path_kind(path: &std::path::Path) -> &'static str {
    match std::fs::metadata(path) {
        Ok(meta) if meta.is_dir() => "dir",
        Ok(_) => "file",
        Err(_) => "missing",
    }
}

/// What the archive learns of each file it lists, by the rule `/api/file`
/// serves by (`~` expanded): "exists", "missing", or "blocked" for one in a
/// hidden folder or outside the Crew home, the user's home and the temp
/// folders. A blocked path is not looked at, so it tells nothing of whether the
/// file is there. Same length and order as `paths`.
#[tauri::command(async)]
pub(crate) fn file_states(paths: Vec<String>) -> Vec<crate::web::FileState> {
    paths
        .iter()
        .map(|p| crate::web::file_state(&crate::paths::expand_tilde(p.trim())))
        .collect()
}

/// Open, merged or closed, and the title, of each GitHub pull request or issue
/// link, read with `gh`. Same length and order as `urls`; a link `gh` cannot
/// read, or that is not one, has no state.
#[tauri::command(async)]
pub(crate) fn link_states(urls: Vec<String>) -> Vec<crate::link_state::LinkState> {
    crate::link_state::link_states(&urls)
}

/// The keys pinned in a bot's archive tab, oldest first.
#[tauri::command(async)]
pub(crate) fn get_pins(agent: String) -> Vec<String> {
    crate::pins::get(&agent)
}

/// Pin or unpin one key of a bot's archive tab; the bot's pins after.
#[tauri::command(async)]
pub(crate) fn set_pin(agent: String, key: String, pinned: bool) -> Result<Vec<String>, String> {
    crate::pins::set(&agent, &key, pinned)
}

/// Forget all of a bot's pins.
#[tauri::command(async)]
pub(crate) fn clear_pins(agent: String) -> Result<(), String> {
    crate::pins::clear(&agent)
}

/// How far each chat has been read, on any device, by chat key.
#[tauri::command(async)]
pub(crate) fn get_read_marks() -> crate::read_marks::Marks {
    crate::read_marks::get()
}

/// Move a chat's read mark forward to `ts`; the mark after.
#[tauri::command(async)]
pub(crate) fn mark_read(key: String, ts: u64) -> Result<u64, String> {
    crate::read_marks::mark(&key, ts)
}

#[tauri::command]
pub(crate) fn save_upload(name: String, data: String) -> Result<String, String> {
    let bytes = crate::avatar::decode_input(&data).map_err(|e| e.to_string())?;
    let dir = crate::paths::home_dir().join("uploads");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stamp = crate::paths::utc_timestamp();
    let safe = crate::paths::safe_agent_id(&name);
    let path =
        crate::paths::write_new_file(&dir, &stamp, &safe, &bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// The app's config and its built UI. The daemon reads the same UI from here
/// to serve it to a phone (`web.rs`), so it is embedded once.
pub(crate) fn context() -> tauri::Context<tauri::Wry> {
    tauri::generate_context!()
}

fn mobile(action: &str, arg: Option<String>) -> Result<serde_json::Value, String> {
    client::ensure_daemon().map_err(|e| e.to_string())?;
    match client::rpc(Request::Mobile {
        action: action.to_string(),
        arg,
    }) {
        Ok(Event::Mobile { info }) => Ok(info),
        Ok(Event::Error { message }) => Err(message),
        Ok(_) => Err("unexpected daemon response".into()),
        Err(err) => Err(err.to_string()),
    }
}

/// Mobile access as it stands: on or off, its addresses, paired devices.
#[tauri::command(async)]
fn mobile_status() -> Result<serde_json::Value, String> {
    mobile("status", None)
}

#[tauri::command(async)]
fn mobile_set(enabled: bool) -> Result<serde_json::Value, String> {
    mobile(if enabled { "on" } else { "off" }, None)
}

/// A new pairing code with its address and QR code.
#[tauri::command(async)]
fn mobile_pair() -> Result<serde_json::Value, String> {
    mobile("pair", None)
}

#[tauri::command(async)]
fn mobile_revoke(id: String) -> Result<serde_json::Value, String> {
    mobile("revoke", Some(id))
}

pub fn run() -> anyhow::Result<()> {
    // Before anything that makes the window: WebKit finds its page data by the
    // app's bundle identifier, so what the old identifier left is copied first.
    crate::webview_data::carry_over_at_start();
    // A daemon that will not start is a window that opens disconnected, not an
    // app that fails to launch. Returning either of these built nothing at all,
    // so a config this binary cannot parse — or a home directory that cannot be
    // created — looked like the app refusing to open, with no window left to
    // fix it from. Nothing here may use `?` for the same reason.
    //
    // `ensure_home` was reached through `ensure_daemon`, and `setup` writes
    // `ui.pid` into that directory and swallows the failure — on a first launch
    // the pid would go unwritten and the window would notify as if it were
    // closed.
    let start = crate::paths::ensure_home()
        // `File exists (os error 17)` alone does not say which path, and this
        // is the text the window will be showing.
        .map_err(|err| format!("create {}: {err:#}", crate::paths::home_dir().display()))
        .and_then(|_| client::ensure_daemon().map_err(|err| format!("{err:#}")));
    set_start_error(match start {
        Ok(_) => None,
        Err(err) => {
            // A bundled .app discards stderr, so the log is where this stays
            // readable after the fact. The error includes the log tail for the
            // window; writing that tail back into the log duplicated every line.
            eprintln!("crew: {err}");
            let summary = err.lines().next().unwrap_or(err.as_str());
            crate::log::append(&format!("crew: {summary}"));
            Some(err)
        }
    });
    #[cfg(debug_assertions)]
    crate::ui_dev::ensure_vite()?;
    #[cfg(target_os = "macos")]
    crate::macos_escape::install();
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            crate::paths::write_ui_pid();
            #[cfg(debug_assertions)]
            crate::ui_dev::attach(app)?;
            let _ = app;
            Ok(())
        })
        .menu(app_menu)
        .on_menu_event(|app, event| {
            use tauri::Emitter;
            let id = event.id().as_ref();
            if let Some(dir) = id.strip_prefix("split-") {
                let _ = app.emit("split", dir);
            }
        })
        .on_window_event(|_window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                crate::paths::clear_ui_pid();
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_agents,
            send_message,
            stop_agent,
            cancel_queued,
            edit_queued,
            send_queued,
            approve_agent,
            answer_choice,
            tell_message,
            get_snapshot,
            get_messages,
            get_messages_page,
            daemon_ping,
            reset_agent,
            set_agent,
            set_agent_cli,
            add_agent,
            clone_agent,
            remove_agent,
            set_avatar,
            clear_avatar,
            add_routine,
            remove_routine,
            set_routine_enabled,
            run_routine,
            edit_routine,
            list_routine_runs,
            get_group_memory,
            set_group_memory,
            remove_group_memory,
            list_groups,
            set_groups,
            archive_group,
            list_archived_groups,
            restore_group,
            delete_archived_group,
            plan_usage,
            list_models,
            get_fallback_ais,
            set_fallback_ais,
            list_templates,
            save_template,
            remove_template,
            search_crew,
            list_skills,
            lookup_skill,
            save_skill,
            remove_skill,
            save_upload,
            peek_pending_focus,
            take_pending_focus,
            read_text_file,
            open_path,
            open_url,
            pick_folder,
            path_kinds,
            file_states,
            link_states,
            get_pins,
            set_pin,
            clear_pins,
            get_read_marks,
            mark_read,
            set_dock_badge,
            set_locale,
            set_notifications,
            set_lead_only_notify,
            get_notify_prefs,
            set_user_name,
            set_display_prefs,
            get_display_prefs,
            list_nerd_fonts,
            set_escape_layer,
            remote_probe,
            remote_join,
            remote_list,
            remote_set,
            remote_leave,
            team_memory_get,
            team_memory_set,
            reserve_agent_ids,
            mobile_status,
            mobile_set,
            mobile_pair,
            mobile_revoke
        ])
        .run(context())
        .map_err(|e| anyhow::anyhow!(e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Serialised: `START_ERROR` is process-wide.
    /// The window declares an ACL, so a command in `generate_handler!` that
    /// never makes it into `build.rs` and `capabilities/default.json` is
    /// rejected on every call. Shared memory shipped that way.
    #[test]
    fn every_window_command_is_granted() {
        let src = include_str!("desktop.rs");
        let start = src.find("generate_handler![").expect("handler") + "generate_handler![".len();
        let end = src[start..].find("])").expect("handler end");
        let names: Vec<&str> = src[start..start + end]
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty() && !line.starts_with("//"))
            .map(|line| line.trim_end_matches(','))
            .collect();
        assert!(names.len() > 10, "the handler list was not parsed");
        let build = include_str!("../build.rs");
        let caps = include_str!("../capabilities/default.json");
        for name in names {
            assert!(
                build.contains(&format!("\"{name}\"")),
                "{name} is missing from build.rs"
            );
            let allow = format!("\"allow-{}\"", name.replace('_', "-"));
            assert!(
                caps.contains(&allow),
                "{name} is missing from capabilities ({allow})"
            );
        }
    }

    /// A window and a phone read the alert switches from the daemon's files, and
    /// the two setters write them: one value, whoever changed it last.
    #[test]
    fn the_alert_switches_are_the_daemons_files() {
        crate::paths::testing::with_home("notify-prefs", || {
            let now = |p: NotifyPrefs| (p.enabled, p.lead_only);
            assert_eq!(now(get_notify_prefs()), (true, false), "a first launch");
            set_lead_only_notify(true).unwrap();
            assert_eq!(now(get_notify_prefs()), (true, true));
            set_notifications(false).unwrap();
            assert_eq!(now(get_notify_prefs()), (false, true));
            set_lead_only_notify(false).unwrap();
            set_notifications(true).unwrap();
            assert_eq!(now(get_notify_prefs()), (true, false));
            // As the window reads it.
            set_lead_only_notify(true).unwrap();
            let json = serde_json::to_string(&get_notify_prefs()).unwrap();
            assert_eq!(json, r#"{"enabled":true,"leadOnly":true}"#);
        });
    }

    /// The archive asks the window's own rule for each file, and a path the
    /// rule shuts out is blocked without a look at the disk, so a hidden file
    /// that is there and one that is not answer alike.
    #[test]
    fn file_states_say_exists_missing_or_blocked() {
        use crate::web::FileState::*;
        let dir = std::env::temp_dir().join(format!("cw-fe-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".hidden")).unwrap();
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("a.txt"), "a").unwrap();
        std::fs::write(dir.join(".hidden/b.txt"), "b").unwrap();
        std::os::unix::fs::symlink("/etc/hosts", dir.join("out.txt")).unwrap();
        let p = |name: &str| dir.join(name).to_string_lossy().into_owned();
        let got = file_states(vec![
            p("a.txt"),
            p("missing.txt"),
            p(".hidden/b.txt"),
            p(".hidden/none.txt"),
            p("sub"),
            p("out.txt"),
            format!("{}/sub/../../../../../../../../../etc/hosts", dir.display()),
            "/etc/hosts".into(),
            "/etc/not-there-at-all".into(),
            format!("  {}  ", p("a.txt")),
            "relative/a.txt".into(),
            String::new(),
        ]);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(
            got,
            vec![
                Exists, Missing, Blocked, Blocked, Missing, Blocked, Blocked, Blocked, Blocked,
                Exists, Missing, Missing,
            ]
        );
        let json = serde_json::to_string(&got[..3]).unwrap();
        assert_eq!(json, r#"["exists","missing","blocked"]"#);
    }

    /// Ids for a template's bots are free now and of each other, even when two
    /// bots share a name.
    #[test]
    fn reserved_ids_do_not_collide() {
        let mut taken = vec!["dev".to_string()];
        let ids = reserve_ids(&["Dev".into(), "Dev".into(), "QA".into()], &mut taken);
        assert_eq!(ids.len(), 3);
        assert!(!ids.contains(&"dev".to_string()), "{ids:?}");
        let mut seen = ids.clone();
        seen.sort();
        seen.dedup();
        assert_eq!(seen.len(), 3, "{ids:?}");
        assert!(ids.iter().all(|id| crate::config::valid_agent_id(id)), "{ids:?}");
    }

    #[test]
    fn a_dropped_path_is_a_folder_a_file_or_gone() {
        let dir = std::env::temp_dir().join(format!("crew-path-kind-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("13_쿠폰팩 1.png");
        std::fs::write(&file, b"x").unwrap();
        assert_eq!(path_kind(&dir), "dir");
        assert_eq!(path_kind(&file), "file");
        assert_eq!(path_kind(&dir.join("gone")), "missing");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_recorded_start_reason_outranks_the_bare_socket_error() {
        set_start_error(Some("parse agents.json: expected value".into()));
        assert_eq!(
            ping_failure("cannot connect to daemon at /x/crew.sock".into()),
            "parse agents.json: expected value"
        );

        // Cleared once a daemon has answered: a later disconnect is a new
        // failure, and the old note would blame a file already fixed.
        set_start_error(None);
        assert_eq!(
            ping_failure("cannot connect to daemon at /x/crew.sock".into()),
            "cannot connect to daemon at /x/crew.sock"
        );
    }

    #[test]
    fn a_picked_folder_keeps_root_and_drops_a_cancel() {
        assert_eq!(folder_from_picker("").as_deref(), None);
        assert_eq!(folder_from_picker("  \n").as_deref(), None);
        assert_eq!(
            folder_from_picker("/Users/a/app/\n").as_deref(),
            Some("/Users/a/app")
        );
        assert_eq!(folder_from_picker("/\n").as_deref(), Some("/"));
        let script = choose_folder_script("그룹 폴더");
        assert!(script.contains("그룹 폴더"));
        assert!(script.contains("-128"));
    }

    #[test]
    fn a_web_or_mail_link_is_one_open_argument() {
        assert_eq!(
            web_url("https://example.com/a?b=1#c").unwrap(),
            "https://example.com/a?b=1#c"
        );
        assert_eq!(
            web_url("  HTTP://Example.com  ").unwrap(),
            "HTTP://Example.com"
        );
        assert_eq!(
            web_url("mailto:a@b.co?subject=hi").unwrap(),
            "mailto:a@b.co?subject=hi"
        );
    }

    #[test]
    fn anything_but_a_web_link_stays_closed() {
        for bad in [
            "",
            "   ",
            "javascript:alert(1)",
            "file:///etc/passwd",
            "https://example.com extra",
            "https://example.com\nopen",
            "https://",
            "http:///",
            "mailto:",
            "/tmp/x",
            "notes.md",
        ] {
            assert!(web_url(bad).is_err(), "{bad}");
        }
    }

    /// The rule from the module header, checked against the file itself: a
    /// command that waits on the daemon or a child process must not hold the
    /// main thread. Adding one is a single missing token away from freezing
    /// the window, and the symptom — a UI that stops repainting while a daemon
    /// is slow — reads as anything but a missing attribute.
    #[test]
    fn no_command_waits_on_the_main_thread() {
        let src = include_str!("desktop.rs");
        let mut offenders = Vec::new();
        for block in src.split("#[tauri::command]\n").skip(1) {
            let body = block.split("\n}\n").next().unwrap_or(block);
            if body.contains("client::rpc")
                || body.contains("client::ensure_daemon")
                || body.contains("process::Command")
            {
                let name = body
                    .split_once("fn ")
                    .and_then(|(_, rest)| rest.split_once(['(', '<']))
                    .map(|(name, _)| name)
                    .unwrap_or("?");
                offenders.push(name.to_string());
            }
        }
        assert!(
            offenders.is_empty(),
            "these wait on the main thread; \
             declare them #[tauri::command(async)]: {offenders:?}"
        );
    }
}
