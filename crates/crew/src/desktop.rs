use crate::client;
use crate::config::{
    empty_to_none, resolve_add_cmd, unique_agent_id, unique_channel_id, AgentCli, AvatarShape,
    Effort,
};
use crate::groups::SidebarGroup;
use crate::protocol::{AgentInfo, ChannelInfo, ChatMessage, Event, Request};

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
        Some(s) => AvatarShape::from_key(s).map(Some).map_err(|e| e.to_string()),
    }
}

#[tauri::command]
fn list_models(cli: String) -> Result<crate::models::ModelList, String> {
    let cli = AgentCli::from_key(&cli).map_err(|e| e.to_string())?;
    crate::models::list_models(cli).map_err(|e| e.to_string())
}

#[tauri::command]
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

#[tauri::command]
fn send_message(agent: String, text: String) -> Result<(), String> {
    match client::rpc(Request::Send { agent, text }) {
        Ok(Event::Ok) => Ok(()),
        Ok(Event::Error { message }) => Err(message),
        Ok(_) => Err("unexpected daemon response".into()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command]
fn stop_agent(agent: String) -> Result<(), String> {
    match client::rpc(Request::Interrupt { agent }) {
        Ok(Event::Ok) => Ok(()),
        Ok(Event::Error { message }) => Err(message),
        Ok(_) => Err("unexpected daemon response".into()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command]
fn approve_agent(agent: String, allow: bool) -> Result<(), String> {
    match client::rpc(Request::Approve { agent, allow }) {
        Ok(Event::Ok) => Ok(()),
        Ok(Event::Error { message }) => Err(message),
        Ok(_) => Err("unexpected daemon response".into()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command]
fn tell_message(from: Option<String>, to: String, text: String) -> Result<(), String> {
    let from = client::tell_from(from);
    match client::rpc(Request::Tell {
        from,
        to,
        text,
        channel: None,
    }) {
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

#[tauri::command]
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
fn list_channels() -> Result<Vec<ChannelInfo>, String> {
    client::ensure_daemon().map_err(|e| e.to_string())?;
    match client::rpc(Request::ListChannels) {
        Ok(Event::Channels { channels }) => Ok(channels),
        Ok(Event::Agents { channels, .. }) => Ok(channels),
        Ok(Event::Error { message }) => Err(message),
        Ok(_) => Err("unexpected daemon response".into()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command]
fn get_channel_messages(channel: String) -> Result<Vec<ChatMessage>, String> {
    match client::rpc(Request::ChannelMessages { channel }) {
        Ok(Event::ChannelMessages { messages, .. }) => Ok(messages),
        Ok(Event::Error { message }) => Err(message),
        Ok(_) => Err("unexpected daemon response".into()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command]
fn add_channel(name: String, members: Vec<String>) -> Result<String, String> {
    client::ensure_daemon().map_err(|e| e.to_string())?;
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("name is required".into());
    }
    let existing = list_channels()?;
    let id = unique_channel_id(&name, existing.iter().map(|c| c.id.as_str()));
    match client::rpc(Request::AddChannel {
        id: id.clone(),
        name,
        members,
    }) {
        Ok(Event::Ok) | Ok(Event::Channels { .. }) | Ok(Event::Agents { .. }) => Ok(id),
        Ok(Event::Error { message }) => Err(message),
        Ok(_) => Err("unexpected daemon response".into()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command]
fn set_channel(
    id: String,
    name: Option<String>,
    brief: Option<String>,
    unset_brief: bool,
    members: Option<Vec<String>>,
) -> Result<(), String> {
    client::ensure_daemon().map_err(|e| e.to_string())?;
    let id = id.trim().to_string();
    if id.is_empty() {
        return Err("channel is required".into());
    }
    match client::rpc(Request::SetChannel {
        id,
        name: name.and_then(empty_to_none),
        brief: brief.and_then(empty_to_none),
        unset_brief,
        members,
    }) {
        Ok(Event::Ok) | Ok(Event::Channels { .. }) | Ok(Event::Agents { .. }) => Ok(()),
        Ok(Event::Error { message }) => Err(message),
        Ok(_) => Err("unexpected daemon response".into()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command]
fn leave_channel(channel: String, agent: Option<String>) -> Result<(), String> {
    client::ensure_daemon().map_err(|e| e.to_string())?;
    let channel = channel.trim().to_string();
    if channel.is_empty() {
        return Err("channel is required".into());
    }
    if let Some(agent) = agent.and_then(empty_to_none) {
        match client::rpc(Request::LeaveChannel { channel, agent }) {
            Ok(Event::Ok) | Ok(Event::Channels { .. }) | Ok(Event::Agents { .. }) => Ok(()),
            Ok(Event::Error { message }) => Err(message),
            Ok(_) => Err("unexpected daemon response".into()),
            Err(err) => Err(err.to_string()),
        }
    } else {
        // Desktop user is not a channel member; leaving the room removes it.
        remove_channel(channel)
    }
}

#[tauri::command]
fn remove_channel(channel: String) -> Result<(), String> {
    client::ensure_daemon().map_err(|e| e.to_string())?;
    let channel = channel.trim().to_string();
    if channel.is_empty() {
        return Err("channel is required".into());
    }
    match client::rpc(Request::RemoveChannel { channel }) {
        Ok(Event::Ok) | Ok(Event::Channels { .. }) | Ok(Event::Agents { .. }) => Ok(()),
        Ok(Event::Error { message }) => Err(message),
        Ok(_) => Err("unexpected daemon response".into()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command]
fn channel_send(channel: String, text: String) -> Result<(), String> {
    let from = client::tell_from(Some("user".into()));
    match client::rpc(Request::Tell {
        from,
        to: String::new(),
        text,
        channel: Some(channel),
    }) {
        Ok(Event::Told { .. }) | Ok(Event::Ok) => Ok(()),
        Ok(Event::Error { message }) => Err(message),
        Ok(_) => Err("unexpected daemon response".into()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command]
fn list_groups() -> Result<Vec<SidebarGroup>, String> {
    crate::groups::load().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_groups(groups: Vec<SidebarGroup>) -> Result<(), String> {
    crate::groups::save(&groups).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_memory(agent: String) -> Result<String, String> {
    let agent = agent.trim();
    if agent.is_empty() {
        return Err("agent is required".into());
    }
    Ok(crate::memory::read(agent))
}

#[tauri::command]
fn set_memory(agent: String, text: String) -> Result<(), String> {
    let agent = agent.trim();
    if agent.is_empty() {
        return Err("agent is required".into());
    }
    crate::memory::write(agent, &text).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_messages(agent: String) -> Result<Vec<ChatMessage>, String> {
    match client::rpc(Request::Messages { agent }) {
        Ok(Event::Messages { messages, .. }) => Ok(messages),
        Ok(Event::Error { message }) => Err(message),
        Ok(_) => Err("unexpected daemon response".into()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command]
fn daemon_ping() -> Result<bool, String> {
    match client::rpc(Request::Ping) {
        Ok(Event::Pong) => Ok(true),
        Ok(_) => Ok(false),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
fn add_agent(
    name: String,
    cli: String,
    model: Option<String>,
    effort: Option<String>,
    role: Option<String>,
    description: Option<String>,
) -> Result<String, String> {
    client::ensure_daemon().map_err(|e| e.to_string())?;
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("name is required".into());
    }
    let cli = AgentCli::from_key(&cli).map_err(|e| e.to_string())?;
    let cmd = resolve_add_cmd(Some(cli), Vec::new()).map_err(|e| e.to_string())?;
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
        cwd: None,
        model,
        effort,
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

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
fn clear_avatar(id: String) -> Result<(), String> {
    client::ensure_daemon().map_err(|e| e.to_string())?;
    let id = id.trim().to_string();
    if id.is_empty() {
        return Err("id is required".into());
    }
    rpc_set_avatar(id, None, true)
}

#[tauri::command]
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

#[tauri::command]
fn remove_routine(agent: String, key: String) -> Result<(), String> {
    match client::rpc(Request::RemoveRoutine { agent, key }) {
        Ok(Event::Ok) | Ok(Event::Agents { .. }) => Ok(()),
        Ok(Event::Error { message }) => Err(message),
        Ok(_) => Err("unexpected daemon response".into()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command]
fn set_routine_enabled(agent: String, key: String, enabled: bool) -> Result<(), String> {
    match client::rpc(Request::SetRoutineEnabled {
        agent,
        key,
        enabled,
    }) {
        Ok(Event::Ok) | Ok(Event::Agents { .. }) => Ok(()),
        Ok(Event::Error { message }) => Err(message),
        Ok(_) => Err("unexpected daemon response".into()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command]
fn run_routine(agent: String, key: String) -> Result<(), String> {
    match client::rpc(Request::RunRoutine { agent, key }) {
        Ok(Event::Ok) | Ok(Event::Agents { .. }) => Ok(()),
        Ok(Event::Error { message }) => Err(message),
        Ok(_) => Err("unexpected daemon response".into()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
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
fn save_skill(name: String, body: String) -> Result<crate::skills::Skill, String> {
    crate::skills::save(&name, &body).map_err(|e| e.to_string())
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
    client::ensure_daemon()?;
    #[cfg(debug_assertions)]
    crate::ui_dev::ensure_vite()?;
    tauri::Builder::default()
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
            list_channels,
            send_message,
            stop_agent,
            approve_agent,
            tell_message,
            add_channel,
            set_channel,
            leave_channel,
            remove_channel,
            channel_send,
            get_snapshot,
            get_messages,
            get_channel_messages,
            daemon_ping,
            reset_agent,
            set_agent,
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
            list_groups,
            set_groups,
            list_models,
            search_crew,
            list_skills,
            lookup_skill,
            save_skill,
            save_upload,
            peek_pending_focus,
            take_pending_focus
        ])
        .run(tauri::generate_context!())
        .map_err(|e| anyhow::anyhow!(e))?;
    Ok(())
}
