use crate::protocol::channel_envelope;

pub const RECENT_LIMIT: usize = 12;
pub const LINE_LIMIT: usize = 240;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WakeLine<'a> {
    pub id: &'a str,
    pub from: &'a str,
    pub text: &'a str,
}

/// Prompt injected into a member when a channel message wakes them.
/// The `[crew channel:…]` marker stays first so origin parsing still works.
///
/// `after_id` is the last channel message this member already received in a
/// wake prompt. Lines at or before it are omitted so they are not compounded
/// into the CLI session on every wake. `None` uses the latest `RECENT_LIMIT`
/// window (first wake, or after a session reset).
pub fn wake_text(
    channel_id: &str,
    channel_name: &str,
    brief: Option<&str>,
    recent: &[WakeLine<'_>],
    after_id: Option<&str>,
    from: &str,
    text: &str,
) -> String {
    let mut out = channel_envelope(channel_id, from, "");
    let name = channel_name.trim();
    if !name.is_empty() && name != channel_id {
        out.push_str("Channel: ");
        out.push_str(name);
        out.push('\n');
    }
    if let Some(brief) = brief.map(str::trim).filter(|s| !s.is_empty()) {
        out.push_str("Brief:\n");
        out.push_str(brief);
        out.push('\n');
    }
    let current = text.trim();
    let earlier = earlier_lines(recent, after_id, from, current);
    if !earlier.is_empty() {
        out.push_str("Earlier in this channel:\n");
        out.push_str(&earlier.join("\n"));
        out.push('\n');
    }
    out.push('\n');
    out.push_str(text);
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

fn earlier_lines(
    recent: &[WakeLine<'_>],
    after_id: Option<&str>,
    from: &str,
    current: &str,
) -> Vec<String> {
    let start = after_id
        .and_then(|id| recent.iter().rposition(|line| line.id == id))
        .map(|i| i + 1)
        .unwrap_or(0);
    recent[start..]
        .iter()
        .rev()
        .filter(|line| !line.text.trim().is_empty())
        .take(RECENT_LIMIT)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .filter(|line| line.from != from || line.text.trim() != current)
        .map(|line| {
            format!(
                "- {}: {}",
                display_from(line.from),
                clip(line.text.trim(), LINE_LIMIT)
            )
        })
        .collect()
}

fn display_from(from: &str) -> &str {
    let t = from.trim();
    if t.is_empty() {
        "user"
    } else {
        t
    }
}

fn clip(s: &str, n: usize) -> String {
    let mut chars = s.chars();
    let out: String = chars.by_ref().take(n).collect();
    if chars.next().is_some() {
        format!("{out}…")
    } else {
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_stays_first_and_current_is_last() {
        let text = wake_text("room", "room", None, &[], None, "user", "hello");
        assert!(text.starts_with("[crew channel:room from:user]\n"));
        assert!(text.ends_with("hello\n"));
        assert!(!text.contains("Brief:"));
        assert!(!text.contains("Earlier"));
    }

    #[test]
    fn includes_brief_and_earlier_not_the_current_line() {
        let recent = [
            WakeLine {
                id: "1",
                from: "user",
                text: "can you review the hero",
            },
            WakeLine {
                id: "2",
                from: "alpha",
                text: "I changed the type",
            },
            WakeLine {
                id: "3",
                from: "user",
                text: "ship it today",
            },
        ];
        let text = wake_text(
            "launch",
            "Launch",
            Some("  landing page this week  "),
            &recent,
            None,
            "user",
            "ship it today",
        );
        assert!(text.starts_with("[crew channel:launch from:user]\n"));
        assert!(text.contains("Channel: Launch\n"));
        assert!(text.contains("Brief:\nlanding page this week\n"));
        assert!(text.contains("- user: can you review the hero"));
        assert!(text.contains("- alpha: I changed the type"));
        assert!(!text.contains("- user: ship it today"));
        assert!(text.ends_with("ship it today\n"));
    }

    #[test]
    fn clips_long_lines_and_keeps_the_latest_window() {
        let long = "x".repeat(LINE_LIMIT + 8);
        let mut recent = Vec::new();
        let owned: Vec<(String, String, String)> = (0..20)
            .map(|i| (format!("id{i}"), format!("u{i}"), format!("msg {i}")))
            .collect();
        for (id, from, text) in &owned {
            recent.push(WakeLine { id, from, text });
        }
        recent.push(WakeLine {
            id: "now",
            from: "user",
            text: &long,
        });
        let text = wake_text("room", "room", None, &recent, None, "user", "now");
        assert!(!text.contains("msg 0"));
        assert!(text.contains("msg 19"));
        let clipped = format!("{}…", "x".repeat(LINE_LIMIT));
        assert!(text.contains(&clipped), "{text}");
        assert!(!text.contains(&long));
    }

    #[test]
    fn skips_lines_already_injected_on_a_prior_wake() {
        let recent = [
            WakeLine {
                id: "1",
                from: "user",
                text: "old",
            },
            WakeLine {
                id: "2",
                from: "alpha",
                text: "seen",
            },
            WakeLine {
                id: "3",
                from: "user",
                text: "new",
            },
        ];
        let text = wake_text("room", "room", None, &recent, Some("2"), "user", "new");
        assert!(!text.contains("- user: old"));
        assert!(!text.contains("- alpha: seen"));
        assert!(!text.contains("Earlier"));
        assert!(text.ends_with("new\n"));
        let again = wake_text("room", "room", None, &recent, Some("3"), "user", "new");
        assert!(!again.contains("Earlier"));
    }
}
