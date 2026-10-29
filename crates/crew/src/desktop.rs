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
use crate::protocol::{AgentInfo, ChatMessage, Event, Request};

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
fn list_models(cli: String) -> Result<crate::models::ModelList, String> {
    if cli.trim().eq_ignore_ascii_case("custom") {
        return Ok(crate::models::ModelList {
            installed: true,
            ..crate::models::ModelList::default()
        });
    }
    let cli = AgentCli::from_key(&cli).map_err(|e| e.to_string())?;
    crate::models::list_models(cli).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn list_agents() -> Result<Vec<AgentInfo>, String> {
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
fn send_message(agent: String, text: String, steer: bool) -> Result<(), String> {
    match client::rpc(Request::Send { agent, text, steer }) {
        Ok(Event::Ok) => Ok(()),
        Ok(Event::Error { message }) => Err(message),
        Ok(_) => Err("unexpected daemon response".into()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command(async)]
fn stop_agent(agent: String) -> Result<(), String> {
    match client::rpc(Request::Interrupt { agent }) {
        Ok(Event::Ok) => Ok(()),
        Ok(Event::Error { message }) => Err(message),
        Ok(_) => Err("unexpected daemon response".into()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command(async)]
fn cancel_queued(agent: String, message_id: String) -> Result<(), String> {
    match client::rpc(Request::CancelQueued { agent, message_id }) {
        Ok(Event::Ok) => Ok(()),
        Ok(Event::Error { message }) => Err(message),
        Ok(_) => Err("unexpected daemon response".into()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command(async)]
fn send_queued(agent: String, message_id: String) -> Result<(), String> {
    match client::rpc(Request::SendQueued { agent, message_id }) {
        Ok(Event::Ok) => Ok(()),
        Ok(Event::Error { message }) => Err(message),
        Ok(_) => Err("unexpected daemon response".into()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command(async)]
fn edit_queued(agent: String, message_id: String, text: String) -> Result<(), String> {
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
fn approve_agent(agent: String, allow: bool, always: bool) -> Result<(), String> {
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
fn answer_choice(
    agent: String,
    message_id: String,
    answers: Vec<Vec<String>>,
    closed: bool,
    values: Option<Vec<Vec<String>>>,
) -> Result<(), String> {
    match client::rpc(Request::AnswerChoice {
        agent,
        message_id,
        answers,
        values: values.unwrap_or_default(),
        closed,
    }) {
        Ok(Event::Ok) => Ok(()),
        Ok(Event::Error { message }) => Err(message),
        Ok(_) => Err("unexpected daemon response".into()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command(async)]
fn tell_message(from: Option<String>, to: String, text: String) -> Result<(), String> {
    let from = client::tell_from(from);
    match client::rpc(Request::Tell { from, to, text }) {
        Ok(Event::Told { .. }) | Ok(Event::Ok) => Ok(()),
        Ok(Event::Error { message }) => Err(message),
        Ok(_) => Err("unexpected daemon response".into()),
        Err(err) => Err(err.to_string()),
    }
}

#[derive(Clone, serde::Serialize)]
struct SnapshotView {
    agent: String,
    text: String,
    status: crate::protocol::AgentStatus,
}

#[tauri::command(async)]
fn get_snapshot(agent: String) -> Result<SnapshotView, String> {
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

#[tauri::command]
fn list_groups() -> Result<Vec<SidebarGroup>, String> {
    crate::groups::load().map_err(|e| e.to_string())
}

/// A group that leaves the sidebar takes its notes with it.
#[tauri::command]
fn set_groups(groups: Vec<SidebarGroup>) -> Result<(), String> {
    let before = crate::groups::load().unwrap_or_default();
    crate::groups::save(&groups).map_err(|e| e.to_string())?;
    for gone in before
        .iter()
        .filter(|old| !groups.iter().any(|g| g.id == old.id))
    {
        crate::memory::remove_group(&gone.id);
    }
    Ok(())
}

#[tauri::command]
fn get_group_memory(group: String) -> Result<String, String> {
    let group = group.trim();
    if group.is_empty() {
        return Err("group is required".into());
    }
    Ok(crate::memory::read_group(group))
}

#[tauri::command]
fn set_group_memory(group: String, text: String) -> Result<(), String> {
    let group = group.trim();
    if group.is_empty() {
        return Err("group is required".into());
    }
    crate::memory::write_group(group, &text).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_memory(agent: String) -> Result<String, String> {
    let agent = agent.trim();
    if agent.is_empty() {
        return Err("agent is required".into());
    }
    Ok(crate::memory::read(agent))
}

/// `base` is the text the tab loaded; false means the bot changed it since and
/// nothing was written.
#[tauri::command]
fn set_memory(agent: String, text: String, base: String) -> Result<bool, String> {
    let agent = agent.trim();
    if agent.is_empty() {
        return Err("agent is required".into());
    }
    crate::memory::write_if_unchanged(agent, &base, &text).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_shared_memory() -> Result<String, String> {
    Ok(crate::memory::read_shared())
}

#[tauri::command(async)]
fn get_messages(agent: String) -> Result<Vec<ChatMessage>, String> {
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
fn daemon_ping() -> Result<(), String> {
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
fn reset_agent(agent: String, drop_routines: bool) -> Result<String, String> {
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
fn set_agent(
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
fn set_agent_cli(id: String, cli: String, cmd: Option<String>) -> Result<(), String> {
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
fn add_agent(
    name: String,
    cli: String,
    model: Option<String>,
    effort: Option<String>,
    role: Option<String>,
    description: Option<String>,
    cmd: Option<String>,
    cwd: Option<String>,
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
    let existing = list_agents()?;
    let id = unique_agent_id(&name, existing.iter().map(|a| a.id.as_str()));
    match client::rpc(Request::AddAgent {
        id: id.clone(),
        name,
        cmd,
        cwd: cwd.and_then(empty_to_none),
        model,
        effort,
        headless,
    }) {
        Ok(Event::Ok) | Ok(Event::Agents { .. }) => {}
        Ok(Event::Error { message }) => return Err(message),
        Ok(_) => return Err("unexpected daemon response".into()),
        Err(err) => return Err(err.to_string()),
    }
    if role.is_some() || description.is_some() {
        match client::rpc(Request::SetAgent {
            id: id.clone(),
            model: None,
            effort: None,
            unset_model: false,
            unset_effort: false,
            title: None,
            description,
            role,
            unset_title: false,
            unset_description: false,
            unset_role: false,
            avatar: None,
            unset_avatar: false,
            shape: None,
            color: None,
            name: None,
            cwd: None,
            unset_cwd: false,
        }) {
            Ok(Event::Ok) | Ok(Event::Agents { .. }) => {}
            Ok(Event::Error { message }) => return Err(message),
            Ok(_) => return Err("unexpected daemon response".into()),
            Err(err) => return Err(err.to_string()),
        }
    }
    Ok(id)
}

#[tauri::command(async)]
fn clone_agent(id: String, name: Option<String>) -> Result<String, String> {
    client::ensure_daemon().map_err(|e| e.to_string())?;
    let id = id.trim().to_string();
    if id.is_empty() {
        return Err("id is required".into());
    }
    let name = name.and_then(empty_to_none);
    match client::rpc(Request::CloneAgent { id, name }) {
        Ok(Event::Cloned { id }) => Ok(id),
        Ok(Event::Ok) => Err("clone succeeded without a new id".into()),
        Ok(Event::Error { message }) => Err(message),
        Ok(_) => Err("unexpected daemon response".into()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command(async)]
fn remove_agent(id: String) -> Result<(), String> {
    client::ensure_daemon().map_err(|e| e.to_string())?;
    match client::rpc(Request::RemoveAgent { id }) {
        Ok(Event::Ok) | Ok(Event::Agents { .. }) => Ok(()),
        Ok(Event::Error { message }) => Err(message),
        Ok(_) => Err("unexpected daemon response".into()),
        Err(err) => Err(err.to_string()),
    }
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

#[tauri::command(async)]
fn set_avatar(id: String, data: String, name: Option<String>) -> Result<(), String> {
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
fn clear_avatar(id: String) -> Result<(), String> {
    client::ensure_daemon().map_err(|e| e.to_string())?;
    let id = id.trim().to_string();
    if id.is_empty() {
        return Err("id is required".into());
    }
    rpc_set_avatar(id, None, true)
}

#[tauri::command(async)]
fn add_routine(
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
fn remove_routine(agent: String, key: String) -> Result<(), String> {
    match client::rpc(Request::RemoveRoutine { agent, key }) {
        Ok(Event::Ok) | Ok(Event::Agents { .. }) => Ok(()),
        Ok(Event::Error { message }) => Err(message),
        Ok(_) => Err("unexpected daemon response".into()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command(async)]
fn set_routine_enabled(agent: String, key: String, enabled: bool) -> Result<(), String> {
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
fn run_routine(agent: String, key: String) -> Result<(), String> {
    match client::rpc(Request::RunRoutine { agent, key }) {
        Ok(Event::Ok) | Ok(Event::Agents { .. }) => Ok(()),
        Ok(Event::Error { message }) => Err(message),
        Ok(_) => Err("unexpected daemon response".into()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command(async)]
fn edit_routine(
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
fn list_routine_runs(
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
fn search_crew(query: String) -> Result<Vec<crate::search::SearchHit>, String> {
    match client::rpc(Request::Search { query }) {
        Ok(Event::Search { hits }) => Ok(hits),
        Ok(Event::Error { message }) => Err(message),
        Ok(_) => Err("unexpected daemon response".into()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command]
fn list_skills() -> Result<Vec<crate::skills::Skill>, String> {
    Ok(crate::skills::list())
}

#[tauri::command]
fn lookup_skill(query: String) -> Result<Option<crate::skills::Skill>, String> {
    Ok(crate::skills::lookup(&query))
}

#[tauri::command]
fn save_skill(
    name: String,
    body: String,
    previous: Option<String>,
    overwrite: Option<String>,
) -> Result<crate::skills::Saved, String> {
    crate::skills::save(&name, &body, previous.as_deref(), overwrite.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn remove_skill(name: String) -> Result<(), String> {
    crate::skills::remove(&name).map_err(|e| e.to_string())
}

#[tauri::command]
fn peek_pending_focus() -> Result<Option<crate::notify::FocusTarget>, String> {
    Ok(crate::notify::peek_focus())
}

#[tauri::command]
fn take_pending_focus() -> Result<Option<crate::notify::FocusTarget>, String> {
    Ok(crate::notify::take_focus())
}

#[tauri::command]
fn set_dock_badge(app: tauri::AppHandle, count: i32) -> Result<(), String> {
    let Some(win) = app.get_webview_window("main") else {
        return Ok(());
    };
    let n = if count > 0 { Some(count as i64) } else { None };
    win.set_badge_count(n).map_err(|e| e.to_string())
}

/// Mirror the UI language so daemon-side strings (notifications, CLI) match it.
#[tauri::command]
fn set_locale(locale: String) -> Result<(), String> {
    crate::paths::write_locale(&locale);
    Ok(())
}

/// Mirror the settings switch so alerts still respect it after the window closes.
#[tauri::command]
fn set_notifications(enabled: bool) -> Result<(), String> {
    crate::paths::write_notifications_enabled(enabled);
    Ok(())
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
fn pick_folder() -> Result<Option<String>, String> {
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

#[tauri::command(async)]
fn open_path(path: String) -> Result<(), String> {
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
fn open_url(url: String) -> Result<(), String> {
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

#[tauri::command]
fn save_upload(name: String, data: String) -> Result<String, String> {
    let bytes = crate::avatar::decode_input(&data).map_err(|e| e.to_string())?;
    let dir = crate::paths::home_dir().join("uploads");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stamp = crate::paths::utc_timestamp();
    let safe = crate::paths::safe_agent_id(&name);
    let path = dir.join(format!("{stamp}-{safe}"));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

pub fn run() -> anyhow::Result<()> {
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
            // readable after the fact.
            eprintln!("crew: {err}");
            let _ = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(crate::paths::log_path())
                .and_then(|mut f| {
                    use std::io::Write;
                    f.write_all(format!("crew: {err}\n").as_bytes())
                });
            Some(err)
        }
    });
    #[cfg(debug_assertions)]
    crate::ui_dev::ensure_vite()?;
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
            get_memory,
            set_memory,
            get_shared_memory,
            get_group_memory,
            set_group_memory,
            list_groups,
            set_groups,
            list_models,
            search_crew,
            list_skills,
            lookup_skill,
            save_skill,
            remove_skill,
            save_upload,
            peek_pending_focus,
            take_pending_focus,
            open_path,
            open_url,
            pick_folder,
            set_dock_badge,
            set_locale,
            set_notifications
        ])
        .run(tauri::generate_context!())
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
