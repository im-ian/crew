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
        /// Stop the turn under way and start this one now, instead of queuing.
        #[serde(default)]
        steer: bool,
    },
    Tell {
        from: String,
        #[serde(default)]
        to: String,
        text: String,
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
        /// Unknown command: each message is appended as its last argument.
        #[serde(default)]
        headless: bool,
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
    /// Move a bot to another CLI. `custom` needs `cmd`: the message is appended
    /// as that command's last argument.
    SetCli {
        id: String,
        cli: String,
        #[serde(default)]
        cmd: Vec<String>,
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
        /// Flipped by hand in the routine sheet: say so in the bot's chat.
        #[serde(default)]
        notify: bool,
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
    /// End the in-flight turn. Does not undo already-sealed assistant text.
    Interrupt {
        agent: String,
    },
    /// Take back a message still waiting for the bot: it never goes out.
    CancelQueued {
        agent: String,
        message_id: String,
    },
    /// Rewrite a message still waiting for the bot, keeping its place in line.
    EditQueued {
        agent: String,
        message_id: String,
        text: String,
    },
    /// Send one waiting message without another line in front of it. A turn
    /// already running is left alone; this one is next.
    SendQueued {
        agent: String,
        message_id: String,
    },
    /// Allow-once, allow from now on, or deny a pending judgment card.
    Approve {
        agent: String,
        allow: bool,
        /// Remember this bot: later judgment questions continue without a card.
        #[serde(default)]
        always: bool,
    },
    /// Show a picker or form in chat and wait for the user's answer.
    Ask {
        agent: String,
        question: String,
        options: Vec<String>,
        #[serde(default)]
        inputs: Vec<String>,
        #[serde(default)]
        hint: Option<String>,
        /// Let the user pick more than one option.
        #[serde(default)]
        multi: bool,
        /// More questions on the same card, answered with one submit.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        more: Vec<AskQuestion>,
    },
    /// Pick, fill, or dismiss a pending choice card.
    AnswerChoice {
        agent: String,
        message_id: String,
        /// Option ids chosen for each question, in order. Ignored when `closed`.
        #[serde(default)]
        answers: Vec<Vec<String>>,
        /// Text typed into each question's fields, in order. Ignored when `closed`.
        #[serde(default)]
        values: Vec<Vec<String>>,
        /// Text typed into each question's "other" row, in order. Ignored when `closed`.
        #[serde(default)]
        others: Vec<String>,
        #[serde(default)]
        closed: bool,
    },
    Search {
        query: String,
    },
    /// Is a crew-router there? See `docs/router.md`.
    RemoteProbe {
        url: String,
    },
    /// Sign `bot` up as this PC's representative on the router at `url`.
    RemoteJoin {
        url: String,
        alias: String,
        name: String,
        #[serde(default)]
        invite: Option<String>,
        bot: String,
    },
    RemoteList,
    /// `None` leaves a list as it is. Trusted and blocked are account ids.
    RemoteSet {
        alias: String,
        #[serde(default)]
        trusted: Option<Vec<String>>,
        #[serde(default)]
        blocked: Option<Vec<String>>,
    },
    /// Leave the router: the name is free from now.
    RemoteLeave {
        alias: String,
    },
    /// The router's team notes. Without `alias`, the router `bot` represents,
    /// or the only one.
    TeamMemory {
        #[serde(default)]
        alias: Option<String>,
        #[serde(default)]
        bot: Option<String>,
    },
    TeamMemoryAppend {
        #[serde(default)]
        alias: Option<String>,
        #[serde(default)]
        bot: Option<String>,
        text: String,
    },
    /// Replace the notes, only if they are still at `version`.
    TeamMemorySet {
        #[serde(default)]
        alias: Option<String>,
        #[serde(default)]
        bot: Option<String>,
        text: String,
        #[serde(default)]
        version: Option<u64>,
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
    RoutineRuns {
        agent: String,
        key: String,
        runs: Vec<crate::routine_log::RoutineRun>,
    },
    Search {
        hits: Vec<crate::search::SearchHit>,
    },
    Answered {
        text: String,
    },
    RemoteServer {
        server: crate::remote::RemoteServer,
    },
    Remotes {
        remotes: Vec<crate::remote::RemoteInfo>,
    },
    TeamMemory {
        alias: String,
        text: String,
        version: u64,
    },
    /// Someone changed the team notes first. Nothing was written.
    TeamMemoryConflict,
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
    #[serde(default, skip_serializing_if = "is_zero")]
    pub last_ts: u64,
    /// Unknown command that chats, instead of a long-lived terminal.
    #[serde(default, skip_serializing_if = "is_false")]
    pub headless: bool,
    /// The last turn ended in an error and had nothing to say. It stays until
    /// the next turn starts, so a window opened later still knows.
    #[serde(default, skip_serializing_if = "is_false")]
    pub failed: bool,
    /// A question card is open and waiting for the user.
    #[serde(default, skip_serializing_if = "is_false")]
    pub asking: bool,
    /// The router alias of a bot on another PC. Its id is `<alias>/<account>`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote: Option<String>,
    /// That bot's PC is connected to the router, and so is this one.
    #[serde(default, skip_serializing_if = "is_false")]
    pub remote_online: bool,
    /// The bot answered and its CLI is up only for this background work, such
    /// as a CI watch. A message waits for it instead of stopping it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub watch: Vec<Watch>,
}

/// One task a bot left running after it answered.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Watch {
    /// The task's own description, such as "Watch PR 1352 CI until it finishes".
    pub what: String,
    /// When it started, in ms since the epoch.
    pub since: u64,
}

fn is_false(v: &bool) -> bool {
    !*v
}

fn is_zero(n: &u64) -> bool {
    *n == 0
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
    /// Crew's line where the CLI folded the earlier conversation.
    Compact,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalState {
    Pending,
    Allowed,
    Denied,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ChoiceState {
    #[default]
    Pending,
    Answered,
    Closed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChoiceOption {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChoiceField {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub value: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub secret: bool,
}

/// One question of a `crew ask` card, as the CLI took it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AskQuestion {
    pub question: String,
    #[serde(default)]
    pub options: Vec<String>,
    #[serde(default)]
    pub inputs: Vec<String>,
    #[serde(default)]
    pub hint: Option<String>,
    #[serde(default)]
    pub multi: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChoiceQuestion {
    pub question: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub header: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    #[serde(default)]
    pub options: Vec<ChoiceOption>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fields: Vec<ChoiceField>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub multi: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub selected: Vec<String>,
    /// The user's own answer, typed instead of (or, on a multi pick, beside) the options.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub other: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChoiceCard {
    pub id: String,
    pub questions: Vec<ChoiceQuestion>,
    #[serde(default)]
    pub state: ChoiceState,
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
    /// On a row from a turn another bot asked for: that bot's id. The reply is
    /// copied into its chat, so here the row belongs to the exchange with it.
    /// It is shown beside this chat's thread, not in it, and is not unread.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub peer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<MessageKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval: Option<ApprovalState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub choice: Option<ChoiceCard>,
    /// Sent receipt of a user's @mention. The sentence was typed in this chat
    /// and forwarded to another bot, so a side chat must not speak it again.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub mention: bool,
    /// A question card's answer, sent on as the user's line. The card shows
    /// the answer, so the thread does not show this line too.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub answer: bool,
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
    pub fn label(self, lang: &str) -> &'static str {
        let en = lang == "en";
        match self {
            AgentStatus::Working => {
                if en {
                    "working"
                } else {
                    "작업 중"
                }
            }
            AgentStatus::Idle => {
                if en {
                    "idle"
                } else {
                    "대기"
                }
            }
            AgentStatus::Blocked => {
                if en {
                    "blocked"
                } else {
                    "차단됨"
                }
            }
            AgentStatus::Exited => {
                if en {
                    "exited"
                } else {
                    "종료됨"
                }
            }
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

/// Live roster / system note injected into a running PTY (does not kill the session).
pub fn system_envelope(text: &str) -> String {
    format!("[crew system]\n{text}")
}

/// Teammate reply for the caller. A turn of its own when the caller asked with
/// `crew tell`, otherwise it rides the caller's next prompt.
pub fn handoff_envelope(from: &str, text: &str) -> String {
    let from = from.trim();
    let from = if from.is_empty() { "user" } else { from };
    format!("[crew handoff from:{from}]\n{text}")
}

/// A full report fits. The 800 it was cut a teammate's report off after its
/// progress lines and table, before what it was blocked on.
pub const HANDOFF_CLIP: usize = 4000;

/// A reply opens with progress lines and ends with what is left, so a long one
/// keeps its start and, mostly, its end.
pub fn clip_middle(s: &str, n: usize) -> String {
    let total = s.chars().count();
    if total <= n {
        return s.to_string();
    }
    let head = n * 2 / 5;
    let tail = n - head;
    let start: String = s.chars().take(head).collect();
    let end: String = s.chars().skip(total - tail).collect();
    format!("{start}\n…\n{end}")
}

/// Stick `extra` after the first `[crew …]` marker line so origin parsing
/// still sees the envelope first. Bare prompts get `extra` prepended.
pub fn attach_after_marker(prompt: &str, extra: &str) -> String {
    if extra.is_empty() {
        return prompt.to_string();
    }
    // A prompt that is itself a handoff has no sender line to keep on top.
    if prompt.starts_with("[crew ") && !prompt.starts_with("[crew handoff") {
        if let Some((first, rest)) = prompt.split_once('\n') {
            return format!("{first}\n{extra}{rest}");
        }
        return format!("{prompt}\n{extra}");
    }
    format!("{extra}{prompt}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_labels_follow_the_language() {
        assert_eq!(AgentStatus::Working.label("en"), "working");
        assert_eq!(AgentStatus::Idle.label("en"), "idle");
        assert_eq!(AgentStatus::Blocked.label("en"), "blocked");
        assert_eq!(AgentStatus::Exited.label("en"), "exited");
        assert_eq!(AgentStatus::Working.label("ko"), "작업 중");
        assert_eq!(AgentStatus::Exited.label("ko"), "종료됨");
        // Anything that is not English stays Korean, the daemon's default.
        assert_eq!(AgentStatus::Idle.label(""), "대기");
    }

    #[test]
    fn a_long_reply_keeps_its_start_and_end() {
        assert_eq!(clip_middle("짧은 답", 10), "짧은 답");
        let report = format!("{}{}{}", "가".repeat(10), "나".repeat(30), "다".repeat(10));
        let kept = format!(
            "{}\n…\n{}{}",
            "가".repeat(8),
            "나".repeat(2),
            "다".repeat(10)
        );
        assert_eq!(clip_middle(&report, 20), kept);
    }

    #[test]
    fn tell_envelope_format() {
        assert_eq!(envelope("alpha", "hello"), "[crew from:alpha]\nhello");
        assert_eq!(envelope("  ", "x"), "[crew from:user]\nx");
        assert_eq!(
            handoff_envelope("beta", "ok"),
            "[crew handoff from:beta]\nok"
        );
        assert_eq!(
            attach_after_marker("[crew from:user]\nhello", "[crew handoff from:beta]\nok\n"),
            "[crew from:user]\n[crew handoff from:beta]\nok\nhello"
        );
        assert_eq!(
            attach_after_marker("hello", "[crew handoff from:beta]\nok\n"),
            "[crew handoff from:beta]\nok\nhello"
        );
        assert_eq!(
            attach_after_marker(
                "[crew handoff from:alpha]\n보",
                "[crew handoff from:beta]\nok\n"
            ),
            "[crew handoff from:beta]\nok\n[crew handoff from:alpha]\n보"
        );
    }

    #[test]
    fn tell_request_roundtrip() {
        let req = Request::Tell {
            from: "alpha".into(),
            to: "beta".into(),
            text: "hi".into(),
        };
        let line = req.to_line().unwrap();
        assert!(line.contains("\"type\":\"tell\""));
        let back: Request = serde_json::from_str(&line).unwrap();
        match back {
            Request::Tell { from, to, text } => {
                assert_eq!(
                    (from, to, text),
                    ("alpha".into(), "beta".into(), "hi".into())
                );
            }
            other => panic!("unexpected {other:?}"),
        }
        let old = r#"{"type":"tell","from":"alpha","to":"beta","text":"hi"}"#;
        let back: Request = serde_json::from_str(old).unwrap();
        match back {
            Request::Tell { to, .. } => assert_eq!(to, "beta"),
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
    fn ask_request_roundtrip() {
        let req = Request::Ask {
            agent: "alpha".into(),
            question: "어느 쪽을 고를래?".into(),
            options: vec!["A".into(), "B".into(), "C".into()],
            inputs: Vec::new(),
            hint: None,
            multi: false,
            more: Vec::new(),
        };
        let line = req.to_line().unwrap();
        assert!(line.contains("\"type\":\"ask\""));
        assert!(!line.contains("more"), "one question sends what an older daemon reads");
        let back: Request = serde_json::from_str(&line).unwrap();
        match back {
            Request::Ask {
                agent,
                question,
                options,
                inputs,
                hint,
                multi,
                more,
            } => {
                assert!(!multi);
                assert!(more.is_empty());
                assert_eq!(agent, "alpha");
                assert_eq!(question, "어느 쪽을 고를래?");
                assert_eq!(options, vec!["A", "B", "C"]);
                assert!(inputs.is_empty());
                assert!(hint.is_none());
            }
            other => panic!("unexpected {other:?}"),
        }
        let old = r#"{"type":"ask","agent":"alpha","question":"Q","options":["A","B"]}"#;
        let back: Request = serde_json::from_str(old).unwrap();
        match back {
            Request::Ask {
                inputs, hint, more, ..
            } => {
                assert!(inputs.is_empty());
                assert!(hint.is_none());
                assert!(more.is_empty());
            }
            other => panic!("unexpected {other:?}"),
        }
        let req = Request::Ask {
            agent: "alpha".into(),
            question: "로그인".into(),
            options: Vec::new(),
            inputs: vec!["아이디".into(), "비밀번호".into()],
            hint: Some("이 계정으로 로그인해주세요.".into()),
            multi: false,
            more: vec![AskQuestion {
                question: "어느 서버?".into(),
                options: vec!["dev".into(), "prod".into()],
                multi: true,
                ..AskQuestion::default()
            }],
        };
        let line = req.to_line().unwrap();
        let back: Request = serde_json::from_str(&line).unwrap();
        match back {
            Request::Ask {
                inputs, hint, more, ..
            } => {
                assert_eq!(inputs, vec!["아이디", "비밀번호"]);
                assert_eq!(hint.as_deref(), Some("이 계정으로 로그인해주세요."));
                assert_eq!(more.len(), 1);
                assert_eq!(more[0].question, "어느 서버?");
                assert_eq!(more[0].options, vec!["dev", "prod"]);
                assert!(more[0].multi);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn answer_choice_values_roundtrip() {
        let req = Request::AnswerChoice {
            agent: "alpha".into(),
            message_id: "1".into(),
            answers: Vec::new(),
            values: vec![vec!["id".into(), "pw".into()]],
            others: Vec::new(),
            closed: false,
        };
        let line = req.to_line().unwrap();
        assert!(line.contains("\"values\""));
        let back: Request = serde_json::from_str(&line).unwrap();
        match back {
            Request::AnswerChoice {
                values, answers, ..
            } => {
                assert!(answers.is_empty());
                assert_eq!(values, vec![vec!["id", "pw"]]);
            }
            other => panic!("unexpected {other:?}"),
        }
        let old = r#"{"type":"answer_choice","agent":"alpha","message_id":"1"}"#;
        let back: Request = serde_json::from_str(old).unwrap();
        match back {
            Request::AnswerChoice { values, closed, .. } => {
                assert!(values.is_empty());
                assert!(!closed);
            }
            other => panic!("unexpected {other:?}"),
        }
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
            peer: None,
            kind: None,
            approval: None,
            choice: None,
            mention: false,
            answer: false,
        };
        let line = serde_json::to_string(&msg).unwrap();
        assert!(line.contains("\"role\":\"user\""));
        // Left off when unset, so a daemon from before it reads the line as it was.
        assert!(!line.contains("answer"), "{line}");
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
            name: Some("그록봇 테스터".into()),
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
                name,
                cwd,
                unset_cwd,
                ..
            } => {
                assert_eq!(id, "grok");
                assert_eq!(avatar.as_deref(), Some("/tmp/a.png"));
                assert!(!unset_avatar);
                assert_eq!(shape, Some(crate::config::AvatarShape::Circle));
                assert_eq!(color.as_deref(), Some("#ff6a00"));
                assert_eq!(name.as_deref(), Some("그록봇 테스터"));
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
