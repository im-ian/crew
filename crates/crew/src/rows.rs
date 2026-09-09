use crate::protocol::{ChatMessage, MessageKind, Role};

/// How a transcript row should render. `Hidden` is leaked envelope/echo text
/// that must not look like an assistant error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowClass {
    User,
    Assistant,
    Sent,
    Received,
    Routine,
    Handoff,
    Tool,
    Hidden,
}

pub fn is_crew_marker_line(line: &str) -> bool {
    let t = line.trim();
    if !t.starts_with("[crew ") || !t.ends_with(']') {
        return false;
    }
    let inner = &t["[crew ".len()..t.len() - 1];
    inner == "system"
        || inner.starts_with("from:")
        || inner.starts_with("routine:")
        || inner.starts_with("channel:")
}

pub fn strip_crew_markers(s: &str) -> String {
    // Blank lines are content: this runs on every streamed delta, and dropping
    // the newlines a chunk starts with flattens the reply into one line.
    s.split('\n')
        .filter(|line| !is_crew_marker_line(line))
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn display_text(msg: &ChatMessage) -> String {
    reply_body(&strip_crew_markers(&msg.text))
        .trim()
        .to_string()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplyHead {
    pub id: String,
    pub from: String,
    pub snippet: String,
}

/// Pull a `[crew reply:id from:name]` wrapper off a user message, if present.
pub fn split_reply(text: &str) -> (Option<ReplyHead>, &str) {
    let Some(rest) = text.strip_prefix("[crew reply:") else {
        return (None, text);
    };
    let Some(id_end) = rest.find(" from:") else {
        return (None, text);
    };
    let id = &rest[..id_end];
    if id.is_empty() || id.contains(']') || id.contains(char::is_whitespace) {
        return (None, text);
    }
    let after_from = &rest[id_end + " from:".len()..];
    let Some(bracket) = after_from.find("]\n") else {
        return (None, text);
    };
    let from = &after_from[..bracket];
    if from.is_empty() || from.contains(']') {
        return (None, text);
    }
    let after_marker = &after_from[bracket + 2..];
    let Some(split_at) = after_marker.find("\n\n") else {
        return (None, text);
    };
    (
        Some(ReplyHead {
            id: id.to_string(),
            from: from.to_string(),
            snippet: after_marker[..split_at].to_string(),
        }),
        &after_marker[split_at + 2..],
    )
}

pub fn reply_body(text: &str) -> &str {
    split_reply(text).1
}

fn leaked_or_echo(msg: &ChatMessage, prev: Option<&ChatMessage>) -> bool {
    let raw = msg.text.trim();
    if raw.is_empty() {
        return true;
    }
    let had_marker = msg.text.lines().any(is_crew_marker_line);
    let stripped = strip_crew_markers(&msg.text);
    let stripped = stripped.trim();
    if stripped.is_empty() {
        return true;
    }
    if !had_marker {
        if let Some(prev) = prev {
            if matches!(prev.role, Role::User | Role::System)
                && stripped == prev.text.trim()
            {
                return true;
            }
        }
        return false;
    }
    if let Some(prev) = prev {
        if matches!(prev.role, Role::User | Role::System) {
            let src = prev.text.trim();
            if !src.is_empty()
                && stripped
                    .lines()
                    .map(str::trim)
                    .filter(|l| !l.is_empty())
                    .all(|line| line == src)
            {
                return true;
            }
        }
    }
    false
}

/// Classify a stored row. `known_agents` distinguishes inbound teammate
/// notes from routine runs when `kind` was not persisted.
pub fn classify_row(
    msg: &ChatMessage,
    prev: Option<&ChatMessage>,
    known_agents: &[&str],
) -> RowClass {
    if let Some(kind) = msg.kind {
        return match kind {
            MessageKind::Sent => RowClass::Sent,
            MessageKind::Received => RowClass::Received,
            MessageKind::Routine => RowClass::Routine,
            MessageKind::Handoff => RowClass::Handoff,
            MessageKind::Tool => RowClass::Tool,
        };
    }
    match msg.role {
        Role::User => RowClass::User,
        Role::Assistant => {
            if leaked_or_echo(msg, prev) {
                RowClass::Hidden
            } else {
                RowClass::Assistant
            }
        }
        Role::System => {
            if msg.from.starts_with("to:") {
                RowClass::Sent
            } else if msg.from.starts_with('#') {
                RowClass::Received
            } else if known_agents.iter().any(|id| *id == msg.from) {
                RowClass::Received
            } else {
                RowClass::Routine
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(role: Role, from: &str, text: &str) -> ChatMessage {
        ChatMessage {
            id: "1".into(),
            role,
            from: from.into(),
            text: text.into(),
            ts: 1,
            queued: false,
            kind: None,
            approval: None,
            choice: None,
        }
    }

    fn kinded(role: Role, from: &str, text: &str, kind: MessageKind) -> ChatMessage {
        let mut m = msg(role, from, text);
        m.kind = Some(kind);
        m
    }

    #[test]
    fn explicit_kinds_win() {
        let agents = ["alpha", "beta"];
        assert_eq!(
            classify_row(
                &kinded(Role::System, "to:beta", "hi", MessageKind::Sent),
                None,
                &agents
            ),
            RowClass::Sent
        );
        assert_eq!(
            classify_row(
                &kinded(Role::System, "beta", "done", MessageKind::Handoff),
                None,
                &agents
            ),
            RowClass::Handoff
        );
        assert_eq!(
            classify_row(
                &kinded(Role::System, "brief", "standup", MessageKind::Routine),
                None,
                &agents
            ),
            RowClass::Routine
        );
        assert_eq!(
            classify_row(
                &kinded(Role::System, "#room", "hi", MessageKind::Received),
                None,
                &agents
            ),
            RowClass::Received
        );
    }

    #[test]
    fn infers_sent_received_routine() {
        let agents = ["alpha", "beta"];
        assert_eq!(
            classify_row(&msg(Role::System, "to:beta", "please look"), None, &agents),
            RowClass::Sent
        );
        assert_eq!(
            classify_row(&msg(Role::System, "#room", "hello"), None, &agents),
            RowClass::Received
        );
        assert_eq!(
            classify_row(&msg(Role::System, "beta", "from teammate"), None, &agents),
            RowClass::Received
        );
        assert_eq!(
            classify_row(&msg(Role::System, "morning-brief", "standup"), None, &agents),
            RowClass::Routine
        );
        assert_eq!(
            classify_row(&msg(Role::User, "user", "hi"), None, &agents),
            RowClass::User
        );
        assert_eq!(
            classify_row(&msg(Role::Assistant, "alpha", "sure"), None, &agents),
            RowClass::Assistant
        );
    }

    #[test]
    fn leaked_envelope_is_hidden() {
        let agents = ["alpha"];
        let prev = msg(Role::User, "user", "안녕?");
        let leak = msg(
            Role::Assistant,
            "alpha",
            "[crew from:user]\n안녕?",
        );
        assert_eq!(
            classify_row(&leak, Some(&prev), &agents),
            RowClass::Hidden
        );
        let markers_only = msg(Role::Assistant, "alpha", "[crew from:user]\n");
        assert_eq!(classify_row(&markers_only, None, &agents), RowClass::Hidden);
        let channel_leak = msg(
            Role::Assistant,
            "alpha",
            "[crew channel:room from:user]\nhello",
        );
        let prev_ch = msg(Role::System, "#room", "hello");
        assert_eq!(
            classify_row(&channel_leak, Some(&prev_ch), &agents),
            RowClass::Hidden
        );
        let real = msg(Role::Assistant, "alpha", "here is the review");
        assert_eq!(classify_row(&real, Some(&prev), &agents), RowClass::Assistant);
    }

    #[test]
    fn display_text_strips_markers() {
        let m = msg(
            Role::Assistant,
            "alpha",
            "[crew from:user]\nkeep this\n[crew system]\nand this",
        );
        assert_eq!(display_text(&m), "keep this\nand this");
        let sent = msg(Role::System, "to:beta", "[crew from:user]\nplease look");
        assert_eq!(display_text(&sent), "please look");
        let reply = msg(
            Role::User,
            "user",
            "[crew reply:1-2 from:alice]\nplease look\n\ngot it",
        );
        assert_eq!(display_text(&reply), "got it");
    }

    #[test]
    fn split_reply_roundtrip() {
        let raw = "[crew reply:171-2 from:alice]\nplease review the hero\n\ngot it";
        let (head, body) = split_reply(raw);
        assert_eq!(
            head,
            Some(ReplyHead {
                id: "171-2".into(),
                from: "alice".into(),
                snippet: "please review the hero".into(),
            })
        );
        assert_eq!(body, "got it");
        assert_eq!(split_reply("hello"), (None, "hello"));
        let colon = "[crew reply:2-1 from:to:beta]\nping\n\non it";
        let (head, body) = split_reply(colon);
        assert_eq!(head.unwrap().from, "to:beta");
        assert_eq!(body, "on it");
    }
}
