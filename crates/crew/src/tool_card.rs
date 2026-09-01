use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolCard {
    pub name: String,
    pub detail: String,
}

/// Pull a collapsed tool-card from grok/claude/codex streaming JSON.
pub fn from_event(v: &Value) -> Option<ToolCard> {
    let ty = v.get("type").and_then(Value::as_str).unwrap_or("");
    if ty == "tool_call" || ty == "tool_call_update" {
        let name = v
            .get("toolName")
            .or_else(|| v.get("tool_name"))
            .or_else(|| v.get("name"))
            .or_else(|| v.get("title"))
            .and_then(Value::as_str)
            .unwrap_or("tool");
        let detail = v
            .get("title")
            .and_then(Value::as_str)
            .or_else(|| v.get("kind").and_then(Value::as_str))
            .unwrap_or("")
            .to_string();
        return Some(ToolCard {
            name: name.to_string(),
            detail,
        });
    }
    if ty == "content_block_start" || ty == "content_block" {
        let block = v.get("content_block").or_else(|| v.get("content")).unwrap_or(v);
        if block.get("type").and_then(Value::as_str) == Some("tool_use") {
            let name = block
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("tool");
            return Some(ToolCard {
                name: name.to_string(),
                detail: String::new(),
            });
        }
    }
    if ty == "item" {
        if v.get("item")
            .and_then(|i| i.get("type"))
            .and_then(Value::as_str)
            == Some("tool")
            || v.get("item")
                .and_then(|i| i.get("type"))
                .and_then(Value::as_str)
                == Some("command")
        {
            let item = v.get("item").unwrap_or(v);
            let name = item
                .get("name")
                .or_else(|| item.get("command"))
                .and_then(Value::as_str)
                .unwrap_or("tool");
            return Some(ToolCard {
                name: name.to_string(),
                detail: item
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            });
        }
    }
    None
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
        let card = from_event(&v).expect("card");
        assert_eq!(card.name, "read_file");
        assert_eq!(card.detail, "Read file");
    }

    #[test]
    fn text_event_is_not_a_card() {
        let v: Value = serde_json::from_str(r#"{"type":"text","text":"hello"}"#).unwrap();
        assert!(from_event(&v).is_none());
    }
}
