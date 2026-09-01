use crate::config::{mention_tokens, resolve_mention, AgentConfig};

/// `@everyone` / `@all` / `@here` / `@channel` address the whole room.
pub fn is_everyone_token(token: &str) -> bool {
    matches!(
        token.to_ascii_lowercase().as_str(),
        "everyone" | "all" | "here" | "channel"
    )
}

/// Who to wake in a channel for `text`.
///
/// - `@everyone` (or `@all` / `@here` / `@channel`) wakes every `members` id
/// - `@`-mentions that resolve to members wake those members, in mention order
/// - no mention: if `default_one` is set, wake `last_speaker` when they are
///   still a member, otherwise the first member; if `default_one` is false
///   (bot-originated posts), wake nobody
pub fn channel_wake_targets(
    text: &str,
    members: &[String],
    roster: &[AgentConfig],
    last_speaker: Option<&str>,
    default_one: bool,
) -> Vec<String> {
    if members.is_empty() {
        return Vec::new();
    }
    let member_set: std::collections::HashSet<&str> =
        members.iter().map(|s| s.as_str()).collect();
    let mut mentioned = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut everyone = false;
    for token in mention_tokens(text) {
        if is_everyone_token(&token) {
            everyone = true;
            continue;
        }
        if let Some(id) = resolve_mention(&token, "", roster) {
            if member_set.contains(id.as_str()) && seen.insert(id.clone()) {
                mentioned.push(id);
            }
        }
    }
    if everyone {
        return members.to_vec();
    }
    if !mentioned.is_empty() {
        return mentioned;
    }
    if !default_one {
        return Vec::new();
    }
    pick_one_member(members, last_speaker)
}

fn pick_one_member(members: &[String], last_speaker: Option<&str>) -> Vec<String> {
    if let Some(id) = last_speaker {
        if members.iter().any(|m| m == id) {
            return vec![id.to_string()];
        }
    }
    members
        .first()
        .cloned()
        .map(|id| vec![id])
        .unwrap_or_default()
}

/// 1:1 `@teammate` ids that should receive a real `tell` (not the current bot).
pub fn one_on_one_tell_targets(
    text: &str,
    self_id: &str,
    roster: &[AgentConfig],
) -> Vec<String> {
    crate::config::mentioned_teammate_ids(text, self_id, roster)
}

/// Where a turn's reply should land after the speaker finishes.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TurnOrigin {
    pub from: String,
    pub reply_channel: Option<String>,
    pub reply_agent: Option<String>,
    pub routine: Option<String>,
}

impl TurnOrigin {
    pub fn user() -> Self {
        Self {
            from: "user".into(),
            ..Self::default()
        }
    }

    pub fn channel(channel: &str, from: &str) -> Self {
        Self {
            from: from.to_string(),
            reply_channel: Some(channel.to_string()),
            ..Self::default()
        }
    }

    pub fn mention_tell(current_agent: &str) -> Self {
        Self {
            from: "user".into(),
            reply_agent: Some(current_agent.to_string()),
            ..Self::default()
        }
    }

    pub fn routine(name: &str) -> Self {
        Self {
            from: "user".into(),
            routine: Some(name.to_string()),
            ..Self::default()
        }
    }
}

/// Parse the first `[crew …]` marker of an injected envelope.
pub fn origin_from_envelope(text: &str) -> TurnOrigin {
    let first = text.lines().next().unwrap_or("").trim();
    let Some(inner) = first
        .strip_prefix("[crew ")
        .and_then(|s| s.strip_suffix(']'))
    else {
        return TurnOrigin::user();
    };
    if let Some(rest) = inner.strip_prefix("channel:") {
        let (channel, from) = split_channel_from(rest);
        return TurnOrigin {
            from,
            reply_channel: Some(channel),
            ..TurnOrigin::default()
        };
    }
    if let Some(from) = inner.strip_prefix("from:") {
        let from = envelope_from(from);
        return TurnOrigin {
            from,
            ..TurnOrigin::default()
        };
    }
    if let Some(name) = inner.strip_prefix("routine:") {
        return TurnOrigin::routine(name.trim());
    }
    TurnOrigin::user()
}

fn split_channel_from(rest: &str) -> (String, String) {
    if let Some((channel, from)) = rest.split_once(" from:") {
        (channel.trim().to_string(), envelope_from(from))
    } else {
        (rest.trim().to_string(), "user".into())
    }
}

fn envelope_from(raw: &str) -> String {
    let t = raw.trim();
    if t.is_empty() {
        "user".into()
    } else {
        t.to_string()
    }
}

/// Fold a sender's in-flight origin into a newly parsed envelope origin so a
/// bot-to-bot tell started from a channel still posts back to that channel.
pub fn inherit_origin(parent: Option<&TurnOrigin>, mut child: TurnOrigin) -> TurnOrigin {
    if child.reply_channel.is_none() {
        if let Some(ch) = parent.and_then(|p| p.reply_channel.clone()) {
            child.reply_channel = Some(ch);
        }
    }
    if child.reply_agent.is_none() {
        if let Some(agent) = parent.and_then(|p| p.reply_agent.clone()) {
            child.reply_agent = Some(agent);
        }
    }
    if child.reply_agent.is_none()
        && child.reply_channel.is_none()
        && child.routine.is_none()
        && child.from != "user"
        && !child.from.is_empty()
    {
        child.reply_agent = Some(child.from.clone());
    }
    child
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Postback {
    pub channel: Option<String>,
    pub agent: Option<String>,
}

/// Where the speaker's sealed assistant text should be copied.
pub fn postback_targets(origin: &TurnOrigin, speaker: &str) -> Postback {
    let channel = origin
        .reply_channel
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let agent = origin
        .reply_agent
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty() && *s != speaker && *s != "user")
        .map(str::to_string);
    Postback { channel, agent }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roster() -> Vec<AgentConfig> {
        vec![
            AgentConfig::new("alpha".into(), "Alpha".into(), vec!["cat".into()], None),
            AgentConfig::new("beta".into(), "Beta".into(), vec!["cat".into()], None),
            AgentConfig::new("gamma".into(), "춘식이".into(), vec!["cat".into()], None),
        ]
    }

    fn members() -> Vec<String> {
        vec!["alpha".into(), "beta".into(), "gamma".into()]
    }

    #[test]
    fn everyone_wakes_all_members() {
        let r = roster();
        let m = members();
        for text in ["@everyone hi", "ping @all", "@here", "hey @channel"] {
            assert_eq!(
                channel_wake_targets(text, &m, &r, None, true),
                m,
                "{text}"
            );
        }
    }

    #[test]
    fn mentioned_members_only() {
        let r = roster();
        let m = members();
        assert_eq!(
            channel_wake_targets("ask @beta then @춘식이.", &m, &r, Some("alpha"), true),
            vec!["beta", "gamma"]
        );
        assert_eq!(
            channel_wake_targets("@alpha take this", &m, &r, None, true),
            vec!["alpha"]
        );
    }

    #[test]
    fn mention_outside_the_room_is_ignored() {
        let r = roster();
        let m = vec!["alpha".into(), "beta".into()];
        assert_eq!(
            channel_wake_targets("loop in @gamma please", &m, &r, None, true),
            vec!["alpha"]
        );
    }

    #[test]
    fn no_mention_wakes_one_member() {
        let r = roster();
        let m = members();
        assert_eq!(
            channel_wake_targets("hello room", &m, &r, None, true),
            vec!["alpha"]
        );
        assert_eq!(
            channel_wake_targets("hello room", &m, &r, Some("gamma"), true),
            vec!["gamma"]
        );
        assert_eq!(
            channel_wake_targets("hello room", &m, &r, Some("nobody"), true),
            vec!["alpha"]
        );
    }

    #[test]
    fn bot_post_without_mention_wakes_nobody() {
        let r = roster();
        let m = members();
        assert!(channel_wake_targets("status update", &m, &r, Some("alpha"), false).is_empty());
        assert_eq!(
            channel_wake_targets("hey @beta check", &m, &r, None, false),
            vec!["beta"]
        );
    }

    #[test]
    fn one_on_one_tells_skip_self() {
        let r = roster();
        assert_eq!(
            one_on_one_tell_targets("please @beta and @춘식이", "alpha", &r),
            vec!["beta", "gamma"]
        );
        assert!(one_on_one_tell_targets("no mentions", "alpha", &r).is_empty());
        assert!(one_on_one_tell_targets("email me@beta.com", "alpha", &r).is_empty());
    }

    #[test]
    fn origin_from_channel_envelope() {
        let o = origin_from_envelope("[crew channel:room from:user]\nhello");
        assert_eq!(o, TurnOrigin::channel("room", "user"));
        let o = origin_from_envelope("[crew from:alpha]\nping");
        assert_eq!(
            o,
            TurnOrigin {
                from: "alpha".into(),
                ..TurnOrigin::default()
            }
        );
        let o = origin_from_envelope("[crew routine:brief]\nstandup");
        assert_eq!(o.routine.as_deref(), Some("brief"));
    }

    #[test]
    fn inherit_keeps_channel_on_bot_tell() {
        let parent = TurnOrigin::channel("room", "user");
        let child = origin_from_envelope("[crew from:alpha]\nplease review");
        let merged = inherit_origin(Some(&parent), child);
        assert_eq!(merged.reply_channel.as_deref(), Some("room"));
        assert_eq!(merged.from, "alpha");
    }

    #[test]
    fn inherit_sets_reply_agent_for_peer_tell() {
        let child = origin_from_envelope("[crew from:alpha]\nplease review");
        let merged = inherit_origin(None, child);
        assert_eq!(merged.reply_agent.as_deref(), Some("alpha"));
        let user = origin_from_envelope("[crew from:user]\nhello");
        let merged = inherit_origin(None, user);
        assert!(merged.reply_agent.is_none());
        let parent = TurnOrigin::mention_tell("alpha");
        let merged = inherit_origin(Some(&parent), origin_from_envelope("[crew from:user]\nhey"));
        assert_eq!(merged.reply_agent.as_deref(), Some("alpha"));
    }

    #[test]
    fn postback_skips_speaker_and_user() {
        let channel = TurnOrigin::channel("room", "user");
        assert_eq!(
            postback_targets(&channel, "beta"),
            Postback {
                channel: Some("room".into()),
                agent: None,
            }
        );
        let mention = TurnOrigin::mention_tell("alpha");
        assert_eq!(
            postback_targets(&mention, "beta"),
            Postback {
                channel: None,
                agent: Some("alpha".into()),
            }
        );
        assert_eq!(
            postback_targets(&mention, "alpha"),
            Postback {
                channel: None,
                agent: None,
            }
        );
        assert_eq!(
            postback_targets(&TurnOrigin::user(), "alpha"),
            Postback::default()
        );
        assert_eq!(
            postback_targets(&TurnOrigin::routine("brief"), "alpha"),
            Postback::default()
        );
    }
}
