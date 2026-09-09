use anyhow::bail;
use serde_json::Value;

use crate::protocol::{ChoiceCard, ChoiceOption, ChoiceQuestion, ChoiceState};

pub fn is_ask_tool(name: &str) -> bool {
    let lower = name
        .trim()
        .replace('-', "_")
        .to_ascii_lowercase();
    lower.ends_with("ask_user_question") || lower.ends_with("askuserquestion")
}

pub fn from_tool_detail(detail: &str) -> Option<ChoiceCard> {
    let raw = detail.trim();
    if raw.is_empty() {
        return None;
    }
    let v: Value = serde_json::from_str(raw).ok()?;
    from_value(&v)
}

pub fn split_from_text(text: &str) -> (String, Option<ChoiceCard>) {
    if let Some((rest, card)) = split_fence(text) {
        return (rest, Some(card));
    }
    if let Some((rest, card)) = split_lettered(text) {
        return (rest, Some(card));
    }
    (text.to_string(), None)
}

pub fn card_from_cli(question: &str, options: &[String]) -> anyhow::Result<ChoiceCard> {
    let question = question.trim();
    if question.is_empty() {
        bail!("ask needs a question");
    }
    let mut opts = Vec::new();
    for (i, raw) in options.iter().enumerate() {
        let Some(opt) = parse_cli_option(raw, i) else {
            bail!("ask option is empty");
        };
        opts.push(opt);
    }
    if opts.len() < 2 {
        bail!("ask needs at least two --option values");
    }
    Ok(ChoiceCard {
        id: String::new(),
        questions: vec![ChoiceQuestion {
            question: question.to_string(),
            header: None,
            options: opts,
            multi: false,
            selected: Vec::new(),
        }],
        state: ChoiceState::Pending,
    })
}

fn parse_cli_option(raw: &str, i: usize) -> Option<ChoiceOption> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let (label, description) = if let Some((a, b)) = raw.split_once(": ") {
        (a.trim(), Some(b.trim()).filter(|s| !s.is_empty()).map(str::to_string))
    } else if let Some((a, b)) = raw.split_once(" — ") {
        (a.trim(), Some(b.trim()).filter(|s| !s.is_empty()).map(str::to_string))
    } else {
        (raw, None)
    };
    if label.is_empty() {
        return None;
    }
    Some(ChoiceOption {
        id: letter_id(i),
        label: label.to_string(),
        description: description.filter(|d| d != label),
    })
}

pub fn format_answer(card: &ChoiceCard) -> String {
    let mut lines = Vec::new();
    for q in &card.questions {
        let labels: Vec<String> = q
            .selected
            .iter()
            .filter_map(|id| q.options.iter().find(|o| &o.id == id).map(option_answer))
            .collect();
        if labels.is_empty() {
            continue;
        }
        lines.push(format!("{} → {}", q.question, labels.join(", ")));
    }
    lines.join("\n")
}

pub fn apply_answers(card: &mut ChoiceCard, answers: &[Vec<String>], closed: bool) {
    if closed {
        card.state = ChoiceState::Closed;
        return;
    }
    for (i, q) in card.questions.iter_mut().enumerate() {
        let picked = answers.get(i).cloned().unwrap_or_default();
        q.selected = picked
            .into_iter()
            .filter(|id| q.options.iter().any(|o| &o.id == id))
            .collect();
        if !q.multi && q.selected.len() > 1 {
            q.selected.truncate(1);
        }
    }
    if card.questions.iter().all(|q| q.selected.is_empty()) {
        return;
    }
    card.state = ChoiceState::Answered;
}

/// Question + options as plain lines, for a peer who cannot click the card.
pub fn plain_text(card: &ChoiceCard) -> String {
    let mut out = String::new();
    for q in &card.questions {
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        out.push_str(&q.question);
        for (i, o) in q.options.iter().enumerate() {
            out.push('\n');
            out.push_str(&letter_id(i));
            out.push_str(". ");
            let body = o
                .description
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(o.label.as_str());
            out.push_str(body);
        }
    }
    out
}

fn option_answer(o: &ChoiceOption) -> String {
    match o.description.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(d) if d != o.label => format!("{} — {}", o.label, d),
        _ => o.label.clone(),
    }
}

fn from_value(v: &Value) -> Option<ChoiceCard> {
    let questions = if let Some(arr) = v.get("questions").and_then(Value::as_array) {
        arr.clone()
    } else if v.get("question").is_some() {
        vec![v.clone()]
    } else {
        return None;
    };
    let parsed: Vec<ChoiceQuestion> = questions.iter().filter_map(parse_question).collect();
    if parsed.is_empty() {
        return None;
    }
    Some(ChoiceCard {
        id: String::new(),
        questions: parsed,
        state: ChoiceState::Pending,
    })
}

fn parse_question(v: &Value) -> Option<ChoiceQuestion> {
    let question = v
        .get("question")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if question.is_empty() {
        return None;
    }
    let header = v
        .get("header")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let multi = v
        .get("multi_select")
        .or_else(|| v.get("multiSelect"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let options = v.get("options").and_then(Value::as_array)?;
    let mut out = Vec::new();
    for (i, opt) in options.iter().enumerate() {
        if let Some(o) = parse_json_option(opt, i) {
            out.push(o);
        }
    }
    if out.len() < 2 {
        return None;
    }
    Some(ChoiceQuestion {
        question: question.to_string(),
        header,
        options: out,
        multi,
        selected: Vec::new(),
    })
}

fn parse_json_option(v: &Value, i: usize) -> Option<ChoiceOption> {
    if let Some(s) = v.as_str() {
        let s = s.trim();
        if s.is_empty() {
            return None;
        }
        let id = letter_id(i);
        return Some(ChoiceOption {
            id: id.clone(),
            label: id,
            description: Some(s.to_string()),
        });
    }
    let label = v
        .get("label")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let description = v
        .get("description")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    if label.is_empty() && description.is_none() {
        return None;
    }
    let label = if label.is_empty() {
        letter_id(i)
    } else {
        label.to_string()
    };
    Some(ChoiceOption {
        id: letter_id(i),
        label,
        description,
    })
}

fn letter_id(i: usize) -> String {
    if i < 26 {
        ((b'A' + i as u8) as char).to_string()
    } else {
        (i + 1).to_string()
    }
}

fn split_fence(text: &str) -> Option<(String, ChoiceCard)> {
    let start = text.find("```crew-ask")?;
    let after = &text[start + "```crew-ask".len()..];
    let after = after.strip_prefix('\n').unwrap_or(after);
    let end = after.find("```")?;
    let body = after[..end].trim();
    let rest = format!(
        "{}\n{}",
        text[..start].trim_end(),
        after[end + 3..].trim_start()
    )
    .trim()
    .to_string();
    let card = if let Some(card) = from_tool_detail(body) {
        card
    } else {
        let (_, card) = split_lettered(body)?;
        card
    };
    Some((rest, card))
}

fn split_lettered(text: &str) -> Option<(String, ChoiceCard)> {
    let lines: Vec<&str> = text.lines().collect();
    let mut end = lines.len();
    while end > 0 && lines[end - 1].trim().is_empty() {
        end -= 1;
    }
    let mut opts = Vec::new();
    let mut i = end;
    while i > 0 {
        if let Some(opt) = parse_option_line(lines[i - 1]) {
            opts.push(opt);
            i -= 1;
        } else {
            break;
        }
    }
    opts.reverse();
    if opts.len() < 2 || !ids_consecutive(&opts) {
        return None;
    }
    let mut q_idx = i;
    while q_idx > 0 && lines[q_idx - 1].trim().is_empty() {
        q_idx -= 1;
    }
    if q_idx == 0 {
        return None;
    }
    let question = lines[q_idx - 1].trim();
    if question.is_empty() {
        return None;
    }
    let lettered = opts
        .iter()
        .all(|o| o.id.chars().all(|c| c.is_ascii_alphabetic()));
    let numbered = opts
        .iter()
        .all(|o| o.id.chars().all(|c| c.is_ascii_digit()));
    if !lettered && !numbered {
        return None;
    }
    if lettered && opts[0].id != "A" {
        return None;
    }
    if numbered && opts[0].id != "1" {
        return None;
    }
    if !looks_like_ask(question) {
        return None;
    }
    let rest = lines[..q_idx - 1].join("\n").trim().to_string();
    Some((
        rest,
        ChoiceCard {
            id: String::new(),
            questions: vec![ChoiceQuestion {
                question: question.to_string(),
                header: None,
                options: opts,
                multi: false,
                selected: Vec::new(),
            }],
            state: ChoiceState::Pending,
        },
    ))
}

fn parse_option_line(line: &str) -> Option<ChoiceOption> {
    let t = line.trim();
    let t = t
        .strip_prefix("- ")
        .or_else(|| t.strip_prefix("* "))
        .unwrap_or(t)
        .trim();
    let bytes = t.as_bytes();
    if bytes.is_empty() {
        return None;
    }
    let (id, rest) = if bytes[0].is_ascii_alphabetic() {
        (t[..1].to_ascii_uppercase(), &t[1..])
    } else if bytes[0].is_ascii_digit() {
        let n = bytes.iter().take_while(|b| b.is_ascii_digit()).count();
        if n == 0 || n > 2 {
            return None;
        }
        (t[..n].to_string(), &t[n..])
    } else {
        return None;
    };
    let rest = rest.trim_start();
    // Skip `:`; `key: value` lines are ordinary prose, not a picker.
    let rest = rest
        .strip_prefix('.')
        .or_else(|| rest.strip_prefix(')'))
        .or_else(|| rest.strip_prefix('、'))?;
    let desc = rest.trim();
    let description = if desc.is_empty() || desc == id {
        None
    } else {
        Some(desc.to_string())
    };
    Some(ChoiceOption {
        id: id.clone(),
        label: id,
        description,
    })
}

fn looks_like_ask(question: &str) -> bool {
    let q = question.trim();
    if q.is_empty() {
        return false;
    }
    let lower = q.to_ascii_lowercase();
    [
        "which", "pick", "choose", "select", "option",
        "고르", "어느", "어떤", "선택", "골라",
    ]
    .iter()
    .any(|h| lower.contains(h) || q.contains(h))
}

fn ids_consecutive(opts: &[ChoiceOption]) -> bool {
    if opts.len() < 2 {
        return false;
    }
    if opts.iter().all(|o| o.id.len() == 1 && o.id.chars().all(|c| c.is_ascii_alphabetic())) {
        let start = opts[0].id.as_bytes()[0];
        return opts.iter().enumerate().all(|(i, o)| {
            o.id.as_bytes()[0] == start.wrapping_add(i as u8)
        });
    }
    if opts.iter().all(|o| o.id.chars().all(|c| c.is_ascii_digit())) {
        let Ok(start) = opts[0].id.parse::<usize>() else {
            return false;
        };
        return opts.iter().enumerate().all(|(i, o)| {
            o.id.parse::<usize>().ok() == Some(start + i)
        });
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grok_tool_payload() {
        let card = from_tool_detail(
            r#"{"questions":[{"question":"어느 쪽을 고를래?","header":"Pick","options":[{"label":"A","description":"A"},{"label":"B","description":"B"},{"label":"C","description":"C"}]}]}"#,
        )
        .expect("card");
        assert_eq!(card.questions.len(), 1);
        assert_eq!(card.questions[0].question, "어느 쪽을 고를래?");
        assert_eq!(card.questions[0].options.len(), 3);
        assert_eq!(card.questions[0].options[2].id, "C");
    }

    #[test]
    fn claude_tool_payload_and_multi() {
        let card = from_tool_detail(
            r#"{"questions":[{"question":"Which?","options":[{"label":"Ship it","description":"merge now"},{"label":"Wait"}],"multiSelect":true}]}"#,
        )
        .expect("card");
        assert!(card.questions[0].multi);
        assert_eq!(card.questions[0].options[0].label, "Ship it");
    }

    #[test]
    fn lettered_list_strips_the_question() {
        let (rest, card) = split_from_text(
            "이렇게 A / B / C 고를 수 있어.\n\n어느 쪽을 고를래?\nA. A\nB. B\nC. C\n",
        );
        let card = card.expect("card");
        assert_eq!(rest, "이렇게 A / B / C 고를 수 있어.");
        assert_eq!(card.questions[0].question, "어느 쪽을 고를래?");
        assert_eq!(
            card.questions[0]
                .options
                .iter()
                .map(|o| o.id.as_str())
                .collect::<Vec<_>>(),
            ["A", "B", "C"]
        );
    }

    #[test]
    fn numbered_steps_without_a_question_are_not_a_picker() {
        let (rest, card) = split_from_text("Do this:\n1. clone\n2. build\n3. test\n");
        assert!(card.is_none(), "{rest}");
    }

    #[test]
    fn numbered_options_after_a_question_are_a_picker() {
        let (_, card) = split_from_text("Which one?\n1. red\n2. blue\n");
        let card = card.expect("card");
        assert_eq!(card.questions[0].options[1].description.as_deref(), Some("blue"));
    }

    #[test]
    fn a_question_plus_numbered_steps_is_not_a_picker() {
        let (_, card) = split_from_text("Did you see the error?\n1. clone\n2. build\n3. test\n");
        assert!(card.is_none());
    }

    #[test]
    fn lettered_key_value_lines_are_not_a_picker() {
        let (_, card) = split_from_text("Done:\n- x: 3\n- y: 4\n");
        assert!(card.is_none());
        let (_, card) = split_from_text("Files changed:\nA. src/a.rs\nB. src/b.rs\n");
        assert!(card.is_none());
    }

    #[test]
    fn apply_empty_answers_stays_pending() {
        let mut card = from_tool_detail(
            r#"{"question":"어느 쪽을 고를래?","options":[{"label":"A"},{"label":"B"}]}"#,
        )
        .unwrap();
        apply_answers(&mut card, &[vec!["nope".into()]], false);
        assert_eq!(card.state, ChoiceState::Pending);
    }

    #[test]
    fn fence_json() {
        let (rest, card) = split_from_text(
            "pick below\n\n```crew-ask\n{\"question\":\"Side?\",\"options\":[\"left\",\"right\"]}\n```\n",
        );
        let card = card.expect("card");
        assert_eq!(rest, "pick below");
        assert_eq!(card.questions[0].question, "Side?");
        assert_eq!(card.questions[0].options.len(), 2);
    }

    #[test]
    fn format_and_apply() {
        let mut card = from_tool_detail(
            r#"{"question":"어느 쪽을 고를래?","options":[{"label":"A"},{"label":"B"},{"label":"C"}]}"#,
        )
        .unwrap();
        apply_answers(&mut card, &[vec!["C".into()]], false);
        assert_eq!(card.state, ChoiceState::Answered);
        assert_eq!(format_answer(&card), "어느 쪽을 고를래? → C");
        apply_answers(&mut card, &[], true);
        assert_eq!(card.state, ChoiceState::Closed);
    }

    #[test]
    fn ask_tool_names() {
        assert!(is_ask_tool("ask_user_question"));
        assert!(is_ask_tool("AskUserQuestion"));
        assert!(is_ask_tool("ask-user-question"));
        assert!(is_ask_tool("mcp__foo__AskUserQuestion"));
        assert!(!is_ask_tool("Read"));
    }

    #[test]
    fn cli_question_and_options() {
        let card = card_from_cli(
            "어느 쪽을 고를래?",
            &["A".into(), "B: wait".into(), "Ship it: merge now".into()],
        )
        .unwrap();
        assert_eq!(card.questions[0].question, "어느 쪽을 고를래?");
        assert_eq!(card.questions[0].options[0].label, "A");
        assert_eq!(card.questions[0].options[1].description.as_deref(), Some("wait"));
        assert_eq!(card.questions[0].options[2].label, "Ship it");
        assert!(card_from_cli("Q", &["only-one".into()]).is_err());
        assert!(card_from_cli("", &["A".into(), "B".into()]).is_err());
    }
}
