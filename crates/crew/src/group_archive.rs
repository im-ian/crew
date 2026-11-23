//! Archived groups: a group put away with its bots, kept so it can come back.
//!
//! Archiving takes the group off the sidebar and its bots off the daemon (no
//! process, no roster, no routine ticking, no tell) and keeps everything the
//! bots were: their configs, with each routine's own on or off, are in
//! `archived-groups.json`, and their chats, memory, pins, avatars, session
//! ids and worktrees stay where they are. Restoring puts the configs back.
//!
//! Not `$CREW_HOME/archive`, which holds the chats a user cleared.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::config::AgentConfig;
use crate::groups::SidebarGroup;
use crate::paths;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArchivedGroup {
    /// The group as it was: its id, name, bots in order, folder, lead.
    pub group: SidebarGroup,
    /// The bots, as `agents.json` held them. Their routines keep whether each
    /// one was on.
    pub bots: Vec<AgentConfig>,
    /// Unix milliseconds.
    pub archived_at: i64,
    /// Where the sidebar had it, among its groups and loose bots, so a restore
    /// can put it back there. The window reads it; the daemon does not.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slot: Option<usize>,
}

fn store_path() -> PathBuf {
    paths::home_dir().join("archived-groups.json")
}

pub fn load() -> Vec<ArchivedGroup> {
    fs::read_to_string(store_path())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn save(list: &[ArchivedGroup]) -> anyhow::Result<()> {
    if list.is_empty() {
        return match fs::remove_file(store_path()) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        };
    }
    paths::ensure_home()?;
    paths::write_atomic(&store_path(), &serde_json::to_vec_pretty(list)?)?;
    Ok(())
}

/// The archived group, out of the file, that this bot belonged to.
pub fn holding(bot: &str) -> Option<ArchivedGroup> {
    load().into_iter().find(|g| g.bots.iter().any(|b| b.id == bot))
}

/// What a bot that is in an archived group is told to the sender.
pub fn archived_note(locale: &str, bot: &str, group: &str) -> String {
    if locale == "en" {
        format!("{bot} is a bot of the archived group \"{group}\". Restore the group to reach it.")
    } else {
        format!("{bot}는 보관된 그룹(\"{group}\")의 봇이에요. 그룹을 복구하면 다시 쓸 수 있어요.")
    }
}

/// One bot in the list the window shows.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ArchivedBot {
    pub id: String,
    pub name: String,
    pub avatar: Option<String>,
    pub avatar_shape: Option<crate::config::AvatarShape>,
    pub avatar_color: Option<String>,
}

/// One archived group in the list the window shows, newest first.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ArchivedInfo {
    pub id: String,
    pub name: String,
    /// Unix milliseconds.
    pub archived_at: i64,
    pub slot: Option<usize>,
    pub bots: Vec<ArchivedBot>,
    /// The routines of those bots, on or off.
    pub routines: usize,
}

pub fn infos() -> Vec<ArchivedInfo> {
    let mut list: Vec<ArchivedInfo> = load().iter().map(info_of).collect();
    list.sort_by(|a, b| b.archived_at.cmp(&a.archived_at).then_with(|| a.name.cmp(&b.name)));
    list
}

fn info_of(g: &ArchivedGroup) -> ArchivedInfo {
    ArchivedInfo {
        id: g.group.id.clone(),
        name: g.group.name.clone(),
        archived_at: g.archived_at,
        slot: g.slot,
        bots: g
            .bots
            .iter()
            .map(|b| ArchivedBot {
                id: b.id.clone(),
                name: b.display_name().to_string(),
                avatar: b.avatar.clone(),
                avatar_shape: b.avatar_shape,
                avatar_color: b.avatar_color.clone(),
            })
            .collect(),
        routines: g.bots.iter().map(|b| b.routines.len()).sum(),
    }
}

/// The bot ids a group lists, in its order.
pub fn bot_ids(group: &SidebarGroup) -> Vec<String> {
    group
        .items
        .iter()
        .filter_map(|k| k.strip_prefix("agent:"))
        .map(str::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Routine;
    use crate::groups::WorktreeChoice;
    use crate::paths::testing::with_home;

    fn group(id: &str, bots: &[&str]) -> SidebarGroup {
        SidebarGroup {
            id: id.into(),
            name: format!("{id} name"),
            collapsed: false,
            items: bots.iter().map(|b| format!("agent:{b}")).collect(),
            path: None,
            lead: None,
            worktree: WorktreeChoice::On,
        }
    }

    fn bot(id: &str, routines: usize) -> AgentConfig {
        let mut cfg = AgentConfig::new(id.into(), id.to_uppercase(), vec!["sh".into()], None);
        for i in 0..routines {
            let mut r = Routine::new(format!("r{i}"), "0 9 * * *".into(), "go".into()).unwrap();
            r.enabled = i % 2 == 0;
            cfg.routines.push(r);
        }
        cfg
    }

    #[test]
    fn the_store_keeps_groups_with_their_bots_and_routines_as_they_were() {
        with_home("garchive", || {
            assert!(load().is_empty());
            let a = ArchivedGroup {
                group: group("g1", &["a", "b"]),
                bots: vec![bot("a", 2), bot("b", 0)],
                archived_at: 1000,
                slot: Some(3),
            };
            let b = ArchivedGroup {
                group: group("g2", &["c"]),
                bots: vec![bot("c", 1)],
                archived_at: 2000,
                slot: None,
            };
            save(&[a.clone(), b.clone()]).unwrap();
            let json = |list: &[ArchivedGroup]| serde_json::to_string(list).unwrap();
            assert_eq!(json(&load()), json(&[a.clone(), b.clone()]));
            // The routines' own on and off came back as they went in.
            assert_eq!(load()[0].bots[0].routines.iter().map(|r| r.enabled).collect::<Vec<_>>(), vec![true, false]);
            assert_eq!(holding("c").unwrap().group.id, "g2");
            assert!(holding("nobody").is_none());
            // Newest first, with the counts the list shows.
            let infos = infos();
            assert_eq!(infos.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), vec!["g2", "g1"]);
            assert_eq!((infos[1].bots.len(), infos[1].routines, infos[1].slot), (2, 2, Some(3)));
            assert_eq!(infos[1].bots[0].name, "A");
            save(&[]).unwrap();
            assert!(load().is_empty());
            assert!(!store_path().exists(), "an empty store leaves no file");
        });
    }

    #[test]
    fn a_group_lists_its_bots_in_order() {
        let mut g = group("g", &["a", "b"]);
        g.items.insert(1, "channel:x".into());
        assert_eq!(bot_ids(&g), vec!["a", "b"]);
    }

    #[test]
    fn the_sender_is_told_why_in_the_language_of_the_app() {
        assert!(archived_note("ko", "d-1", "Destia").contains("보관된 그룹"));
        assert!(archived_note("en", "d-1", "Destia").contains("archived group"));
    }

    #[test]
    fn a_broken_store_reads_as_empty() {
        with_home("garchive-broken", || {
            fs::write(store_path(), "{nope").unwrap();
            assert!(load().is_empty());
        });
    }
}
