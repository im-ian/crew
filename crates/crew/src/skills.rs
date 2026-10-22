use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

use crate::paths;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Skill {
    pub name: String,
    pub body: String,
}

pub fn dir() -> PathBuf {
    paths::home_dir().join("skills")
}

pub fn list() -> Vec<Skill> {
    let dir = dir();
    let mut out: Vec<Skill> = stems(&dir)
        .into_iter()
        .map(|name| {
            let body = fs::read_to_string(dir.join(format!("{name}.md"))).unwrap_or_default();
            Skill { name, body }
        })
        .collect();
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

/// The skill names in `dir`: the stems of its .md files, as stored.
fn stems(dir: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("md"))
        .filter_map(|p| p.file_stem()?.to_str().map(str::to_string))
        .collect()
}

/// Skill names match without case, like the macOS disk.
fn same_name(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

/// Whether two paths are one file. The macOS disk also folds Unicode form,
/// so a Korean name typed precomposed lands on a decomposed file of the same
/// name, which a string compare would miss.
fn same_file(a: &Path, b: &Path) -> bool {
    match (fs::metadata(a), fs::metadata(b)) {
        (Ok(a), Ok(b)) => a.dev() == b.dev() && a.ino() == b.ino(),
        _ => false,
    }
}

/// Match `/name` or a prefix against skill file stems. Exact stem wins,
/// then unique prefix, then a heading that equals the query.
pub fn lookup(query: &str) -> Option<Skill> {
    lookup_in(query, &list())
}

pub fn lookup_in(query: &str, skills: &[Skill]) -> Option<Skill> {
    let q = query.trim().trim_start_matches('/').trim();
    if q.is_empty() {
        return None;
    }
    let lower = q.to_lowercase();
    if let Some(hit) = skills.iter().find(|s| same_name(&s.name, q)) {
        return Some(hit.clone());
    }
    let prefixed: Vec<_> = skills
        .iter()
        .filter(|s| s.name.to_lowercase().starts_with(&lower))
        .cloned()
        .collect();
    if prefixed.len() == 1 {
        return Some(prefixed.into_iter().next().unwrap());
    }
    skills
        .iter()
        .find(|s| {
            s.body
                .lines()
                .next()
                .map(|l| l.trim().trim_start_matches('#').trim())
                .is_some_and(|h| h.eq_ignore_ascii_case(q))
        })
        .cloned()
}

/// What a save did: wrote the skill, or found another skill under that name
/// and left both alone until the caller says to overwrite.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Saved {
    Saved { skill: Skill },
    Exists { name: String },
}

/// Save `body` as `name`. `previous` is the stem of the skill being edited,
/// so a rename moves its file. Another skill the save would land on is only
/// replaced when `overwrite` names it: the one the user was asked about.
pub fn save(
    name: &str,
    body: &str,
    previous: Option<&str>,
    overwrite: Option<&str>,
) -> anyhow::Result<Saved> {
    let name = sanitize_name(name);
    if name.is_empty() {
        anyhow::bail!("skill name is empty");
    }
    let dir = dir();
    fs::create_dir_all(&dir)?;
    let file = |stem: &str| dir.join(format!("{stem}.md"));
    let path = file(&name);
    let stems = stems(&dir);
    // As stored, so a file named outside the app still renames; and only an
    // existing stem, so it cannot point outside the folder.
    let previous = previous.filter(|p| stems.iter().any(|s| s == p));
    let clash = stems.iter().find(|s| {
        Some(s.as_str()) != previous && (same_name(s, &name) || same_file(&file(s), &path))
    });
    if let Some(other) = clash {
        if overwrite != Some(other.as_str()) {
            return Ok(Saved::Exists {
                name: other.clone(),
            });
        }
        // Move it under the new name first. The rename or write below then
        // replaces it in one step, and a failure before that leaves it whole.
        fs::rename(file(other), &path)?;
    }
    if let Some(prev) = previous.filter(|p| *p != name) {
        fs::rename(file(prev), &path)?;
    }
    fs::write(&path, body)?;
    Ok(Saved::Saved {
        skill: Skill {
            name,
            body: body.to_string(),
        },
    })
}

pub fn remove(name: &str) -> anyhow::Result<()> {
    let name = sanitize_name(name);
    if name.is_empty() {
        anyhow::bail!("skill name is empty");
    }
    let path = dir().join(format!("{name}.md"));
    if !path.exists() {
        anyhow::bail!("unknown skill {name}");
    }
    fs::remove_file(&path)?;
    Ok(())
}

fn sanitize_name(name: &str) -> String {
    let s: String = name
        .trim()
        .trim_start_matches('/')
        .chars()
        .map(|c| {
            // Unicode-aware: a Korean skill name has to survive as its own file
            // stem, or every one of them collapses to the same run of underscores.
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else if c.is_whitespace() {
                '-'
            } else {
                '_'
            }
        })
        .collect();
    s.trim_matches('-').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_become_safe_file_stems() {
        assert_eq!(sanitize_name("/주간 보고"), "주간-보고");
        assert_eq!(sanitize_name("  weekly report "), "weekly-report");
        assert_eq!(sanitize_name("a/b"), "a_b");
        assert!(sanitize_name("   ").is_empty());
    }

    fn skill(name: &str, body: &str) -> Skill {
        Skill {
            name: name.into(),
            body: body.into(),
        }
    }

    fn save(name: &str, body: &str) -> anyhow::Result<Skill> {
        match super::save(name, body, None, None)? {
            Saved::Saved { skill } => Ok(skill),
            Saved::Exists { name } => anyhow::bail!("{name} exists"),
        }
    }

    fn names() -> Vec<String> {
        list().into_iter().map(|s| s.name).collect()
    }

    #[test]
    fn save_asks_before_replacing_another_skill() {
        crate::paths::testing::with_home("skills-clash", || {
            save("report", "old").expect("save");
            save("draft", "draft body").expect("save");
            let ask = Saved::Exists {
                name: "report".into(),
            };
            assert_eq!(super::save("Report", "new", None, None).unwrap(), ask);
            assert_eq!(
                super::save("report", "x", Some("draft"), None).unwrap(),
                ask,
                "renaming another skill onto it asks too"
            );
            assert_eq!(
                super::save("report", "x", Some("draft"), Some("other")).unwrap(),
                ask,
                "an answer about another skill is no answer"
            );
            assert_eq!(lookup("report").unwrap().body, "old", "nothing written");
            assert_eq!(names(), ["draft", "report"]);

            super::save("report", "draft body", Some("draft"), Some("report")).expect("overwrite");
            assert_eq!(names(), ["report"], "the rename replaced it");
            assert_eq!(lookup("report").unwrap().body, "draft body");
        });
    }

    #[test]
    fn a_rename_moves_a_file_named_outside_the_app() {
        crate::paths::testing::with_home("skills-raw", || {
            fs::create_dir_all(dir()).unwrap();
            fs::write(dir().join("my skill.md"), "raw").unwrap();
            super::save("tidy", "raw 2", Some("my skill"), None).expect("rename");
            assert_eq!(names(), ["tidy"]);
        });
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_decomposed_korean_name_still_asks() {
        crate::paths::testing::with_home("skills-nfd", || {
            // 보고, decomposed into jamo the way Finder can store it.
            let nfd = "\u{1107}\u{1169}\u{1100}\u{1169}";
            fs::create_dir_all(dir()).unwrap();
            fs::write(dir().join(format!("{nfd}.md")), "old").unwrap();
            assert_eq!(
                super::save("보고", "new", None, None).unwrap(),
                Saved::Exists { name: nfd.into() }
            );
            assert_eq!(fs::read_to_string(dir().join("보고.md")).unwrap(), "old");
        });
    }

    #[test]
    fn a_case_only_rename_keeps_the_skill() {
        crate::paths::testing::with_home("skills-case", || {
            save("Foo", "body").expect("save");
            let saved = super::save("foo", "body 2", Some("Foo"), None).expect("rename");
            assert!(
                matches!(saved, Saved::Saved { .. }),
                "its own name is no clash"
            );
            assert_eq!(names(), ["foo"]);
            assert_eq!(lookup("foo").unwrap().body, "body 2");
        });
    }

    #[test]
    fn save_list_lookup_remove_roundtrip() {
        crate::paths::testing::with_home("skills", || {
            assert!(list().is_empty());
            let saved = save("주간 보고", "# 주간보고\n이번 주 한 일.").expect("save");
            assert_eq!(saved.name, "주간-보고", "a Korean name keeps its own stem");
            save("weekly", "# Weekly\nrecap").expect("save ascii");
            let names: Vec<_> = list().into_iter().map(|s| s.name).collect();
            assert_eq!(names, vec!["weekly".to_string(), "주간-보고".to_string()]);
            let hit = lookup("/주간-보고").expect("lookup by slash name");
            assert!(hit.body.contains("이번 주"));
            remove("주간-보고").expect("remove");
            assert!(lookup("주간-보고").is_none());
            assert_eq!(list().len(), 1);
            assert!(remove("주간-보고").is_err(), "removing twice is an error");
        });
    }

    #[test]
    fn two_korean_names_do_not_share_one_file() {
        crate::paths::testing::with_home("skills-collide", || {
            save("주간보고", "weekly").expect("save");
            save("월간보고", "monthly").expect("save");
            assert_eq!(list().len(), 2);
            assert_eq!(lookup("주간보고").expect("weekly").body, "weekly");
            assert_eq!(lookup("월간보고").expect("monthly").body, "monthly");
        });
    }

    #[test]
    fn lookup_prefers_exact_stem_then_prefix() {
        let skills = [
            skill("weekly-alpha", "# Alpha\nDo the alpha path.\n"),
            skill("weekly-beta", "# Beta\nDo the beta path.\n"),
        ];
        let hit = lookup_in("weekly-alpha", &skills).expect("exact");
        assert_eq!(hit.name, "weekly-alpha");
        assert!(hit.body.contains("alpha path"));
        let prefix = lookup_in("weekly-al", &skills).expect("prefix");
        assert_eq!(prefix.name, "weekly-alpha");
        let slash = lookup_in("/weekly-beta", &skills).expect("slash");
        assert_eq!(slash.name, "weekly-beta");
        assert!(lookup_in("definitely-missing-skill-xyz", &skills).is_none());
        assert!(lookup_in("weekly-", &skills).is_none());
    }
}
