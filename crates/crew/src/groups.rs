use std::fs;
use std::path::Path;

use anyhow::bail;
use serde::{Deserialize, Serialize};

use crate::paths;

/// Saved order of bots that sit in no folder. Not a group a person named.
pub const UNGROUPED_ID: &str = "__ungrouped";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SidebarGroup {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub collapsed: bool,
    #[serde(default)]
    pub items: Vec<String>,
    /// Folder bound to a project. Empty for an ordinary group.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
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
    let mut groups: Vec<SidebarGroup> = serde_json::from_str(trimmed)?;
    drop_channel_items(&mut groups);
    Ok(groups)
}

/// Old sidebar folders could point at a group chat. Those chats are gone,
/// so a `channel:` key would render as an empty row.
fn drop_channel_items(groups: &mut [SidebarGroup]) {
    for group in groups {
        group.items.retain(|item| !item.starts_with("channel:"));
    }
}

/// Append a folder. `name` gains a ` 2` suffix when that name is taken.
/// Each bot is removed from every other folder, including `__ungrouped`,
/// so it sits in the new one only.
pub fn add_group(
    groups: &mut Vec<SidebarGroup>,
    name: &str,
    bot_ids: &[String],
    now_ms: u128,
) -> anyhow::Result<SidebarGroup> {
    let name = name.trim();
    if name.is_empty() {
        bail!("group name is empty");
    }
    let name = unique_group_name(groups, name);
    let id = new_group_id(groups, now_ms);
    let mut items = Vec::new();
    for bot in bot_ids {
        let key = format!("agent:{bot}");
        if items.iter().any(|item: &String| item == &key) {
            continue;
        }
        for group in groups.iter_mut() {
            group.items.retain(|item| item != &key);
        }
        items.push(key);
    }
    let created = SidebarGroup {
        id,
        name,
        collapsed: false,
        items,
        path: None,
    };
    groups.push(created.clone());
    Ok(created)
}

fn unique_group_name(groups: &[SidebarGroup], base: &str) -> String {
    let taken: std::collections::HashSet<&str> = groups.iter().map(|g| g.name.as_str()).collect();
    if !taken.contains(base) {
        return base.to_string();
    }
    let mut n = 2u32;
    loop {
        let cand = format!("{base} {n}");
        if !taken.contains(cand.as_str()) {
            return cand;
        }
        n += 1;
    }
}

fn new_group_id(groups: &[SidebarGroup], now_ms: u128) -> String {
    let taken: std::collections::HashSet<&str> = groups.iter().map(|g| g.id.as_str()).collect();
    let base = format!("g{now_ms:x}");
    if !taken.contains(base.as_str()) {
        return base;
    }
    let mut n = 2u32;
    loop {
        let cand = format!("{base}-{n}");
        if !taken.contains(cand.as_str()) {
            return cand;
        }
        n += 1;
    }
}

pub fn save_to(path: &Path, groups: &[SidebarGroup]) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut groups = groups.to_vec();
    drop_channel_items(&mut groups);
    let raw = serde_json::to_string_pretty(&groups)?;
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
            path: None,
        }];
        save_to(&path, &groups).unwrap();
        let loaded = load_from(&path).unwrap();
        assert_eq!(loaded[0].id, "g1");
        assert_eq!(loaded[0].items, vec!["agent:grok".to_string()]);
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

    #[test]
    fn add_group_moves_bots_and_uniquifies_the_name() {
        let mut groups = vec![
            SidebarGroup {
                id: UNGROUPED_ID.into(),
                name: String::new(),
                collapsed: false,
                items: vec!["agent:a2".into()],
                path: None,
            },
            SidebarGroup {
                id: "g1".into(),
                name: "작업".into(),
                collapsed: false,
                items: vec!["agent:a1".into(), "channel:room".into()],
                path: None,
            },
        ];
        let created = add_group(
            &mut groups,
            "작업",
            &["a1".into(), "a2".into(), "a1".into()],
            0xabc,
        )
        .unwrap();
        assert_eq!(created.id, "gabc");
        assert_eq!(created.name, "작업 2");
        assert_eq!(
            created.items,
            vec!["agent:a1".to_string(), "agent:a2".to_string()]
        );
        assert_eq!(groups[0].items, Vec::<String>::new());
        assert_eq!(groups[1].items, vec!["channel:room".to_string()]);
        assert_eq!(groups[2].id, "gabc");
    }

    #[test]
    fn add_group_rejects_a_blank_name_and_avoids_a_taken_id() {
        let mut groups = vec![SidebarGroup {
            id: "g1".into(),
            name: "개인".into(),
            collapsed: false,
            items: vec![],
            path: None,
        }];
        assert!(add_group(&mut groups, "  ", &[], 1).is_err());
        assert_eq!(groups.len(), 1);
        let created = add_group(&mut groups, "다른", &[], 1).unwrap();
        assert_eq!(created.id, "g1-2");
        assert_eq!(created.name, "다른");
    }

    #[test]
    fn a_project_folder_roundtrips_and_an_old_group_has_none() {
        let plain: Vec<SidebarGroup> =
            serde_json::from_str(r#"[{"id":"g1","name":"개인"}]"#).unwrap();
        assert_eq!(plain[0].path, None);
        let dir = std::env::temp_dir().join(format!("crew-groups-path-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("groups.json");
        let groups = vec![SidebarGroup {
            id: "g1".into(),
            name: "app".into(),
            collapsed: false,
            items: vec![],
            path: Some("/tmp/app".into()),
        }];
        save_to(&path, &groups).unwrap();
        let loaded = load_from(&path).unwrap();
        assert_eq!(loaded[0].path.as_deref(), Some("/tmp/app"));
        let raw = fs::read_to_string(&path).unwrap();
        assert!(raw.contains("/tmp/app"));
        let _ = fs::remove_file(&path);
        let _ = fs::remove_dir(&dir);
    }

    #[test]
    fn load_drops_channel_items() {
        let groups: Vec<SidebarGroup> = serde_json::from_str(
            r#"[{"id":"g1","name":"작업","items":["agent:grok","channel:room"]}]"#,
        )
        .unwrap();
        let mut groups = groups;
        drop_channel_items(&mut groups);
        assert_eq!(groups[0].items, vec!["agent:grok".to_string()]);
    }
}
