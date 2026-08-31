use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::paths;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SidebarGroup {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub collapsed: bool,
    #[serde(default)]
    pub items: Vec<String>,
}

pub fn load() -> anyhow::Result<Vec<SidebarGroup>> {
    load_from(&paths::groups_path())
}

pub fn save(groups: &[SidebarGroup]) -> anyhow::Result<()> {
    paths::ensure_home()?;
    save_to(&paths::groups_path(), groups)
}

pub fn load_from(path: &Path) -> anyhow::Result<Vec<SidebarGroup>> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(path)?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    Ok(serde_json::from_str(trimmed)?)
}

pub fn save_to(path: &Path, groups: &[SidebarGroup]) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let raw = serde_json::to_string_pretty(groups)?;
    fs::write(path, raw + "\n")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_is_empty() {
        let dir = std::env::temp_dir().join(format!("crew-groups-{}", std::process::id()));
        let path = dir.join("missing.json");
        let _ = fs::remove_file(&path);
        assert!(load_from(&path).unwrap().is_empty());
    }

    #[test]
    fn roundtrip() {
        let dir = std::env::temp_dir().join(format!("crew-groups-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("groups.json");
        let groups = vec![SidebarGroup {
            id: "g1".into(),
            name: "작업".into(),
            collapsed: true,
            items: vec!["agent:grok".into(), "channel:room".into()],
        }];
        save_to(&path, &groups).unwrap();
        assert_eq!(load_from(&path).unwrap(), groups);
        let _ = fs::remove_file(&path);
        let _ = fs::remove_dir(&dir);
    }

    #[test]
    fn defaults_collapsed_and_items() {
        let groups: Vec<SidebarGroup> =
            serde_json::from_str(r#"[{"id":"g1","name":"개인"}]"#).unwrap();
        assert!(!groups[0].collapsed);
        assert!(groups[0].items.is_empty());
    }
}
