use crate::protocol::AgentStatus;

/// What to do with a user 1:1 send.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UserSendAction {
    /// Agent is idle (or blocked waiting on us): start a new turn.
    Start,
    /// Agent is working and the user steered: kill the in-flight turn, then
    /// start this prompt ahead of what was waiting.
    Redirect,
    /// Explicit stop: end the in-flight turn, do not start a new one.
    Stop,
}

pub fn is_stop_command(text: &str) -> bool {
    let t = crate::rows::reply_body(text)
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

pub fn user_send_action(status: AgentStatus, text: &str, steer: bool) -> UserSendAction {
    if is_stop_command(text) {
        return UserSendAction::Stop;
    }
    // A follow-up while working is queued by submit_delivery, unless steered.
    if steer && status == AgentStatus::Working {
        UserSendAction::Redirect
    } else {
        UserSendAction::Start
    }
}

/// A user follow-up queues if the bot is busy, or cuts in when steered. A
/// bot-originated post always enqueues. Explicit stop phrases end the
/// in-flight turn.
pub fn member_turn_action(
    from_user: bool,
    status: AgentStatus,
    text: &str,
    steer: bool,
) -> UserSendAction {
    if from_user {
        user_send_action(status, text, steer)
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
    let trimmed = crate::rows::reply_body(text).trim();
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
            user_send_action(AgentStatus::Working, "hello", false),
            UserSendAction::Start
        );
        assert_eq!(
            user_send_action(AgentStatus::Idle, "hello", false),
            UserSendAction::Start
        );
        assert_eq!(
            user_send_action(AgentStatus::Blocked, "continue", false),
            UserSendAction::Start
        );
        assert_eq!(
            user_send_action(AgentStatus::Working, "stop now", false),
            UserSendAction::Stop
        );
        assert_eq!(
            user_send_action(AgentStatus::Idle, "멈춰", false),
            UserSendAction::Stop
        );
        assert_eq!(
            user_send_action(AgentStatus::Working, "don't stop", false),
            UserSendAction::Start
        );
        assert_eq!(
            user_send_action(AgentStatus::Working, "Stop.", false),
            UserSendAction::Stop
        );
    }

    #[test]
    fn a_steer_redirects_only_a_working_bot() {
        assert_eq!(
            user_send_action(AgentStatus::Working, "do this instead", true),
            UserSendAction::Redirect
        );
        assert_eq!(
            user_send_action(AgentStatus::Idle, "hello", true),
            UserSendAction::Start
        );
        assert_eq!(
            user_send_action(AgentStatus::Blocked, "continue", true),
            UserSendAction::Start
        );
        assert_eq!(
            user_send_action(AgentStatus::Working, "멈춰", true),
            UserSendAction::Stop
        );
        assert_eq!(
            member_turn_action(false, AgentStatus::Working, "follow up", true),
            UserSendAction::Start
        );
    }

    #[test]
    fn user_send_queues_working_member() {
        assert_eq!(
            member_turn_action(true, AgentStatus::Working, "follow up", false),
            UserSendAction::Start
        );
        assert_eq!(
            member_turn_action(true, AgentStatus::Working, "stop now", false),
            UserSendAction::Stop
        );
        assert_eq!(
            member_turn_action(false, AgentStatus::Working, "follow up", false),
            UserSendAction::Start
        );
        assert_eq!(
            member_turn_action(true, AgentStatus::Idle, "hello", false),
            UserSendAction::Start
        );
    }

    #[test]
    fn stop_phrases() {
        assert!(is_stop_command("  STOP NOW  "));
        assert!(is_stop_command("cancel"));
        assert!(is_stop_command("중지해"));
        assert!(!is_stop_command("please stop the build later"));
        assert!(!is_stop_command(""));
        assert!(is_stop_command(
            "[crew reply:1-2 from:alice]\nkeep going\n\nstop"
        ));
        assert!(!is_stop_command(
            "[crew reply:1-2 from:alice]\nstop\n\nkeep going"
        ));
    }

    #[test]
    fn judgment_questions_not_generic_ones() {
        assert!(looks_like_judgment_question(
            "Should I send this email to the customer?"
        ));
        assert!(looks_like_judgment_question("이 변경을 실행할까요?"));
        assert!(looks_like_judgment_question(
            "Need you to approve the budget."
        ));
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
