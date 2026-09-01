use serde::{Deserialize, Serialize};

use crate::config::{AvatarShape, Effort, Routine};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Request {
    Ping,
    List,
    Subscribe,
    Send {
        agent: String,
        text: String,
    },
    Tell {
        from: String,
        #[serde(default)]
        to: String,
        text: String,
        #[serde(default)]
        channel: Option<String>,
    },
    Input {
        agent: String,
        data: String,
    },
    Resize {
        agent: String,
        cols: u16,
        rows: u16,
    },
    Snapshot {
        agent: String,
    },
    Messages {
        agent: String,
    },
    AddAgent {
        id: String,
        name: String,
        cmd: Vec<String>,
        cwd: Option<String>,
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        effort: Option<Effort>,
    },
    RemoveAgent {
        id: String,
    },
    CloneAgent {
        id: String,
        #[serde(default)]
        name: Option<String>,
    },
    SetAgent {
        id: String,
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        effort: Option<Effort>,
        #[serde(default)]
        unset_model: bool,
        #[serde(default)]
        unset_effort: bool,
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        description: Option<String>,
        #[serde(default)]
        role: Option<String>,
        #[serde(default)]
        unset_title: bool,
        #[serde(default)]
        unset_description: bool,
        #[serde(default)]
        unset_role: bool,
        #[serde(default)]
        avatar: Option<String>,
        #[serde(default)]
        unset_avatar: bool,
        #[serde(default)]
        shape: Option<AvatarShape>,
        #[serde(default)]
        color: Option<String>,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        cwd: Option<String>,
        #[serde(default)]
        unset_cwd: bool,
    },
    Reset {
        agent: String,
        #[serde(default)]
        drop_routines: bool,
    },
    AddRoutine {
        agent: String,
        name: String,
        schedule: String,
        prompt: String,
    },
    RemoveRoutine {
        agent: String,
        key: String,
    },
    SetRoutineEnabled {
        agent: String,
        key: String,
        enabled: bool,
    },
    RunRoutine {
        agent: String,
        key: String,
    },
    EditRoutine {
        agent: String,
        key: String,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        schedule: Option<String>,
        #[serde(default)]
        prompt: Option<String>,
    },
    RoutineRuns {
        agent: String,
        key: String,
    },
    ListChannels,
    ChannelMessages {
        channel: String,
    },
    AddChannel {
        id: String,
        name: String,
        #[serde(default)]
        members: Vec<String>,
    },
    JoinChannel {
        channel: String,
        agent: String,
    },
    LeaveChannel {
        channel: String,
        agent: String,
    },
    RemoveChannel {
        channel: String,
    },
    SetChannel {
        id: String,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        brief: Option<String>,
        #[serde(default)]
        unset_brief: bool,
        #[serde(default)]
        members: Option<Vec<String>>,
    },
    /// End the in-flight turn. Does not undo already-sealed assistant text.
    Interrupt {
        agent: String,
    },
    /// Allow-once or deny a pending judgment card.
    Approve {
        agent: String,
        allow: bool,
    },
    Search {
        query: String,
    },
    Shutdown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    Pong,
    Ok,
    Cloned {
        id: String,
    },
    Error {
        message: String,
    },
    Agents {
        agents: Vec<AgentInfo>,
        #[serde(default)]
        channels: Vec<ChannelInfo>,
    },
    Frame {
        agent: String,
        cols: u16,
        rows: u16,
        text: String,
        status: AgentStatus,
        seq: u64,
    },
    Snapshot {
        agent: String,
        cols: u16,
        rows: u16,
        text: String,
        status: AgentStatus,
    },
    Messages {
        agent: String,
        messages: Vec<ChatMessage>,
    },
    Message {
        agent: String,
        message: ChatMessage,
    },
    Reset {
        agent: String,
        archive: String,
        drop_routines: bool,
    },
    Told {
        from: String,
        to: String,
    },
    Channels {
        channels: Vec<ChannelInfo>,
    },
    ChannelMessages {
        channel: String,
        messages: Vec<ChatMessage>,
    },
    ChannelMessage {
        channel: String,
        message: ChatMessage,
    },
    RoutineRuns {
        agent: String,
        key: String,
        runs: Vec<crate::routine_log::RoutineRun>,
    },
    Search {
        hits: Vec<crate::search::SearchHit>,
    },
    Shutdown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentInfo {
    pub id: String,
    pub name: String,
    pub status: AgentStatus,
    pub cmd: Vec<String>,
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<Effort>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_shape: Option<AvatarShape>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default)]
    pub routines: Vec<Routine>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    /// Channel this bot is currently working for, if the turn started there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_channel: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelInfo {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub members: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brief: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    User,
    Assistant,
    System,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::User => "user",
            Role::Assistant => "assistant",
            Role::System => "system",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageKind {
    Sent,
    Received,
    Routine,
    Handoff,
    Tool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalState {
    Pending,
    Allowed,
    Denied,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub id: String,
    pub role: Role,
    pub from: String,
    pub text: String,
    pub ts: u64,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub queued: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<MessageKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval: Option<ApprovalState>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentStatus {
    Working,
    Idle,
    Blocked,
    Exited,
}

impl AgentStatus {
    pub fn ko_label(self) -> &'static str {
        match self {
            AgentStatus::Working => "작업 중",
            AgentStatus::Idle => "대기",
            AgentStatus::Blocked => "차단됨",
            AgentStatus::Exited => "종료됨",
        }
    }
}

impl Request {
    pub fn to_line(&self) -> anyhow::Result<String> {
        Ok(serde_json::to_string(self)?)
    }
}

impl Event {
    pub fn to_line(&self) -> anyhow::Result<String> {
        Ok(serde_json::to_string(self)?)
    }

    pub fn from_line(line: &str) -> anyhow::Result<Self> {
        Ok(serde_json::from_str(line)?)
    }
}

/// Marked 1:1 envelope injected into the recipient PTY.
pub fn envelope(from: &str, text: &str) -> String {
    let from = from.trim();
    let from = if from.is_empty() { "user" } else { from };
    format!("[crew from:{from}]\n{text}")
}

/// Marked routine envelope injected into the agent's PTY.
pub fn routine_envelope(name: &str, prompt: &str) -> String {
    format!("[crew routine:{name}]\n{prompt}")
}

/// Group-chat envelope injected into each member's PTY.
pub fn channel_envelope(channel: &str, from: &str, text: &str) -> String {
    let from = from.trim();
    let from = if from.is_empty() { "user" } else { from };
    format!("[crew channel:{channel} from:{from}]\n{text}")
}

/// Live roster / system note injected into a running PTY (does not kill the session).
pub fn system_envelope(text: &str) -> String {
    format!("[crew system]\n{text}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tell_envelope_format() {
        assert_eq!(envelope("alpha", "hello"), "[crew from:alpha]\nhello");
        assert_eq!(envelope("  ", "x"), "[crew from:user]\nx");
    }

    #[test]
    fn tell_request_roundtrip() {
        let req = Request::Tell {
            from: "alpha".into(),
            to: "beta".into(),
            text: "hi".into(),
            channel: None,
        };
        let line = req.to_line().unwrap();
        assert!(line.contains("\"type\":\"tell\""));
        let back: Request = serde_json::from_str(&line).unwrap();
        match back {
            Request::Tell {
                from,
                to,
                text,
                channel,
            } => {
                assert_eq!(
                    (from, to, text),
                    ("alpha".into(), "beta".into(), "hi".into())
                );
                assert!(channel.is_none());
            }
            other => panic!("unexpected {other:?}"),
        }
        let old = r#"{"type":"tell","from":"alpha","to":"beta","text":"hi"}"#;
        let back: Request = serde_json::from_str(old).unwrap();
        match back {
            Request::Tell { channel, to, .. } => {
                assert_eq!(to, "beta");
                assert!(channel.is_none());
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn channel_envelope_format() {
        assert_eq!(
            channel_envelope("room", "alpha", "hello"),
            "[crew channel:room from:alpha]\nhello"
        );
        assert_eq!(
            channel_envelope("room", "  ", "x"),
            "[crew channel:room from:user]\nx"
        );
    }

    #[test]
    fn add_channel_roundtrip() {
        let req = Request::AddChannel {
            id: "room".into(),
            name: "Room".into(),
            members: vec!["alpha".into(), "beta".into()],
        };
        let line = req.to_line().unwrap();
        assert!(line.contains("\"type\":\"add_channel\""));
        let back: Request = serde_json::from_str(&line).unwrap();
        match back {
            Request::AddChannel { id, members, .. } => {
                assert_eq!(id, "room");
                assert_eq!(members, vec!["alpha", "beta"]);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn set_channel_roundtrip() {
        let req = Request::SetChannel {
            id: "room".into(),
            name: Some("Room".into()),
            brief: Some("standup notes".into()),
            unset_brief: false,
            members: Some(vec!["alpha".into(), "beta".into()]),
        };
        let line = req.to_line().unwrap();
        assert!(line.contains("\"type\":\"set_channel\""));
        let back: Request = serde_json::from_str(&line).unwrap();
        match back {
            Request::SetChannel {
                id,
                name,
                brief,
                unset_brief,
                members,
            } => {
                assert_eq!(id, "room");
                assert_eq!(name.as_deref(), Some("Room"));
                assert_eq!(brief.as_deref(), Some("standup notes"));
                assert!(!unset_brief);
                assert_eq!(members, Some(vec!["alpha".into(), "beta".into()]));
            }
            other => panic!("unexpected {other:?}"),
        }
        let old = r#"{"type":"set_channel","id":"room"}"#;
        let back: Request = serde_json::from_str(old).unwrap();
        match back {
            Request::SetChannel {
                name,
                brief,
                unset_brief,
                members,
                ..
            } => {
                assert!(name.is_none());
                assert!(brief.is_none());
                assert!(!unset_brief);
                assert!(members.is_none());
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn leave_and_remove_channel_roundtrip() {
        let leave = Request::LeaveChannel {
            channel: "room".into(),
            agent: "alpha".into(),
        };
        let line = leave.to_line().unwrap();
        assert!(line.contains("\"type\":\"leave_channel\""));
        let back: Request = serde_json::from_str(&line).unwrap();
        match back {
            Request::LeaveChannel { channel, agent } => {
                assert_eq!(channel, "room");
                assert_eq!(agent, "alpha");
            }
            other => panic!("unexpected {other:?}"),
        }
        let remove = Request::RemoveChannel {
            channel: "room".into(),
        };
        let line = remove.to_line().unwrap();
        assert!(line.contains("\"type\":\"remove_channel\""));
        let back: Request = serde_json::from_str(&line).unwrap();
        match back {
            Request::RemoveChannel { channel } => assert_eq!(channel, "room"),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn system_envelope_format() {
        assert_eq!(
            system_envelope("Teammates: alpha — Alpha"),
            "[crew system]\nTeammates: alpha — Alpha"
        );
    }

    #[test]
    fn routine_envelope_format() {
        assert_eq!(
            routine_envelope("ping", "hello"),
            "[crew routine:ping]\nhello"
        );
    }

    #[test]
    fn chat_message_roundtrip() {
        let msg = ChatMessage {
            id: "1".into(),
            role: Role::User,
            from: "user".into(),
            text: "hello".into(),
            ts: 1,
            queued: false,
            kind: None,
            approval: None,
        };
        let line = serde_json::to_string(&msg).unwrap();
        assert!(line.contains("\"role\":\"user\""));
        let back: ChatMessage = serde_json::from_str(&line).unwrap();
        assert_eq!(back.text, "hello");
        assert_eq!(back.role, Role::User);
    }

    #[test]
    fn messages_request_roundtrip() {
        let req = Request::Messages {
            agent: "alpha".into(),
        };
        let line = req.to_line().unwrap();
        assert!(line.contains("\"type\":\"messages\""));
        let back: Request = serde_json::from_str(&line).unwrap();
        match back {
            Request::Messages { agent } => assert_eq!(agent, "alpha"),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn set_agent_avatar_roundtrip() {
        let req = Request::SetAgent {
            id: "grok".into(),
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
            avatar: Some("/tmp/a.png".into()),
            unset_avatar: false,
            shape: Some(crate::config::AvatarShape::Circle),
            color: Some("#ff6a00".into()),
            name: None,
            cwd: Some("~/proj".into()),
            unset_cwd: false,
        };
        let line = req.to_line().unwrap();
        assert!(line.contains("\"avatar\":\"/tmp/a.png\""));
        assert!(line.contains("\"shape\":\"circle\""));
        assert!(line.contains("\"color\":\"#ff6a00\""));
        assert!(line.contains("\"cwd\":\"~/proj\""));
        let back: Request = serde_json::from_str(&line).unwrap();
        match back {
            Request::SetAgent {
                id,
                avatar,
                unset_avatar,
                shape,
                color,
                cwd,
                unset_cwd,
                ..
            } => {
                assert_eq!(id, "grok");
                assert_eq!(avatar.as_deref(), Some("/tmp/a.png"));
                assert!(!unset_avatar);
                assert_eq!(shape, Some(crate::config::AvatarShape::Circle));
                assert_eq!(color.as_deref(), Some("#ff6a00"));
                assert_eq!(cwd.as_deref(), Some("~/proj"));
                assert!(!unset_cwd);
            }
            other => panic!("unexpected {other:?}"),
        }
        let old = r#"{"type":"set_agent","id":"grok"}"#;
        let back: Request = serde_json::from_str(old).unwrap();
        match back {
            Request::SetAgent {
                unset_avatar,
                avatar,
                shape,
                color,
                cwd,
                unset_cwd,
                ..
            } => {
                assert!(avatar.is_none());
                assert!(!unset_avatar);
                assert!(shape.is_none());
                assert!(color.is_none());
                assert!(cwd.is_none());
                assert!(!unset_cwd);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn clone_agent_request_roundtrip() {
        let req = Request::CloneAgent {
            id: "grok".into(),
            name: Some("Twin".into()),
        };
        let line = req.to_line().unwrap();
        assert!(line.contains("\"type\":\"clone_agent\""));
        let back: Request = serde_json::from_str(&line).unwrap();
        match back {
            Request::CloneAgent { id, name } => {
                assert_eq!(id, "grok");
                assert_eq!(name.as_deref(), Some("Twin"));
            }
            other => panic!("unexpected {other:?}"),
        }
        let back: Request = serde_json::from_str(r#"{"type":"clone_agent","id":"grok"}"#).unwrap();
        match back {
            Request::CloneAgent { id, name } => {
                assert_eq!(id, "grok");
                assert!(name.is_none());
            }
            other => panic!("unexpected {other:?}"),
        }
    }
}
