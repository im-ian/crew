use crate::config::AgentConfig;

/// 1:1 `@teammate` ids that should receive a real `tell` (not the current bot).
pub fn one_on_one_tell_targets(text: &str, self_id: &str, roster: &[AgentConfig]) -> Vec<String> {
    crate::config::mentioned_teammate_ids(text, self_id, roster)
}

/// How many bot-to-bot relays a single user message may set off. A bot can call
/// `crew tell` on its way through a turn, so two bots can hand the same thread
/// back and forth forever, each hop costing a real CLI turn.
pub const MAX_RELAY_HOPS: u32 = 4;

/// Where a turn's reply should land after the speaker finishes.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TurnOrigin {
    pub from: String,
    pub reply_agent: Option<String>,
    pub routine: Option<String>,
    /// Relays between this turn and the user message that started the chain.
    pub hops: u32,
    /// The turn's one wake of the bot waiting on it is used up, by the wake or
    /// by a stop. Output the turn leaves behind cannot wake that bot again.
    pub wake_spent: bool,
}

impl TurnOrigin {
    pub fn user() -> Self {
        Self {
            from: "user".into(),
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
/// Handoff / system blocks that may sit under the marker are skipped.
pub fn origin_from_envelope(text: &str) -> TurnOrigin {
    for line in text.lines() {
        let line = line.trim();
        let Some(inner) = line
            .strip_prefix("[crew ")
            .and_then(|s| s.strip_suffix(']'))
        else {
            continue;
        };
        if inner.starts_with("handoff") || inner.starts_with("system") {
            continue;
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
    }
    TurnOrigin::user()
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
/// bot-to-bot tell still posts back to the bot who asked.
pub fn inherit_origin(parent: Option<&TurnOrigin>, mut child: TurnOrigin) -> TurnOrigin {
    child.hops = parent.map(|p| p.hops + 1).unwrap_or(0);
    if child.reply_agent.is_none() {
        if let Some(agent) = parent.and_then(|p| p.reply_agent.clone()) {
            child.reply_agent = Some(agent);
        }
    }
    if child.reply_agent.is_none()
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
    pub agent: Option<String>,
}

/// Where the speaker's sealed assistant text should be copied.
pub fn postback_targets(origin: &TurnOrigin, speaker: &str) -> Postback {
    let agent = origin
        .reply_agent
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty() && *s != speaker && *s != "user")
        .map(str::to_string);
    Postback { agent }
}

/// The bot to wake with the speaker's reply: one that ran `crew tell` itself
/// and is waiting on the answer. A user's @mention, or a reply passed on to the
/// chat a chain started in, waits for that chat's next prompt instead.
pub fn waiting_asker(origin: &TurnOrigin, speaker: &str) -> Option<String> {
    postback_targets(origin, speaker)
        .agent
        .filter(|asker| *asker == origin.from)
}

/// A turn the user did not ask for, that has already been relayed too far.
pub fn relay_exhausted(origin: &TurnOrigin) -> bool {
    origin.hops > MAX_RELAY_HOPS
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

    fn bot_hop(parent: &TurnOrigin) -> TurnOrigin {
        inherit_origin(
            Some(parent),
            TurnOrigin {
                from: "beta".into(),
                ..TurnOrigin::default()
            },
        )
    }

    #[test]
    fn relay_hops_count_from_the_user_message() {
        let start = inherit_origin(None, TurnOrigin::user());
        assert_eq!(start.hops, 0);
        let mut cur = start;
        for n in 1..=MAX_RELAY_HOPS {
            cur = bot_hop(&cur);
            assert_eq!(cur.hops, n);
            assert!(!relay_exhausted(&cur), "hop {n} should still run");
        }
        assert!(relay_exhausted(&bot_hop(&cur)));
    }

    #[test]
    fn only_the_bot_that_told_waits_for_the_reply() {
        let told = bot_hop(&TurnOrigin::user());
        assert_eq!(waiting_asker(&told, "gamma").as_deref(), Some("beta"));
        assert_eq!(
            waiting_asker(&TurnOrigin::mention_tell("alpha"), "beta"),
            None
        );
        // The user @mentioned beta in alpha's chat and beta passed it on. The
        // reply goes to alpha's chat, but alpha did not run the tell, so it is
        // not woken; beta is not woken either, since the reply is not sent to it.
        let passed = bot_hop(&TurnOrigin::mention_tell("alpha"));
        assert_eq!(passed.reply_agent.as_deref(), Some("alpha"));
        assert_eq!(waiting_asker(&passed, "gamma"), None);
    }

    #[test]
    fn one_on_one_tells_skip_self() {
        let r = roster();
        assert_eq!(
            one_on_one_tell_targets("please @beta and @gamma", "alpha", &r),
            vec!["beta", "gamma"]
        );
        assert!(one_on_one_tell_targets("no mentions", "alpha", &r).is_empty());
        assert!(one_on_one_tell_targets("email me@beta.com", "alpha", &r).is_empty());
    }

    #[test]
    fn origin_from_envelope_markers() {
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
        let o = origin_from_envelope("[crew from:user]\n[crew handoff from:beta]\nok\nhello");
        assert_eq!(o.from, "user");
        assert!(o.reply_agent.is_none());
        let o = origin_from_envelope("[crew handoff from:beta]\nok\nplease continue");
        assert_eq!(o, TurnOrigin::user());
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
        let mention = TurnOrigin::mention_tell("alpha");
        assert_eq!(
            postback_targets(&mention, "beta"),
            Postback {
                agent: Some("alpha".into()),
            }
        );
        assert_eq!(postback_targets(&mention, "alpha"), Postback { agent: None });
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
