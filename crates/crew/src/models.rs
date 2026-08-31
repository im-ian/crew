use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

use crate::config::AgentCli;
use crate::paths;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct ModelList {
    pub models: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
}

const CLAUDE_MODELS: &[&str] = &["sonnet", "opus", "haiku", "fable"];

pub fn list_models(cli: AgentCli) -> anyhow::Result<ModelList> {
    match cli {
        AgentCli::Grok => list_grok_models(),
        AgentCli::Claude => Ok(claude_models()),
        AgentCli::Codex => Ok(list_codex_models()),
    }
}

fn claude_models() -> ModelList {
    ModelList {
        models: CLAUDE_MODELS.iter().map(|s| (*s).to_string()).collect(),
        default: None,
    }
}

fn list_grok_models() -> anyhow::Result<ModelList> {
    let text = capture("grok", &["models"])?;
    let list = parse_grok_models(&text);
    if list.models.is_empty() && list.default.is_none() {
        anyhow::bail!("grok models returned no model ids");
    }
    Ok(list)
}

fn list_codex_models() -> ModelList {
    let home = PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/tmp".into()));
    let codex = home.join(".codex");
    let json = fs::read_to_string(codex.join("models_cache.json")).unwrap_or_default();
    let toml = fs::read_to_string(codex.join("config.toml")).ok();
    parse_codex_models(&json, toml.as_deref())
}

fn capture(program: &str, args: &[&str]) -> anyhow::Result<String> {
    let path = paths::resolve_program(program);
    let output = Command::new(&path)
        .args(args)
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|err| anyhow::anyhow!("{}: {err}", path.display()))?;
    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    if !output.stderr.is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&String::from_utf8_lossy(&output.stderr));
    }
    if !output.status.success() && text.trim().is_empty() {
        anyhow::bail!(
            "{} {} failed with {}",
            path.display(),
            args.join(" "),
            output.status
        );
    }
    Ok(text)
}

pub fn parse_grok_models(text: &str) -> ModelList {
    let mut default = None;
    let mut models = Vec::new();
    let mut in_list = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(rest) = stripped_prefix_ci(trimmed, "Default model:") {
            let id = rest.trim();
            if !id.is_empty() {
                default = Some(id.to_string());
            }
            continue;
        }
        if eq_ignore_ascii(trimmed, "Available models:") {
            in_list = true;
            continue;
        }
        if !in_list {
            continue;
        }
        let rest = trimmed
            .strip_prefix('*')
            .or_else(|| trimmed.strip_prefix('-'))
            .map(str::trim)
            .unwrap_or("");
        if rest.is_empty() {
            continue;
        }
        if let Some(id) = rest.split_whitespace().next() {
            push_unique(&mut models, id);
        }
    }
    if let Some(id) = default.as_deref() {
        if !models.iter().any(|m| m == id) {
            models.insert(0, id.to_string());
        }
    }
    ModelList { models, default }
}

pub fn parse_codex_models(json: &str, config_toml: Option<&str>) -> ModelList {
    let default = config_toml.and_then(parse_codex_default_model);
    if json.trim().is_empty() {
        return ModelList {
            models: Vec::new(),
            default,
        };
    }
    let cache: CodexCache = match serde_json::from_str(json) {
        Ok(cache) => cache,
        Err(_) => {
            return ModelList {
                models: Vec::new(),
                default,
            };
        }
    };
    let mut models = Vec::new();
    for item in cache.models {
        if item.slug.trim().is_empty() {
            continue;
        }
        if item.visibility.as_deref() == Some("hide") {
            continue;
        }
        push_unique(&mut models, item.slug.trim());
    }
    if let Some(id) = default.as_deref() {
        if !models.iter().any(|m| m == id) {
            models.insert(0, id.to_string());
        }
    }
    ModelList { models, default }
}

fn parse_codex_default_model(toml: &str) -> Option<String> {
    for line in toml.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') {
            break;
        }
        let Some(rest) = line.strip_prefix("model") else {
            continue;
        };
        let rest = rest.trim_start();
        let Some(rest) = rest.strip_prefix('=') else {
            continue;
        };
        let value = rest.trim().trim_matches('"').trim_matches('\'').trim();
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}

fn push_unique(models: &mut Vec<String>, id: &str) {
    if id.is_empty() {
        return;
    }
    if !models.iter().any(|m| m == id) {
        models.push(id.to_string());
    }
}

fn stripped_prefix_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    if s.len() < prefix.len() {
        return None;
    }
    if s.get(..prefix.len())
        .is_some_and(|head| eq_ignore_ascii(head, prefix))
    {
        Some(&s[prefix.len()..])
    } else {
        None
    }
}

fn eq_ignore_ascii(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

#[derive(Deserialize)]
struct CodexCache {
    #[serde(default)]
    models: Vec<CodexModel>,
}

#[derive(Deserialize)]
struct CodexModel {
    slug: String,
    #[serde(default)]
    visibility: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grok_models_parses_default_and_list() {
        let text = "\
You are logged in with grok.com.

Default model: grok-4.6

Available models:
  * grok-4.6 (default)
  - grok-4.5
";
        let list = parse_grok_models(text);
        assert_eq!(list.default.as_deref(), Some("grok-4.6"));
        assert_eq!(list.models, vec!["grok-4.6", "grok-4.5"]);
    }

    #[test]
    fn grok_models_inserts_default_when_list_omits_it() {
        let text = "\
Default model: grok-4.6

Available models:
  - grok-4.5
";
        let list = parse_grok_models(text);
        assert_eq!(list.models, vec!["grok-4.6", "grok-4.5"]);
    }

    #[test]
    fn grok_models_ignores_noise_before_list() {
        let list = parse_grok_models("hello\n- not-a-model\n");
        assert!(list.models.is_empty());
        assert!(list.default.is_none());
    }

    #[test]
    fn grok_models_lists_from_installed_cli() {
        if !crate::paths::resolve_program("grok").is_file() {
            return;
        }
        let list = list_grok_models().expect("grok models");
        assert!(
            !list.models.is_empty(),
            "expected grok models, got {list:?}"
        );
    }

    #[test]
    fn claude_exposes_cli_aliases() {
        let list = claude_models();
        assert!(list.models.contains(&"sonnet".into()));
        assert!(list.models.contains(&"opus".into()));
        assert!(list.models.contains(&"fable".into()));
        assert!(list.default.is_none());
    }

    #[test]
    fn codex_models_reads_visible_slugs_and_config_default() {
        let json = r#"{
            "models": [
                {"slug": "gpt-5.6-sol", "visibility": "list"},
                {"slug": "gpt-5.4", "visibility": "list"},
                {"slug": "codex-auto-review", "visibility": "hide"}
            ]
        }"#;
        let toml = "model = \"gpt-5.6-sol\"\nmodel_reasoning_effort = \"max\"\n\n[tui]\nmodel = \"ignored\"\n";
        let list = parse_codex_models(json, Some(toml));
        assert_eq!(list.default.as_deref(), Some("gpt-5.6-sol"));
        assert_eq!(list.models, vec!["gpt-5.6-sol", "gpt-5.4"]);
    }

    #[test]
    fn codex_models_survives_empty_or_invalid_cache() {
        let empty = parse_codex_models("", Some("model = \"o3\"\n"));
        assert_eq!(empty.default.as_deref(), Some("o3"));
        assert!(empty.models.is_empty());
        let bad = parse_codex_models("{nope", None);
        assert!(bad.models.is_empty());
        assert!(bad.default.is_none());
    }
}
