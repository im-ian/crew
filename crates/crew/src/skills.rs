use std::fs;
use std::path::PathBuf;

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
    let mut out = Vec::new();
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for ent in entries.flatten() {
        let path = ent.path();
        if path.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let body = fs::read_to_string(&path).unwrap_or_default();
        out.push(Skill {
            name: stem.to_string(),
            body,
        });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
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
    if let Some(hit) = skills.iter().find(|s| s.name.eq_ignore_ascii_case(q)) {
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

/// Save `body` as `name`. `previous` is the skill being edited, so a rename
/// moves its file. Names match without case, like `lookup` and the macOS
/// disk, and another skill under `name` is only replaced with `overwrite`.
pub fn save(
    name: &str,
    body: &str,
    previous: Option<&str>,
    overwrite: bool,
) -> anyhow::Result<Saved> {
    let name = sanitize_name(name);
    if name.is_empty() {
        anyhow::bail!("skill name is empty");
    }
    let same = |other: &str| other.to_lowercase() == name.to_lowercase();
    let previous = previous.map(sanitize_name).filter(|p| !p.is_empty());
    let dir = dir();
    fs::create_dir_all(&dir)?;
    let clash = list()
        .into_iter()
        .find(|s| same(&s.name) && previous.as_deref().is_none_or(|p| !same(p)));
    if let Some(other) = clash {
        if !overwrite {
            return Ok(Saved::Exists { name: other.name });
        }
        fs::remove_file(dir.join(format!("{}.md", other.name)))?;
    }
    let path = dir.join(format!("{name}.md"));
    if let Some(prev) = previous.filter(|p| *p != name) {
        // Missing is fine: the body is written below either way.
        let _ = fs::rename(dir.join(format!("{prev}.md")), &path);
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
        match super::save(name, body, None, false)? {
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
            assert_eq!(super::save("Report", "new", None, false).unwrap(), ask);
            assert_eq!(
                super::save("report", "x", Some("draft"), false).unwrap(),
                ask,
                "renaming another skill onto it asks too"
            );
            assert_eq!(lookup("report").unwrap().body, "old", "nothing written");
            assert_eq!(names(), ["draft", "report"]);

            super::save("report", "draft body", Some("draft"), true).expect("overwrite");
            assert_eq!(names(), ["report"], "the rename replaced it");
            assert_eq!(lookup("report").unwrap().body, "draft body");
        });
    }

    #[test]
    fn a_case_only_rename_keeps_the_skill() {
        crate::paths::testing::with_home("skills-case", || {
            save("Foo", "body").expect("save");
            let saved = super::save("foo", "body 2", Some("Foo"), false).expect("rename");
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
