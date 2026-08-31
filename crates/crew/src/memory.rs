use std::fs;
use std::path::Path;

use crate::paths;

pub fn read(agent_id: &str) -> String {
    fs::read_to_string(paths::memory_path(agent_id)).unwrap_or_default()
}

pub fn write(agent_id: &str, text: &str) -> anyhow::Result<()> {
    let path = paths::memory_path(agent_id);
    ensure_parent(&path)?;
    fs::write(path, text)?;
    Ok(())
}

pub fn append(agent_id: &str, text: &str) -> anyhow::Result<()> {
    let add = text.trim_end();
    if add.is_empty() {
        return Ok(());
    }
    let path = paths::memory_path(agent_id);
    ensure_parent(&path)?;
    let mut cur = fs::read_to_string(&path).unwrap_or_default();
    if !cur.is_empty() && !cur.ends_with('\n') {
        cur.push('\n');
    }
    cur.push_str(add);
    cur.push('\n');
    fs::write(path, cur)?;
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
    use std::sync::Mutex;

    static LOCK: Mutex<()> = Mutex::new(());

    fn with_home<R>(f: impl FnOnce() -> R) -> R {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!(
            "crew-memory-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let old = std::env::var("CREW_HOME").ok();
        std::env::set_var("CREW_HOME", &dir);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
        match old {
            Some(v) => std::env::set_var("CREW_HOME", v),
            None => std::env::remove_var("CREW_HOME"),
        }
        let _ = fs::remove_dir_all(&dir);
        match result {
            Ok(r) => r,
            Err(panic) => std::panic::resume_unwind(panic),
        }
    }

    #[test]
    fn write_read_append_copy_remove() {
        with_home(|| {
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
    fn path_is_under_memory_dir() {
        with_home(|| {
            let p = paths::memory_path("grok");
            assert!(p.ends_with("memory/grok.md"));
            write("weird/id", "x").unwrap();
            assert!(paths::memory_path("weird/id").ends_with("memory/weird_id.md"));
            assert_eq!(read("weird/id"), "x");
        });
    }

    #[test]
    fn reset_archive_leaves_memory() {
        with_home(|| {
            write("alpha", "keep me").unwrap();
            let dir = paths::home_dir().join("archive-test");
            crate::transcript::archive_and_clear("alpha", &dir).unwrap();
            assert_eq!(read("alpha"), "keep me");
        });
    }

    #[test]
    fn grok_spawn_injects_memory_into_rules() {
        with_home(|| {
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
