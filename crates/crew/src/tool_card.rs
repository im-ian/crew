use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolCard {
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
    let name = first_str(v, &["toolName", "tool_name", "name", "title"]).unwrap_or("tool");
    let detail = v
        .get("content")
        .map(value_detail)
        .filter(|s| !s.is_empty())
        .or_else(|| v.get("input").map(value_detail).filter(|s| !s.is_empty()))
        .or_else(|| first_str(v, &["title", "kind"]).map(|s| s.to_string()))
        .unwrap_or_default();
    Some(ToolCard {
        name: name.to_string(),
        detail,
    })
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
    let name = block
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("tool");
    let detail = block
        .get("input")
        .map(value_detail)
        .unwrap_or_default();
    if detail.is_empty() {
        return None;
    }
    Some(ToolCard {
        name: name.to_string(),
        detail,
    })
}

fn item_tools(v: &Value) -> Vec<ToolCard> {
    if v.get("type").and_then(Value::as_str) != Some("item")
        && v.get("type").and_then(Value::as_str) != Some("item.completed")
        && v.get("type").and_then(Value::as_str) != Some("item.started")
    {
        return Vec::new();
    }
    let item = v.get("item").unwrap_or(v);
    let ty = item.get("type").and_then(Value::as_str).unwrap_or("");
    if ty != "tool" && ty != "command" && ty != "mcp_tool_call" {
        return Vec::new();
    }
    let name = first_str(item, &["name", "command", "tool"]).unwrap_or("tool");
    let detail = item
        .get("input")
        .map(value_detail)
        .filter(|s| !s.is_empty())
        .or_else(|| item.get("arguments").map(value_detail).filter(|s| !s.is_empty()))
        .or_else(|| first_str(item, &["command", "status"]).map(|s| s.to_string()))
        .unwrap_or_default();
    vec![ToolCard {
        name: name.to_string(),
        detail,
    }]
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
    fn grok_tool_call_becomes_card() {
        let v: Value = serde_json::from_str(
            r#"{"type":"tool_call","toolCallId":"1","title":"Read file","toolName":"read_file"}"#,
        )
        .unwrap();
        let card = from_events(&v).into_iter().next().expect("card");
        assert_eq!(card.name, "read_file");
        assert_eq!(card.detail, "Read file");
    }

    #[test]
    fn claude_assistant_tool_use_keeps_input() {
        let v: Value = serde_json::from_str(
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/tmp/a.rs"}}]}}"#,
        )
        .unwrap();
        let card = from_events(&v).into_iter().next().expect("card");
        assert_eq!(card.name, "Read");
        assert!(card.detail.contains("/tmp/a.rs"));
    }

    #[test]
    fn claude_empty_tool_start_is_skipped() {
        let v: Value = serde_json::from_str(
            r#"{"type":"content_block_start","content_block":{"type":"tool_use","name":"Read","input":{}}}"#,
        )
        .unwrap();
        assert!(from_events(&v).is_empty());
    }

    #[test]
    fn text_event_is_not_a_card() {
        let v: Value = serde_json::from_str(r#"{"type":"text","text":"hello"}"#).unwrap();
        assert!(from_events(&v).is_empty());
    }
}
