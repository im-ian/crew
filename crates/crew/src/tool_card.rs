use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolCard {
    /// The CLI's own call id. Every event for one call repeats it, so the
    /// transcript can keep updating a single card instead of stacking rows.
    pub id: Option<String>,
    pub name: String,
    pub detail: String,
}

/// Pull collapsed tool-cards from grok/claude/codex streaming JSON.
pub fn from_events(v: &Value) -> Vec<ToolCard> {
    let event = unwrap_stream(v);
    let mut out = Vec::new();
    if let Some(card) = grok_tool(event) {
        out.push(card);
    }
    out.extend(claude_block_tools(event));
    out.extend(assistant_tools(event));
    out.extend(item_tools(event));
    out
}

fn unwrap_stream(v: &Value) -> &Value {
    if v.get("type").and_then(Value::as_str) == Some("stream_event") {
        v.get("event").unwrap_or(v)
    } else {
        v
    }
}

fn grok_tool(v: &Value) -> Option<ToolCard> {
    let ty = v.get("type").and_then(Value::as_str).unwrap_or("");
    if ty != "tool_call" && ty != "tool_call_update" {
        return None;
    }
    card(
        first_str(v, &["toolCallId", "tool_call_id", "id"]),
        first_str(v, &["toolName", "tool_name", "name", "title"]),
        args_detail(v),
    )
}

fn claude_block_tools(v: &Value) -> Vec<ToolCard> {
    let ty = v.get("type").and_then(Value::as_str).unwrap_or("");
    if ty != "content_block_start" && ty != "content_block" {
        return Vec::new();
    }
    let block = v.get("content_block").or_else(|| v.get("content")).unwrap_or(v);
    tool_use_card(block).into_iter().collect()
}

fn assistant_tools(v: &Value) -> Vec<ToolCard> {
    if v.get("type").and_then(Value::as_str) != Some("assistant") {
        return Vec::new();
    }
    let message = v.get("message").unwrap_or(v);
    let Some(arr) = message.get("content").and_then(Value::as_array) else {
        return Vec::new();
    };
    arr.iter().filter_map(tool_use_card).collect()
}

fn tool_use_card(block: &Value) -> Option<ToolCard> {
    if block.get("type").and_then(Value::as_str) != Some("tool_use") {
        return None;
    }
    card(
        first_str(block, &["id"]),
        first_str(block, &["name"]),
        args_detail(block),
    )
}

fn item_tools(v: &Value) -> Vec<ToolCard> {
    let ty = v.get("type").and_then(Value::as_str).unwrap_or("");
    if ty != "item" && ty != "item.completed" && ty != "item.started" {
        return Vec::new();
    }
    let item = v.get("item").unwrap_or(v);
    let kind = item.get("type").and_then(Value::as_str).unwrap_or("");
    if kind != "tool" && kind != "command" && kind != "mcp_tool_call" {
        return Vec::new();
    }
    let detail = if args_detail(item).is_empty() {
        first_str(item, &["command", "status"]).unwrap_or("").to_string()
    } else {
        args_detail(item)
    };
    card(
        first_str(item, &["id"]),
        first_str(item, &["name", "tool"]).or(Some(kind)),
        detail,
    )
    .into_iter()
    .collect()
}

/// Cards are the call's arguments, not its output: the point of the row is
/// "which tool, called how". A later event for the same id fills in blanks.
fn args_detail(v: &Value) -> String {
    ["rawInput", "raw_input", "input", "arguments", "args"]
        .iter()
        .find_map(|k| v.get(*k).map(value_detail).filter(|s| !s.is_empty()))
        .unwrap_or_default()
}

fn card(id: Option<&str>, name: Option<&str>, detail: String) -> Option<ToolCard> {
    let name = name.unwrap_or_default().to_string();
    if name.is_empty() && detail.is_empty() {
        return None;
    }
    Some(ToolCard {
        id: id.map(str::to_string),
        name,
        detail,
    })
}

fn first_str<'a>(v: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|k| v.get(*k).and_then(Value::as_str))
        .filter(|s| !s.is_empty())
}

fn value_detail(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Object(map) if map.is_empty() => String::new(),
        Value::Array(arr) if arr.is_empty() => String::new(),
        other => serde_json::to_string_pretty(other).unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grok_tool_call_keeps_id_and_args() {
        let v: Value = serde_json::from_str(
            r#"{"type":"tool_call","toolCallId":"call-1","title":"Run","toolName":"run_terminal_command","rawInput":{"command":"echo hi"}}"#,
        )
        .unwrap();
        let card = from_events(&v).into_iter().next().expect("card");
        assert_eq!(card.id.as_deref(), Some("call-1"));
        assert_eq!(card.name, "run_terminal_command");
        assert!(card.detail.contains("echo hi"));
    }

    #[test]
    fn grok_update_without_args_is_dropped() {
        // grok repeats an update per output chunk; each one used to become a
        // nameless "tool" row of its own.
        let v: Value = serde_json::from_str(
            r#"{"type":"tool_call_update","toolCallId":"call-1","status":"completed","content":[{"type":"content","content":{"type":"text","text":"hi\n"}}]}"#,
        )
        .unwrap();
        assert!(from_events(&v).is_empty());
    }

    #[test]
    fn claude_assistant_tool_use_keeps_input() {
        let v: Value = serde_json::from_str(
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"/tmp/a.rs"}}]}}"#,
        )
        .unwrap();
        let card = from_events(&v).into_iter().next().expect("card");
        assert_eq!(card.id.as_deref(), Some("toolu_1"));
        assert_eq!(card.name, "Read");
        assert!(card.detail.contains("/tmp/a.rs"));
    }

    #[test]
    fn claude_tool_start_opens_the_card_the_args_land_in() {
        let v: Value = serde_json::from_str(
            r#"{"type":"content_block_start","content_block":{"type":"tool_use","id":"toolu_1","name":"Read","input":{}}}"#,
        )
        .unwrap();
        let card = from_events(&v).into_iter().next().expect("card");
        assert_eq!(card.id.as_deref(), Some("toolu_1"));
        assert_eq!(card.name, "Read");
        assert!(card.detail.is_empty());
    }

    #[test]
    fn nameless_empty_block_is_not_a_card() {
        let v: Value =
            serde_json::from_str(r#"{"type":"content_block_start","content_block":{"type":"tool_use","input":{}}}"#)
                .unwrap();
        assert!(from_events(&v).is_empty());
    }

    #[test]
    fn text_event_is_not_a_card() {
        let v: Value = serde_json::from_str(r#"{"type":"text","text":"hello"}"#).unwrap();
        assert!(from_events(&v).is_empty());
    }
}
