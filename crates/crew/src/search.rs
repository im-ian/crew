use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchHit {
    pub kind: String,
    pub id: String,
    pub title: String,
    pub snippet: String,
    /// The bot the hit belongs to, so the list can show its face.
    #[serde(default)]
    pub bot: String,
    /// When a message was written. Zero for bots and routines.
    #[serde(default)]
    pub ts: u64,
}

#[derive(Debug, Clone)]
pub struct SearchBot<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub role: Option<&'a str>,
}

#[derive(Debug, Clone)]
pub struct SearchRoutine<'a> {
    pub agent: &'a str,
    pub id: &'a str,
    pub name: &'a str,
    pub prompt: &'a str,
}

#[derive(Debug, Clone)]
pub struct SearchMessage<'a> {
    pub scope: &'a str,
    pub id: &'a str,
    pub text: &'a str,
    pub ts: u64,
    /// A tool card, so the UI can drop it while tool cards are hidden.
    pub tool: bool,
}

/// Message hits past this many are dropped, newest kept.
const MAX_MESSAGES: usize = 100;
/// Characters kept ahead of the match, so the snippet reads in context.
const LEAD: usize = 24;
const SNIPPET: usize = 120;

pub fn search(
    query: &str,
    bots: &[SearchBot<'_>],
    routines: &[SearchRoutine<'_>],
    messages: &[SearchMessage<'_>],
) -> Vec<SearchHit> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Vec::new();
    }
    let name_of = |id: &str| {
        bots.iter()
            .find(|b| b.id == id)
            .map(|b| if b.name.is_empty() { b.id } else { b.name })
    };
    let mut hits = Vec::new();
    for b in bots {
        if matches_q(&q, &[b.id, b.name, b.role.unwrap_or("")]) {
            hits.push(SearchHit {
                kind: "bot".into(),
                id: b.id.to_string(),
                title: name_of(b.id).unwrap_or(b.id).to_string(),
                snippet: b.role.unwrap_or("").to_string(),
                bot: b.id.to_string(),
                ts: 0,
            });
        }
    }
    for r in routines {
        // A routine of a bot that is gone is not on screen anywhere.
        if name_of(r.agent).is_none() {
            continue;
        }
        if matches_q(&q, &[r.id, r.name, r.prompt]) {
            hits.push(SearchHit {
                kind: "routine".into(),
                id: format!("{}:{}", r.agent, r.id),
                title: r.name.to_string(),
                snippet: snippet(r.prompt, &q),
                bot: r.agent.to_string(),
                ts: 0,
            });
        }
    }
    let mut found = Vec::new();
    for m in messages {
        // A removed bot's chat can linger in memory; only chats in the list count.
        let Some(name) = name_of(m.scope) else {
            continue;
        };
        if matches_q(&q, &[m.text]) {
            found.push(SearchHit {
                kind: if m.tool { "tool" } else { "message" }.into(),
                id: format!("{}:{}", m.scope, m.id),
                title: name.to_string(),
                snippet: snippet(m.text, &q),
                bot: m.scope.to_string(),
                ts: m.ts,
            });
        }
    }
    found.sort_by(|a, b| b.ts.cmp(&a.ts));
    found.truncate(MAX_MESSAGES);
    hits.extend(found);
    hits
}

/// Split a message hit id `{scope}:{messageId}`.
pub fn parse_message_hit(id: &str) -> Option<(&str, &str)> {
    let (scope, msg) = id.rsplit_once(':')?;
    if scope.is_empty() || msg.is_empty() {
        None
    } else {
        Some((scope, msg))
    }
}

fn matches_q(q: &str, fields: &[&str]) -> bool {
    fields.iter().any(|f| f.to_lowercase().contains(q))
}

/// One line of the text around the first match, with a little lead-in.
fn snippet(text: &str, q: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let lower = flat.to_lowercase();
    // Lowercasing keeps the character count for all but a few letters, so the
    // match's character index in `lower` is close enough to `flat`'s.
    let at = lower
        .find(q)
        .map(|i| lower[..i].chars().count())
        .unwrap_or(0);
    let start = at.saturating_sub(LEAD);
    let clipped: String = flat.chars().skip(start).take(SNIPPET).collect();
    if start > 0 {
        format!("…{clipped}")
    } else {
        clipped
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_bots_routines_and_messages() {
        let bots = [SearchBot {
            id: "alpha",
            name: "Alpha",
            role: Some("reviewer"),
        }];
        let routines = [SearchRoutine {
            agent: "alpha",
            id: "r1",
            name: "브리핑",
            prompt: "weekday standup notes",
        }];
        let messages = [
            SearchMessage {
                scope: "alpha",
                id: "m1",
                text: "please review the login bug",
                ts: 1,
                tool: false,
            },
            SearchMessage {
                scope: "alpha",
                id: "m2",
                text: "{\"file_path\":\"login.rs\"}",
                ts: 2,
                tool: true,
            },
        ];
        let bots_hits = search("review", &bots, &routines, &messages);
        assert!(
            bots_hits.iter().any(|h| h.kind == "bot" && h.id == "alpha"),
            "{bots_hits:?}"
        );
        assert!(
            bots_hits
                .iter()
                .any(|h| h.kind == "message" && h.snippet.contains("login")),
            "{bots_hits:?}"
        );
        let file = search("login.rs", &bots, &routines, &messages);
        assert_eq!(file.len(), 1);
        assert_eq!(file[0].kind, "tool");
        let brief = search("브리핑", &bots, &routines, &messages);
        assert_eq!(brief.len(), 1);
        assert_eq!(brief[0].kind, "routine");
        assert!(search("   ", &bots, &routines, &messages).is_empty());
        assert!(search("nope-xyz", &bots, &routines, &messages).is_empty());
    }

    #[test]
    fn skips_chats_of_bots_not_in_the_list() {
        let bots = [SearchBot {
            id: "alpha",
            name: "Alpha",
            role: None,
        }];
        let routines = [SearchRoutine {
            agent: "gone",
            id: "r1",
            name: "daily",
            prompt: "1초 report",
        }];
        let msg = |scope, id, text, ts| SearchMessage {
            scope,
            id,
            text,
            ts,
            tool: false,
        };
        let messages = [
            msg("gone", "m1", "1초 뒤에 다시", 3),
            msg("alpha", "m2", "older 1초", 1),
            msg("alpha", "m3", "newer 1초", 2),
        ];
        let hits = search("1초", &bots, &routines, &messages);
        let ids: Vec<_> = hits.iter().map(|h| h.id.as_str()).collect();
        assert_eq!(ids, ["alpha:m3", "alpha:m2"], "{hits:?}");
        assert!(hits.iter().all(|h| h.title == "Alpha" && h.bot == "alpha"));
        assert_eq!(hits[0].ts, 2);
    }

    #[test]
    fn snippet_leads_in_and_flattens_lines() {
        let text = format!("{}\nthe 1초 limit", "x".repeat(60));
        let got = snippet(&text, "1초");
        assert!(got.starts_with('…'), "{got}");
        assert!(got.contains("x the 1초 limit"), "{got}");
        assert_eq!(snippet("short 1초", "1초"), "short 1초");
    }

    #[test]
    fn message_hit_id_splits_scope_and_message() {
        let id = format!("{}:{}", "alpha", "171000-3");
        let (scope, msg) = parse_message_hit(&id).expect("split");
        assert_eq!(scope, "alpha");
        assert_eq!(msg, "171000-3");
        assert!(parse_message_hit("nocolon").is_none());
        assert!(parse_message_hit(":only").is_none());
    }
}
