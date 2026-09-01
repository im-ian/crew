use crate::protocol::channel_envelope;

pub const RECENT_LIMIT: usize = 12;
pub const LINE_LIMIT: usize = 240;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WakeLine<'a> {
    pub from: &'a str,
    pub text: &'a str,
}

/// Prompt injected into a member when a channel message wakes them.
/// The `[crew channel:…]` marker stays first so origin parsing still works.
pub fn wake_text(
    channel_id: &str,
    channel_name: &str,
    brief: Option<&str>,
    recent: &[WakeLine<'_>],
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
    let earlier: Vec<String> = recent
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
        .collect();
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
        let text = wake_text("room", "room", None, &[], "user", "hello");
        assert!(text.starts_with("[crew channel:room from:user]\n"));
        assert!(text.ends_with("hello\n"));
        assert!(!text.contains("Brief:"));
        assert!(!text.contains("Earlier"));
    }

    #[test]
    fn includes_brief_and_earlier_not_the_current_line() {
        let recent = [
            WakeLine {
                from: "user",
                text: "can you review the hero",
            },
            WakeLine {
                from: "alpha",
                text: "I changed the type",
            },
            WakeLine {
                from: "user",
                text: "ship it today",
            },
        ];
        let text = wake_text(
            "launch",
            "Launch",
            Some("  landing page this week  "),
            &recent,
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
        let owned: Vec<(String, String)> = (0..20)
            .map(|i| (format!("u{i}"), format!("msg {i}")))
            .collect();
        for (from, text) in &owned {
            recent.push(WakeLine { from, text });
        }
        recent.push(WakeLine {
            from: "user",
            text: &long,
        });
        let text = wake_text("room", "room", None, &recent, "user", "now");
        assert!(!text.contains("msg 0"));
        assert!(text.contains("msg 19"));
        let clipped = format!("{}…", "x".repeat(LINE_LIMIT));
        assert!(text.contains(&clipped), "{text}");
        assert!(!text.contains(&long));
    }
}
