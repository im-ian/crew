use std::process::Command;

use crate::protocol::AgentStatus;

/// Fire a desktop notification when a bot finishes or becomes blocked.
/// Explicit stop/interrupt is `interrupted = true` and must not look like a finish.
pub fn should_notify(prev: AgentStatus, next: AgentStatus, interrupted: bool) -> bool {
    if next == AgentStatus::Blocked && prev != AgentStatus::Blocked {
        return true;
    }
    if interrupted {
        return false;
    }
    prev == AgentStatus::Working && next == AgentStatus::Idle
}

pub fn maybe_status_notify(name: &str, prev: AgentStatus, next: AgentStatus, interrupted: bool) {
    if !should_notify(prev, next, interrupted) {
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
        assert!(should_notify(AgentStatus::Working, AgentStatus::Idle, false));
        assert!(should_notify(AgentStatus::Idle, AgentStatus::Blocked, false));
        assert!(should_notify(AgentStatus::Working, AgentStatus::Blocked, false));
        assert!(should_notify(AgentStatus::Idle, AgentStatus::Blocked, true));
        assert!(!should_notify(AgentStatus::Working, AgentStatus::Idle, true));
        assert!(!should_notify(AgentStatus::Blocked, AgentStatus::Blocked, false));
        assert!(!should_notify(AgentStatus::Idle, AgentStatus::Idle, false));
        assert!(!should_notify(AgentStatus::Working, AgentStatus::Working, false));
    }
}
