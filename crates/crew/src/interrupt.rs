use crate::protocol::AgentStatus;

/// What to do with a user 1:1 send.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UserSendAction {
    /// Agent is idle (or blocked waiting on us): start a new turn.
    Start,
    /// Agent is working: kill the in-flight turn, then start this prompt.
    Redirect,
    /// Explicit stop: end the in-flight turn, do not start a new one.
    Stop,
}

pub fn is_stop_command(text: &str) -> bool {
    let t = text
        .trim()
        .trim_end_matches(['.', '!', '?', '。', '！'])
        .to_lowercase();
    matches!(
        t.as_str(),
        "stop"
            | "stop now"
            | "cancel"
            | "abort"
            | "halt"
            | "멈춰"
            | "멈춰줘"
            | "중지"
            | "중지해"
            | "그만"
            | "그만해"
    )
}

pub fn user_send_action(status: AgentStatus, text: &str) -> UserSendAction {
    if is_stop_command(text) {
        return UserSendAction::Stop;
    }
    if status == AgentStatus::Working {
        UserSendAction::Redirect
    } else {
        UserSendAction::Start
    }
}

const JUDGMENT_MARKERS: &[&str] = &[
    "should i",
    "may i",
    "can i proceed",
    "is that ok",
    "is this ok",
    "do you want me to",
    "approve",
    "confirm",
    "진행할까요",
    "해도 될까요",
    "보낼까요",
    "실행할까요",
    "삭제할까요",
    "승인",
    "확인해도",
];

/// A question that should surface as an allow-once / deny card, not a
/// generic bubble. Ordinary factual questions do not match.
pub fn looks_like_judgment_question(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return false;
    }
    let lower = trimmed.to_lowercase();
    JUDGMENT_MARKERS.iter().any(|m| lower.contains(m))
}

pub fn needs_approval(status: AgentStatus, last_assistant: &str) -> bool {
    status == AgentStatus::Blocked || looks_like_judgment_question(last_assistant)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stop_vs_queue_vs_redirect() {
        assert_eq!(
            user_send_action(AgentStatus::Working, "hello"),
            UserSendAction::Redirect
        );
        assert_eq!(
            user_send_action(AgentStatus::Idle, "hello"),
            UserSendAction::Start
        );
        assert_eq!(
            user_send_action(AgentStatus::Blocked, "continue"),
            UserSendAction::Start
        );
        assert_eq!(
            user_send_action(AgentStatus::Working, "stop now"),
            UserSendAction::Stop
        );
        assert_eq!(
            user_send_action(AgentStatus::Idle, "멈춰"),
            UserSendAction::Stop
        );
        assert_eq!(
            user_send_action(AgentStatus::Working, "don't stop"),
            UserSendAction::Redirect
        );
        assert_eq!(
            user_send_action(AgentStatus::Working, "Stop."),
            UserSendAction::Stop
        );
    }

    #[test]
    fn stop_phrases() {
        assert!(is_stop_command("  STOP NOW  "));
        assert!(is_stop_command("cancel"));
        assert!(is_stop_command("중지해"));
        assert!(!is_stop_command("please stop the build later"));
        assert!(!is_stop_command(""));
    }

    #[test]
    fn judgment_questions_not_generic_ones() {
        assert!(looks_like_judgment_question(
            "Should I send this email to the customer?"
        ));
        assert!(looks_like_judgment_question("이 변경을 실행할까요?"));
        assert!(looks_like_judgment_question("Need you to approve the budget."));
        assert!(!looks_like_judgment_question("What time is the meeting?"));
        assert!(!looks_like_judgment_question("here is the report"));
        assert!(!looks_like_judgment_question(""));
        assert!(needs_approval(
            AgentStatus::Blocked,
            "waiting on a password"
        ));
        assert!(!needs_approval(AgentStatus::Idle, "here is the report"));
        assert!(needs_approval(
            AgentStatus::Idle,
            "May I proceed with the delete?"
        ));
    }
}
