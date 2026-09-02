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
    /// Ready-made sentence. Used by the native notification and as the UI fallback.
    pub body: String,
    /// `done` | `blocked` | `routine_failed`. The UI renders these in its own language.
    #[serde(default)]
    pub event: String,
    /// Bot name for `done` / `blocked`, routine name for `routine_failed`.
    #[serde(default)]
    pub name: String,
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

pub fn notify_body(name: &str, next: AgentStatus, lang: &str) -> String {
    match (next == AgentStatus::Blocked, lang == "en") {
        (true, true) => format!("{name} needs a look"),
        (true, false) => format!("{name} 확인이 필요합니다"),
        (false, true) => format!("{name} finished"),
        (false, false) => format!("{name} 작업을 마쳤습니다"),
    }
}

pub fn routine_fail_body(routine: &str, lang: &str) -> String {
    if lang == "en" {
        format!("Routine \"{routine}\" failed")
    } else {
        format!("루틴 \"{routine}\" 실행에 실패했습니다")
    }
}

/// Where clicking the notification should land: the bot's chat, or the room.
pub fn focus_scope(target: &str) -> (&'static str, &str) {
    match target.strip_prefix('#') {
        Some(channel) => ("channel", channel),
        None => ("agent", target),
    }
}

/// A scheduled routine could not start. Same focus + notification path as a status
/// change. `target` is a bot id, or `#room` for a channel routine.
pub fn routine_failed(target: &str, routine: &str) {
    let body = routine_fail_body(routine, &paths::locale());
    let (kind, id) = focus_scope(target);
    write_focus(kind, id, &body, "routine_failed", routine);
    if paths::ui_is_live() {
        return;
    }
    notify("Crew", &body);
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
    let body = notify_body(name, next, &paths::locale());
    let (kind, id) = match channel.map(str::trim).filter(|s| !s.is_empty()) {
        Some(ch) => ("channel", ch),
        None => ("agent", agent_id),
    };
    let event = if next == AgentStatus::Blocked { "blocked" } else { "done" };
    write_focus(kind, id, &body, event, name);
    if paths::ui_is_live() {
        return;
    }
    notify("Crew", &body);
}

pub fn focus_path() -> PathBuf {
    paths::home_dir().join("pending-focus.json")
}

pub fn write_focus(kind: &str, id: &str, body: &str, event: &str, name: &str) {
    write_focus_at(
        &focus_path(),
        &FocusTarget {
            kind: kind.to_string(),
            id: id.to_string(),
            body: body.to_string(),
            event: event.to_string(),
            name: name.to_string(),
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
    fn bodies_follow_the_language() {
        assert_eq!(notify_body("Ada", AgentStatus::Idle, "en"), "Ada finished");
        assert_eq!(notify_body("Ada", AgentStatus::Blocked, "en"), "Ada needs a look");
        assert_eq!(notify_body("에이다", AgentStatus::Idle, "ko"), "에이다 작업을 마쳤습니다");
        assert_eq!(routine_fail_body("brief", "en"), "Routine \"brief\" failed");
        assert!(routine_fail_body("brief", "ko").contains("실패"));
    }

    #[test]
    fn a_channel_routine_points_at_the_room() {
        assert_eq!(focus_scope("#room"), ("channel", "room"));
        assert_eq!(focus_scope("alpha"), ("agent", "alpha"));
        assert_eq!(focus_scope("#"), ("channel", ""));
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
                event: "done".into(),
                name: "춘식이".into(),
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
