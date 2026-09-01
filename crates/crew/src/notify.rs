use std::process::Command;

use crate::protocol::AgentStatus;

/// Fire a desktop notification when a bot finishes or becomes blocked.
pub fn should_notify(prev: AgentStatus, next: AgentStatus) -> bool {
    matches!(
        (prev, next),
        (AgentStatus::Working, AgentStatus::Idle) | (AgentStatus::Working, AgentStatus::Blocked)
    ) || (next == AgentStatus::Blocked && prev != AgentStatus::Blocked)
}

pub fn maybe_status_notify(name: &str, prev: AgentStatus, next: AgentStatus) {
    if !should_notify(prev, next) {
        return;
    }
    let body = if next == AgentStatus::Blocked {
        format!("{name} 확인이 필요합니다")
    } else {
        format!("{name} 작업을 마쳤습니다")
    };
    notify("Crew", &body);
}

pub fn notify(title: &str, body: &str) {
    let script = format!(
        "display notification {} with title {}",
        applescript_str(body),
        applescript_str(title)
    );
    let _ = Command::new("osascript").args(["-e", &script]).status();
}

fn applescript_str(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' | '\r' => out.push(' '),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn applescript_escapes_quotes() {
        assert_eq!(applescript_str(r#"say "hi""#), r#""say \"hi\"""#);
        assert_eq!(applescript_str("line\nbreak"), "\"line break\"");
    }

    #[test]
    fn notifies_on_finish_and_blocked_only() {
        assert!(should_notify(AgentStatus::Working, AgentStatus::Idle));
        assert!(should_notify(AgentStatus::Idle, AgentStatus::Blocked));
        assert!(should_notify(AgentStatus::Working, AgentStatus::Blocked));
        assert!(!should_notify(AgentStatus::Blocked, AgentStatus::Blocked));
        assert!(!should_notify(AgentStatus::Idle, AgentStatus::Idle));
        assert!(!should_notify(AgentStatus::Working, AgentStatus::Working));
    }
}
