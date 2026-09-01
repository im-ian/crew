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
    let mut out = String::new();
    for line in s.split('\n') {
        if is_crew_marker_line(line) {
            continue;
        }
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(line);
    }
    out
}

pub fn display_text(msg: &ChatMessage) -> String {
    strip_crew_markers(&msg.text).trim().to_string()
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
    }
}
