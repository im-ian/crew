use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;

use crate::paths;

pub fn read(agent_id: &str) -> String {
    read_path(&paths::memory_path(agent_id))
}

pub fn write(agent_id: &str, text: &str) -> anyhow::Result<()> {
    write_path(&paths::memory_path(agent_id), text)
}

pub fn read_shared() -> String {
    read_path(&paths::shared_memory_path())
}

pub fn write_shared(text: &str) -> anyhow::Result<()> {
    write_path(&paths::shared_memory_path(), text)
}

pub fn append_shared(text: &str) -> anyhow::Result<()> {
    append_path(&paths::shared_memory_path(), text)
}

/// A group's notes. The user edits them in the group settings, and a bot in
/// the group with `crew group memory`.
pub fn read_group(group_id: &str) -> String {
    read_path(&paths::group_memory_path(group_id))
}

pub fn write_group(group_id: &str, text: &str) -> anyhow::Result<()> {
    let path = paths::group_memory_path(group_id);
    if text.trim().is_empty() {
        let _ = fs::remove_file(path);
        return Ok(());
    }
    write_path(&path, text)
}

/// Writes `text` only if the notes still read `base`, so the settings dialog
/// can't drop a note a bot added while it was open.
pub fn write_group_if_unchanged(group_id: &str, base: &str, text: &str) -> anyhow::Result<bool> {
    if read_group(group_id) != base {
        return Ok(false);
    }
    write_group(group_id, text)?;
    Ok(true)
}

pub fn append_group(group_id: &str, text: &str) -> anyhow::Result<()> {
    append_path(&paths::group_memory_path(group_id), text)
}

pub fn remove_group(group_id: &str) {
    let _ = fs::remove_file(paths::group_memory_path(group_id));
}

/// The group `agent_id` sits in and its notes, blank while it has none.
pub fn group_for(agent_id: &str) -> Option<(String, String)> {
    let groups = crate::groups::load().ok()?;
    let group = crate::groups::group_of(&groups, agent_id)?;
    Some((group.name.clone(), read_group(&group.id)))
}

fn read_path(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_default()
}

fn write_path(path: &Path, text: &str) -> anyhow::Result<()> {
    ensure_parent(path)?;
    // A bot's turn or `crew memory append` may read it mid-write.
    paths::write_atomic(path, text.as_bytes())?;
    Ok(())
}

/// Writes `text` only if the memory still reads `base`, so an editor that
/// loaded it earlier can't drop a note the bot has added since.
pub fn write_if_unchanged(agent_id: &str, base: &str, text: &str) -> anyhow::Result<bool> {
    if read(agent_id) != base {
        return Ok(false);
    }
    write(agent_id, text)?;
    Ok(true)
}

pub fn append(agent_id: &str, text: &str) -> anyhow::Result<()> {
    append_path(&paths::memory_path(agent_id), text)
}

fn append_path(path: &Path, text: &str) -> anyhow::Result<()> {
    let add = text.trim_end();
    if add.is_empty() {
        return Ok(());
    }
    ensure_parent(path)?;
    // Append in place rather than read and rewrite: bots append on their own,
    // sometimes several at once, and a rewrite from a stale or failed read
    // dropped the other notes.
    let mut file = OpenOptions::new()
        .read(true)
        .append(true)
        .create(true)
        .open(path)?;
    let mut line = String::new();
    if file.metadata()?.len() > 0 {
        let mut last = [0u8];
        file.seek(SeekFrom::End(-1))?;
        file.read_exact(&mut last)?;
        if last[0] != b'\n' {
            line.push('\n');
        }
    }
    line.push_str(add);
    line.push('\n');
    file.write_all(line.as_bytes())?;
    Ok(())
}

pub fn copy(src: &str, dst: &str) -> anyhow::Result<()> {
    let from = paths::memory_path(src);
    if !from.exists() {
        return Ok(());
    }
    let to = paths::memory_path(dst);
    if src == dst || from == to {
        return Ok(());
    }
    ensure_parent(&to)?;
    fs::copy(&from, &to)?;
    Ok(())
}

pub fn remove(agent_id: &str) {
    let _ = fs::remove_file(paths::memory_path(agent_id));
}

fn ensure_parent(path: &Path) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::testing::with_home;

    fn with_home_dir<R>(f: impl FnOnce() -> R) -> R {
        with_home("memory", f)
    }

    #[test]
    fn write_read_append_copy_remove() {
        with_home_dir(|| {
            assert!(read("alpha").is_empty());
            write("alpha", "one").unwrap();
            assert_eq!(read("alpha"), "one");
            append("alpha", "two").unwrap();
            assert_eq!(read("alpha"), "one\ntwo\n");
            copy("alpha", "beta").unwrap();
            assert_eq!(read("beta"), "one\ntwo\n");
            remove("alpha");
            assert!(read("alpha").is_empty());
            assert_eq!(read("beta"), "one\ntwo\n");
            copy("missing", "gamma").unwrap();
            assert!(read("gamma").is_empty());
        });
    }

    #[test]
    fn write_if_unchanged_keeps_a_note_added_since() {
        with_home_dir(|| {
            assert!(write_if_unchanged("alpha", "", "one").unwrap());
            append("alpha", "bot note").unwrap();
            assert!(!write_if_unchanged("alpha", "one", "one, edited").unwrap());
            assert_eq!(read("alpha"), "one\nbot note\n");
            assert!(write_if_unchanged("alpha", "one\nbot note\n", "both").unwrap());
            assert_eq!(read("alpha"), "both");
        });
    }

    #[test]
    fn concurrent_appends_keep_every_note() {
        with_home_dir(|| {
            write("alpha", "keep me").unwrap();
            std::thread::scope(|s| {
                for t in 0..8 {
                    s.spawn(move || {
                        for i in 0..25 {
                            append("alpha", &format!("note {t}-{i}")).unwrap();
                        }
                    });
                }
            });
            // Racing over "keep me" having no newline can leave a blank line;
            // what matters is that no note is lost.
            let text = read("alpha");
            let notes = text.lines().filter(|l| !l.is_empty()).count();
            assert_eq!(notes, 1 + 8 * 25, "{text}");
            assert!(text.starts_with("keep me\n"));
        });
    }

    #[test]
    fn path_is_under_memory_dir() {
        with_home_dir(|| {
            let p = paths::memory_path("grok");
            assert!(p.ends_with("memory/grok.md"));
            write("weird/id", "x").unwrap();
            assert!(paths::memory_path("weird/id").ends_with("memory/weird_id.md"));
            assert_eq!(read("weird/id"), "x");
        });
    }

    #[test]
    fn shared_notes_are_not_a_bots_memory() {
        with_home_dir(|| {
            write("alpha", "mine").unwrap();
            write_shared("team").unwrap();
            append_shared("also").unwrap();
            assert_eq!(read("alpha"), "mine");
            assert_eq!(read_shared(), "team\nalso\n");
            remove("alpha");
            assert_eq!(read_shared(), "team\nalso\n");
        });
    }

    #[test]
    fn group_notes_follow_the_bots_group() {
        with_home_dir(|| {
            let groups = vec![crate::groups::SidebarGroup {
                id: "g1".into(),
                name: "app".into(),
                collapsed: false,
                items: vec!["agent:alpha".into()],
                path: None,
            }];
            crate::groups::save(&groups).unwrap();
            assert_eq!(group_for("alpha"), Some(("app".into(), String::new())));
            write_group("g1", "ship on fridays").unwrap();
            assert_eq!(read_group("g1"), "ship on fridays");
            assert_eq!(
                group_for("alpha"),
                Some(("app".into(), "ship on fridays".into()))
            );
            assert_eq!(group_for("beta"), None);
            write_group("g1", "  ").unwrap();
            assert!(!paths::group_memory_path("g1").exists());
            append_group("g1", "bot note").unwrap();
            assert!(!write_group_if_unchanged("g1", "", "user edit").unwrap());
            assert!(write_group_if_unchanged("g1", "bot note\n", "both").unwrap());
            assert_eq!(read_group("g1"), "both");
            remove_group("g1");
            assert!(read_group("g1").is_empty());
        });
    }

    #[test]
    fn reset_archive_leaves_memory() {
        with_home_dir(|| {
            write("alpha", "keep me").unwrap();
            let dir = paths::home_dir().join("archive-test");
            crate::transcript::archive_and_clear("alpha", &dir).unwrap();
            assert_eq!(read("alpha"), "keep me");
        });
    }

    #[test]
    fn grok_spawn_injects_memory_into_rules() {
        with_home_dir(|| {
            write("alpha", "remember the red balloon").unwrap();
            let c = crate::config::AgentConfig::new(
                "alpha".into(),
                "Alpha".into(),
                vec!["grok".into(), "--always-approve".into()],
                None,
            );
            let argv = c.spawn_cmd(false);
            let i = argv.iter().position(|a| a == "--rules").expect("--rules");
            let rules = argv.get(i + 1).map(|s| s.as_str()).unwrap_or("");
            assert!(rules.contains("remember the red balloon"), "{rules}");
            assert!(rules.contains("crew tell"), "{rules}");
            let claude = crate::config::AgentConfig::new(
                "alpha".into(),
                "Alpha".into(),
                vec!["claude".into()],
                None,
            )
            .spawn_cmd(false);
            assert_eq!(claude[1], "--append-system-prompt");
            assert!(claude[2].contains("remember the red balloon"));
        });
    }
}
