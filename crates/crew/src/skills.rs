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
    let q = query.trim().trim_start_matches('/').trim();
    if q.is_empty() {
        return None;
    }
    let lower = q.to_lowercase();
    let skills = list();
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
    skills.into_iter().find(|s| {
        s.body
            .lines()
            .next()
            .map(|l| l.trim().trim_start_matches('#').trim())
            .is_some_and(|h| h.eq_ignore_ascii_case(q))
    })
}

pub fn save(name: &str, body: &str) -> anyhow::Result<Skill> {
    let name = sanitize_name(name);
    if name.is_empty() {
        anyhow::bail!("skill name is empty");
    }
    let dir = dir();
    fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{name}.md"));
    fs::write(&path, body)?;
    Ok(Skill {
        name,
        body: body.to_string(),
    })
}

fn sanitize_name(name: &str) -> String {
    let s: String = name
        .trim()
        .trim_start_matches('/')
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
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
    fn lookup_prefers_exact_stem_then_prefix() {
        let unique = format!(
            "sk{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        let a = format!("{unique}-alpha");
        let b = format!("{unique}-beta");
        save(&a, "# Alpha\nDo the alpha path.\n").unwrap();
        save(&b, "# Beta\nDo the beta path.\n").unwrap();
        let hit = lookup(&a).expect("exact");
        assert_eq!(hit.name, a);
        assert!(hit.body.contains("alpha path"));
        let prefix = lookup(&format!("{unique}-al")).expect("prefix");
        assert_eq!(prefix.name, a);
        assert!(lookup("definitely-missing-skill-xyz").is_none());
        let _ = fs::remove_file(dir().join(format!("{a}.md")));
        let _ = fs::remove_file(dir().join(format!("{b}.md")));
    }
}
