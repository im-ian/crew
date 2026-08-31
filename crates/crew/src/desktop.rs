use crate::client;
use crate::config::{
    empty_to_none, resolve_add_cmd, unique_agent_id, unique_channel_id, AgentCli, Effort,
};
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
) -> Result<(), String> {
    let effort = parse_effort(effort)?;
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

pub fn run() -> anyhow::Result<()> {
    client::ensure_daemon()?;
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            list_agents,
            list_channels,
            send_message,
            tell_message,
            add_channel,
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
            set_routine_enabled
        ])
        .run(tauri::generate_context!())
        .map_err(|e| anyhow::anyhow!(e))?;
    Ok(())
}
