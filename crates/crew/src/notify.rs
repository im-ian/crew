use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::paths;
use crate::protocol::AgentStatus;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FocusTarget {
    pub kind: String,
    pub id: String,
    pub body: String,
}

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

pub fn notify_body(name: &str, next: AgentStatus) -> String {
    if next == AgentStatus::Blocked {
        format!("{name} 확인이 필요합니다")
    } else {
        format!("{name} 작업을 마쳤습니다")
    }
}

pub fn maybe_status_notify(
    agent_id: &str,
    name: &str,
    channel: Option<&str>,
    prev: AgentStatus,
    next: AgentStatus,
    interrupted: bool,
) {
    if !should_notify(prev, next, interrupted) {
        return;
    }
    let body = notify_body(name, next);
    let (kind, id) = match channel.map(str::trim).filter(|s| !s.is_empty()) {
        Some(ch) => ("channel", ch),
        None => ("agent", agent_id),
    };
    write_focus(kind, id, &body);
    if paths::ui_is_live() {
        return;
    }
    notify("Crew", &body);
}

pub fn focus_path() -> PathBuf {
    paths::home_dir().join("pending-focus.json")
}

pub fn write_focus(kind: &str, id: &str, body: &str) {
    write_focus_at(
        &focus_path(),
        &FocusTarget {
            kind: kind.to_string(),
            id: id.to_string(),
            body: body.to_string(),
        },
    );
}

pub fn write_focus_at(path: &Path, target: &FocusTarget) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(raw) = serde_json::to_string(target) {
        let _ = fs::write(path, raw);
    }
}

pub fn peek_focus() -> Option<FocusTarget> {
    peek_focus_at(&focus_path())
}

pub fn peek_focus_at(path: &Path) -> Option<FocusTarget> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

pub fn take_focus() -> Option<FocusTarget> {
    take_focus_at(&focus_path())
}

pub fn take_focus_at(path: &Path) -> Option<FocusTarget> {
    let hit = peek_focus_at(path)?;
    let _ = fs::remove_file(path);
    Some(hit)
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

    #[test]
    fn focus_file_roundtrips_and_take_consumes() {
        let dir = std::env::temp_dir().join(format!(
            "crew-focus-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("pending-focus.json");
        write_focus_at(
            &path,
            &FocusTarget {
                kind: "channel".into(),
                id: "room".into(),
                body: "춘식이 작업을 마쳤습니다".into(),
            },
        );
        let peek = peek_focus_at(&path).expect("peek");
        assert_eq!(peek.kind, "channel");
        assert_eq!(peek.id, "room");
        let taken = take_focus_at(&path).expect("take");
        assert_eq!(taken.id, "room");
        assert!(take_focus_at(&path).is_none());
        let _ = fs::remove_dir_all(&dir);
    }
}
