use anyhow::bail;
use serde_json::Value;

use crate::protocol::{ChoiceCard, ChoiceField, ChoiceOption, ChoiceQuestion, ChoiceState};

pub fn is_ask_tool(name: &str) -> bool {
    let lower = name.trim().replace('-', "_").to_ascii_lowercase();
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

pub fn card_from_cli(
    question: &str,
    options: &[String],
    inputs: &[String],
    hint: Option<&str>,
) -> anyhow::Result<ChoiceCard> {
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
    let mut fields = Vec::new();
    for (i, raw) in inputs.iter().enumerate() {
        let Some(field) = parse_cli_input(raw, i) else {
            bail!("ask input is empty");
        };
        fields.push(field);
    }
    if opts.len() == 1 {
        bail!("ask needs at least two --option values");
    }
    if opts.is_empty() && fields.is_empty() {
        bail!("ask needs --input or at least two --option values");
    }
    let hint = hint
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    Ok(ChoiceCard {
        id: String::new(),
        questions: vec![ChoiceQuestion {
            question: question.to_string(),
            header: None,
            hint,
            options: opts,
            fields,
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
        (
            a.trim(),
            Some(b.trim()).filter(|s| !s.is_empty()).map(str::to_string),
        )
    } else if let Some((a, b)) = raw.split_once(" — ") {
        (
            a.trim(),
            Some(b.trim()).filter(|s| !s.is_empty()).map(str::to_string),
        )
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

fn parse_cli_input(raw: &str, i: usize) -> Option<ChoiceField> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let (label, value) = if let Some((a, b)) = raw.split_once(": ") {
        (a.trim(), b.trim())
    } else if let Some((a, b)) = raw.split_once('=') {
        (a.trim(), b.trim())
    } else {
        (raw, "")
    };
    if label.is_empty() {
        return None;
    }
    Some(ChoiceField {
        id: field_id(i),
        label: label.to_string(),
        value: value.to_string(),
        secret: looks_secret(label),
        required: true,
    })
}

pub fn format_answer(card: &ChoiceCard) -> String {
    format_answer_inner(card, false)
}

/// Same as [`format_answer`], but secret field values are replaced with dots.
pub fn format_answer_masked(card: &ChoiceCard) -> String {
    format_answer_inner(card, true)
}

fn format_answer_inner(card: &ChoiceCard, mask: bool) -> String {
    let mut lines = Vec::new();
    for q in &card.questions {
        let labels: Vec<String> = q
            .selected
            .iter()
            .filter_map(|id| q.options.iter().find(|o| &o.id == id).map(option_answer))
            .collect();
        let fields: Vec<String> = q
            .fields
            .iter()
            .filter(|f| f.required || !f.value.trim().is_empty())
            .map(|f| {
                let value = if mask && f.secret {
                    "••••••"
                } else {
                    f.value.as_str()
                };
                format!("{}: {}", f.label, value)
            })
            .collect();
        if labels.is_empty() && fields.is_empty() {
            if q.fields.is_empty() {
                continue;
            }
            lines.push(q.question.clone());
            continue;
        }
        if fields.is_empty() {
            lines.push(format!("{} → {}", q.question, labels.join(", ")));
            continue;
        }
        lines.push(q.question.clone());
        if !labels.is_empty() {
            lines.push(format!("→ {}", labels.join(", ")));
        }
        lines.extend(fields);
    }
    lines.join("\n")
}

pub fn apply_answers(
    card: &mut ChoiceCard,
    answers: &[Vec<String>],
    values: &[Vec<String>],
    closed: bool,
) {
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
        if let Some(vals) = values.get(i) {
            for (j, f) in q.fields.iter_mut().enumerate() {
                if let Some(v) = vals.get(j) {
                    f.value = v.clone();
                }
            }
        }
    }
    if is_complete(card) {
        card.state = ChoiceState::Answered;
    }
}

pub fn is_complete(card: &ChoiceCard) -> bool {
    if card.questions.is_empty() {
        return false;
    }
    card.questions.iter().all(question_complete) && card.questions.iter().any(question_answered)
}

fn question_complete(q: &ChoiceQuestion) -> bool {
    let fields_ok = q
        .fields
        .iter()
        .all(|f| !f.required || !f.value.trim().is_empty());
    let opts_ok = q.options.is_empty() || !q.selected.is_empty();
    fields_ok && opts_ok
}

fn question_answered(q: &ChoiceQuestion) -> bool {
    !q.selected.is_empty()
        || q.fields.iter().any(|f| !f.value.trim().is_empty())
        || (!q.fields.is_empty() && q.fields.iter().all(|f| !f.required))
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
    match o
        .description
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
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
    let hint = v
        .get("hint")
        .or_else(|| v.get("text"))
        .or_else(|| v.get("description"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let multi = v
        .get("multi_select")
        .or_else(|| v.get("multiSelect"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let options = v.get("options").and_then(Value::as_array);
    let mut out = Vec::new();
    if let Some(options) = options {
        for (i, opt) in options.iter().enumerate() {
            if let Some(o) = parse_json_option(opt, i) {
                out.push(o);
            }
        }
    }
    let fields = parse_fields(v);
    if out.len() < 2 && fields.is_empty() {
        return None;
    }
    Some(ChoiceQuestion {
        question: question.to_string(),
        header,
        hint,
        options: out,
        fields,
        multi,
        selected: Vec::new(),
    })
}

fn parse_fields(v: &Value) -> Vec<ChoiceField> {
    let arr = v
        .get("fields")
        .or_else(|| v.get("inputs"))
        .and_then(Value::as_array);
    let Some(arr) = arr else {
        return Vec::new();
    };
    arr.iter()
        .enumerate()
        .filter_map(|(i, f)| parse_json_field(f, i))
        .collect()
}

fn parse_json_field(v: &Value, i: usize) -> Option<ChoiceField> {
    if let Some(s) = v.as_str() {
        return parse_cli_input(s, i);
    }
    let label = v
        .get("label")
        .or_else(|| v.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if label.is_empty() {
        return None;
    }
    let value = v
        .get("value")
        .or_else(|| v.get("default"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let typed_secret = v
        .get("type")
        .and_then(Value::as_str)
        .map(|s| s.eq_ignore_ascii_case("password"))
        .unwrap_or(false);
    let secret = v.get("secret").and_then(Value::as_bool).unwrap_or(false)
        || typed_secret
        || looks_secret(label);
    let required = v.get("required").and_then(Value::as_bool).unwrap_or(true);
    Some(ChoiceField {
        id: field_id(i),
        label: label.to_string(),
        value,
        secret,
        required,
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
    let label = v.get("label").and_then(Value::as_str).unwrap_or("").trim();
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

fn field_id(i: usize) -> String {
    format!("i{}", i + 1)
}

fn looks_secret(label: &str) -> bool {
    let lower = label.to_ascii_lowercase();
    lower.contains("password")
        || lower.contains("passwd")
        || lower.contains("secret")
        || label.contains("비밀번호")
        || label.contains("비번")
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
                hint: None,
                options: opts,
                fields: Vec::new(),
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
        "which", "pick", "choose", "select", "option", "고르", "어느", "어떤", "선택", "골라",
    ]
    .iter()
    .any(|h| lower.contains(h) || q.contains(h))
}

fn ids_consecutive(opts: &[ChoiceOption]) -> bool {
    if opts.len() < 2 {
        return false;
    }
    if opts
        .iter()
        .all(|o| o.id.len() == 1 && o.id.chars().all(|c| c.is_ascii_alphabetic()))
    {
        let start = opts[0].id.as_bytes()[0];
        return opts
            .iter()
            .enumerate()
            .all(|(i, o)| o.id.as_bytes()[0] == start.wrapping_add(i as u8));
    }
    if opts
        .iter()
        .all(|o| o.id.chars().all(|c| c.is_ascii_digit()))
    {
        let Ok(start) = opts[0].id.parse::<usize>() else {
            return false;
        };
        return opts
            .iter()
            .enumerate()
            .all(|(i, o)| o.id.parse::<usize>().ok() == Some(start + i));
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
        assert_eq!(
            card.questions[0].options[1].description.as_deref(),
            Some("blue")
        );
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
        apply_answers(&mut card, &[vec!["nope".into()]], &[], false);
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
    fn fence_json_fields() {
        let (rest, card) = split_from_text(
            "fill in\n\n```crew-ask\n{\"question\":\"로그인\",\"fields\":[\"아이디\",\"비밀번호\"]}\n```\n",
        );
        let card = card.expect("card");
        assert_eq!(rest, "fill in");
        assert!(card.questions[0].options.is_empty());
        assert_eq!(card.questions[0].fields[0].label, "아이디");
        assert!(card.questions[0].fields[1].secret);
    }

    #[test]
    fn format_and_apply() {
        let mut card = from_tool_detail(
            r#"{"question":"어느 쪽을 고를래?","options":[{"label":"A"},{"label":"B"},{"label":"C"}]}"#,
        )
        .unwrap();
        apply_answers(&mut card, &[vec!["C".into()]], &[], false);
        assert_eq!(card.state, ChoiceState::Answered);
        assert_eq!(format_answer(&card), "어느 쪽을 고를래? → C");
        apply_answers(&mut card, &[], &[], true);
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
            &[],
            None,
        )
        .unwrap();
        assert_eq!(card.questions[0].question, "어느 쪽을 고를래?");
        assert_eq!(card.questions[0].options[0].label, "A");
        assert_eq!(
            card.questions[0].options[1].description.as_deref(),
            Some("wait")
        );
        assert_eq!(card.questions[0].options[2].label, "Ship it");
        assert!(card_from_cli("Q", &["only-one".into()], &[], None).is_err());
        assert!(card_from_cli("Q", &["only-one".into()], &["아이디".into()], None).is_err());
        assert!(card_from_cli("", &["A".into(), "B".into()], &[], None).is_err());
    }

    #[test]
    fn cli_inputs_without_options() {
        let card = card_from_cli(
            "로그인",
            &[],
            &[
                "아이디: jtfliverecovery".into(),
                "비밀번호=ChangeMe123!".into(),
            ],
            Some("이 계정으로 로그인해주세요."),
        )
        .unwrap();
        let q = &card.questions[0];
        assert_eq!(q.question, "로그인");
        assert_eq!(q.hint.as_deref(), Some("이 계정으로 로그인해주세요."));
        assert!(q.options.is_empty());
        assert_eq!(q.fields.len(), 2);
        assert_eq!(q.fields[0].label, "아이디");
        assert_eq!(q.fields[0].value, "jtfliverecovery");
        assert!(!q.fields[0].secret);
        assert_eq!(q.fields[1].label, "비밀번호");
        assert_eq!(q.fields[1].value, "ChangeMe123!");
        assert!(q.fields[1].secret);
        assert!(q.fields[1].required);
        assert!(card_from_cli("Q", &[], &[], None).is_err());
        assert!(card_from_cli("Q", &[], &["".into()], None).is_err());
    }

    #[test]
    fn tool_payload_with_fields() {
        let card = from_tool_detail(
            r#"{"question":"로그인","hint":"Empty 계정으로 로그인해주세요.","fields":[{"label":"아이디","value":"jtfliverecovery"},{"label":"비밀번호","type":"password"}]}"#,
        )
        .expect("card");
        assert!(card.questions[0].options.is_empty());
        assert_eq!(card.questions[0].fields.len(), 2);
        assert_eq!(
            card.questions[0].hint.as_deref(),
            Some("Empty 계정으로 로그인해주세요.")
        );
        assert!(card.questions[0].fields[1].secret);
        let mut card = card;
        apply_answers(
            &mut card,
            &[],
            &[vec!["user".into(), "secret".into()]],
            false,
        );
        assert_eq!(card.state, ChoiceState::Answered);
        assert_eq!(
            format_answer(&card),
            "로그인\n아이디: user\n비밀번호: secret"
        );
    }

    #[test]
    fn missing_required_input_is_not_complete() {
        let mut card =
            from_tool_detail(r#"{"question":"이름","inputs":[{"label":"이름"}]}"#).unwrap();
        apply_answers(&mut card, &[], &[vec!["".into()]], false);
        assert_eq!(card.state, ChoiceState::Pending);
        assert!(!is_complete(&card));
        apply_answers(&mut card, &[], &[vec!["Ada".into()]], false);
        assert!(is_complete(&card));
        assert_eq!(format_answer(&card), "이름\n이름: Ada");
    }

    #[test]
    fn optional_empty_fields_are_complete() {
        let mut card =
            from_tool_detail(r#"{"question":"메모","fields":[{"label":"메모","required":false}]}"#)
                .unwrap();
        apply_answers(&mut card, &[], &[vec!["".into()]], false);
        assert!(is_complete(&card));
        assert_eq!(card.state, ChoiceState::Answered);
        assert_eq!(format_answer(&card), "메모");
    }

    #[test]
    fn masked_answer_hides_secret_values() {
        let mut card = from_tool_detail(
            r#"{"question":"로그인","fields":[{"label":"아이디","value":"ada"},{"label":"비밀번호","type":"password","value":"s3cret"}]}"#,
        )
        .unwrap();
        apply_answers(
            &mut card,
            &[],
            &[vec!["ada".into(), "s3cret".into()]],
            false,
        );
        assert_eq!(
            format_answer(&card),
            "로그인\n아이디: ada\n비밀번호: s3cret"
        );
        assert_eq!(
            format_answer_masked(&card),
            "로그인\n아이디: ada\n비밀번호: ••••••"
        );
    }
}
