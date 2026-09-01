use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchHit {
    pub kind: String,
    pub id: String,
    pub title: String,
    pub snippet: String,
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
    pub from: &'a str,
    pub text: &'a str,
}

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
    let mut hits = Vec::new();
    for b in bots {
        if matches_q(&q, &[b.id, b.name, b.role.unwrap_or("")]) {
            hits.push(SearchHit {
                kind: "bot".into(),
                id: b.id.to_string(),
                title: if b.name.is_empty() {
                    b.id.to_string()
                } else {
                    b.name.to_string()
                },
                snippet: b.role.unwrap_or("").to_string(),
            });
        }
    }
    for r in routines {
        if matches_q(&q, &[r.id, r.name, r.prompt, r.agent]) {
            hits.push(SearchHit {
                kind: "routine".into(),
                id: format!("{}:{}", r.agent, r.id),
                title: r.name.to_string(),
                snippet: r.prompt.chars().take(80).collect(),
            });
        }
    }
    for m in messages {
        if matches_q(&q, &[m.from, m.text, m.scope]) {
            hits.push(SearchHit {
                kind: "message".into(),
                id: format!("{}:{}", m.scope, m.id),
                title: m.scope.to_string(),
                snippet: snippet(m.text, &q),
            });
        }
    }
    hits
}

/// Split a message hit id `{scope}:{messageId}` where scope may be `ch:{channel}`.
pub fn parse_message_hit(id: &str) -> Option<(&str, &str)> {
    let (scope, msg) = id.rsplit_once(':')?;
    if scope.is_empty() || msg.is_empty() {
        None
    } else {
        Some((scope, msg))
    }
}

pub fn channel_id_from_scope(scope: &str) -> Option<&str> {
    scope.strip_prefix("ch:").filter(|s| !s.is_empty())
}

fn matches_q(q: &str, fields: &[&str]) -> bool {
    fields.iter().any(|f| f.to_lowercase().contains(q))
}

fn snippet(text: &str, q: &str) -> String {
    let lower = text.to_lowercase();
    let idx = lower.find(q).unwrap_or(0);
    let start = text
        .char_indices()
        .map(|(i, _)| i)
        .take_while(|i| *i + 1 <= idx)
        .last()
        .unwrap_or(0);
    let slice = text.get(start..).unwrap_or(text);
    let clipped: String = slice.chars().take(80).collect();
    clipped
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
        let messages = [SearchMessage {
            scope: "alpha",
            id: "m1",
            from: "user",
            text: "please review the login bug",
        }];
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
        let brief = search("브리핑", &bots, &routines, &messages);
        assert_eq!(brief.len(), 1);
        assert_eq!(brief[0].kind, "routine");
        assert!(search("   ", &bots, &routines, &messages).is_empty());
        assert!(search("nope-xyz", &bots, &routines, &messages).is_empty());
    }

    #[test]
    fn message_hit_id_keeps_channel_scope() {
        let id = format!("{}:{}", "ch:launch", "171000-3");
        let (scope, msg) = parse_message_hit(&id).expect("split");
        assert_eq!(scope, "ch:launch");
        assert_eq!(msg, "171000-3");
        assert_eq!(channel_id_from_scope(scope), Some("launch"));
        let dm = format!("{}:{}", "alpha", "171000-3");
        let (scope, msg) = parse_message_hit(&dm).expect("dm");
        assert_eq!(scope, "alpha");
        assert_eq!(msg, "171000-3");
        assert!(channel_id_from_scope(scope).is_none());
        assert!(parse_message_hit("nocolon").is_none());
        assert!(parse_message_hit(":only").is_none());
    }
}
