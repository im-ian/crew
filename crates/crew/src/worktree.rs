//! One git worktree per bot, so bots do not edit the shared checkout together.
//!
//! The setting defaults off. While it is on, a bot whose folder is a git
//! repository gets a worktree under `$CREW_HOME/worktrees` and every later
//! turn of that bot reuses it. A folder that is not a repository stays put.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use crate::paths;

/// Held across prepare so two bots cannot `git worktree add` the same repo at once.
static PREPARE: Mutex<()> = Mutex::new(());

/// A bot in `dir` edits a worktree of its own: worktrees are on and `dir` is
/// in a git repository with a commit to branch from.
pub fn isolates(dir: &Path) -> bool {
    // Fails outside a repository too, so one call answers both.
    paths::worktrees_enabled() && run_git(dir, &["rev-parse", "--verify", "-q", "HEAD"]).status
}

/// Where this turn actually runs, and the shared checkout when that place is a worktree.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Isolated {
    pub dir: PathBuf,
    pub shared: PathBuf,
}

pub struct Place {
    pub cwd: PathBuf,
    pub isolated: Option<Isolated>,
}

/// The directory a bot's process should start in.
pub fn place_for(agent_id: &str, base: &Path) -> Place {
    let cwd = base.to_path_buf();
    if !paths::worktrees_enabled() {
        return Place {
            cwd,
            isolated: None,
        };
    }
    let _guard = PREPARE.lock().unwrap_or_else(|err| err.into_inner());
    match prepare(agent_id, base) {
        Ok(place) => place,
        Err(err) => {
            eprintln!("[crew] worktree {}: {err:#}", base.display());
            Place {
                cwd,
                isolated: None,
            }
        }
    }
}

fn prepare(agent_id: &str, base: &Path) -> anyhow::Result<Place> {
    let Some(shared) = git_toplevel(base)? else {
        return Ok(Place {
            cwd: base.to_path_buf(),
            isolated: None,
        });
    };
    let dir = worktree_dir(agent_id, &shared);
    if listed(&shared, &dir)? {
        if dir.is_dir() {
            return Ok(place_at(dir, shared, base));
        }
        // The directory was removed out from under the registration.
        let _ = run_git(&shared, &["worktree", "prune"]);
    }
    if dir.exists() {
        anyhow::bail!(
            "{} exists and is not a worktree of {}",
            dir.display(),
            shared.display()
        );
    }
    if let Some(parent) = dir.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let branch = format!("crew/{}", paths::safe_agent_id(agent_id));
    add_worktree(&shared, &dir, &branch)?;
    eprintln!(
        "[crew] worktree {agent_id} -> {} (shared {})",
        dir.display(),
        shared.display()
    );
    Ok(place_at(dir, shared, base))
}

/// The worktree root, or the same subfolder the bot was given inside it.
fn place_at(dir: PathBuf, shared: PathBuf, base: &Path) -> Place {
    let cwd = match norm(base).strip_prefix(&norm(&shared)) {
        Ok(rel) if !rel.as_os_str().is_empty() => dir.join(rel),
        _ => dir.clone(),
    };
    Place {
        cwd,
        isolated: Some(Isolated { dir, shared }),
    }
}

fn worktree_dir(agent_id: &str, shared: &Path) -> PathBuf {
    paths::home_dir()
        .join("worktrees")
        .join(repo_key(shared))
        .join(paths::safe_agent_id(agent_id))
}

fn repo_key(shared: &Path) -> String {
    let canon = std::fs::canonicalize(shared).unwrap_or_else(|_| shared.to_path_buf());
    let name = canon.file_name().and_then(|s| s.to_str()).unwrap_or("repo");
    let name = paths::safe_agent_id(&name.to_ascii_lowercase());
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in canon.to_string_lossy().as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    let name = if name.is_empty() { "repo" } else { &name };
    format!("{name}-{hash:016x}")
}

fn git_toplevel(base: &Path) -> anyhow::Result<Option<PathBuf>> {
    let out = run_git(base, &["rev-parse", "--show-toplevel"]);
    if !out.status {
        return Ok(None);
    }
    let path = out.stdout.trim();
    if path.is_empty() {
        return Ok(None);
    }
    Ok(Some(PathBuf::from(path)))
}

fn listed(shared: &Path, dir: &Path) -> anyhow::Result<bool> {
    let out = run_git(shared, &["worktree", "list", "--porcelain"]);
    if !out.status {
        anyhow::bail!("git worktree list: {}", out.stderr.trim());
    }
    let want = norm(dir);
    Ok(out.stdout.lines().any(|line| {
        let Some(path) = line.strip_prefix("worktree ") else {
            return false;
        };
        norm(Path::new(path.trim())) == want
    }))
}

fn norm(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn add_worktree(shared: &Path, dir: &Path, branch: &str) -> anyhow::Result<()> {
    let path = dir.display().to_string();
    if !branch_exists(shared, branch) {
        let created = run_git(shared, &["worktree", "add", "-b", branch, &path, "HEAD"]);
        if created.status {
            return Ok(());
        }
        anyhow::bail!("git worktree add: {}", created.stderr.trim());
    }
    if !branch_checked_out(shared, branch)? {
        let existing = run_git(shared, &["worktree", "add", &path, branch]);
        if existing.status {
            return Ok(());
        }
        anyhow::bail!("git worktree add: {}", existing.stderr.trim());
    }
    // The branch is checked out somewhere else. A second name keeps this bot's tree.
    let alt = format!("{branch}-2");
    if branch_exists(shared, &alt) {
        anyhow::bail!("branch {branch} is checked out and {alt} already exists");
    }
    let retry = run_git(shared, &["worktree", "add", "-b", &alt, &path, "HEAD"]);
    if retry.status {
        return Ok(());
    }
    anyhow::bail!("git worktree add: {}", retry.stderr.trim())
}

fn branch_exists(shared: &Path, branch: &str) -> bool {
    run_git(
        shared,
        &[
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ],
    )
    .status
}

fn branch_checked_out(shared: &Path, branch: &str) -> anyhow::Result<bool> {
    let out = run_git(shared, &["worktree", "list", "--porcelain"]);
    if !out.status {
        anyhow::bail!("git worktree list: {}", out.stderr.trim());
    }
    let needle = format!("branch refs/heads/{branch}");
    Ok(out.stdout.lines().any(|line| line.trim() == needle))
}

struct GitOut {
    status: bool,
    stdout: String,
    stderr: String,
}

fn run_git(dir: &Path, args: &[&str]) -> GitOut {
    match Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
    {
        Ok(out) => GitOut {
            status: out.status.success(),
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        },
        Err(err) => GitOut {
            status: false,
            stdout: String::new(),
            stderr: err.to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .args([
                "-c",
                "commit.gpgsign=false",
                "-c",
                "user.name=Crew",
                "-c",
                "user.email=crew@example.com",
            ])
            .arg("-C")
            .arg(dir)
            .args(args)
            .env("GIT_AUTHOR_NAME", "Crew")
            .env("GIT_AUTHOR_EMAIL", "crew@example.com")
            .env("GIT_COMMITTER_NAME", "Crew")
            .env("GIT_COMMITTER_EMAIL", "crew@example.com")
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .expect("git");
        assert!(
            out.status.success(),
            "git {} in {}: {}",
            args.join(" "),
            dir.display(),
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// A clone shares its source's folder only where it gets a worktree.
    #[test]
    fn only_a_repository_with_worktrees_on_isolates() {
        if Command::new("git").arg("--version").output().is_err() {
            return;
        }
        paths::testing::with_home("wt-isolates", || {
            let repo = paths::home_dir().join("repo");
            let plain = paths::home_dir().join("plain");
            std::fs::create_dir_all(&repo).unwrap();
            std::fs::create_dir_all(&plain).unwrap();
            git(&repo, &["init", "-b", "main"]);
            paths::write_worktrees_enabled(true);
            // No commit yet: `git worktree add` has nothing to branch from.
            assert!(!isolates(&repo));
            std::fs::write(repo.join("readme.txt"), "hello\n").unwrap();
            git(&repo, &["add", "readme.txt"]);
            git(&repo, &["commit", "-m", "init"]);
            assert!(isolates(&repo));
            assert!(!isolates(&plain));
            paths::write_worktrees_enabled(false);
            assert!(!isolates(&repo));
        });
    }

    #[test]
    fn an_enabled_bot_gets_one_worktree_and_reuses_it() {
        let bin = Command::new("git").arg("--version").output();
        if bin.is_err() {
            return;
        }
        paths::testing::with_home("wt", || {
            let root = std::env::temp_dir().join(format!(
                "cw-repo-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            ));
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(&root).unwrap();
            git(&root, &["init", "-b", "main"]);
            std::fs::write(root.join("readme.txt"), "hello\n").unwrap();
            std::fs::create_dir_all(root.join("sub/deep")).unwrap();
            std::fs::write(root.join("sub/deep/note.txt"), "n\n").unwrap();
            git(&root, &["add", "readme.txt", "sub/deep/note.txt"]);
            git(&root, &["commit", "-m", "init"]);
            git(&root, &["branch", "crew/bot-c"]);

            paths::write_worktrees_enabled(false);
            let off = place_for("bot-a", &root);
            assert_eq!(off.cwd, root);
            assert!(off.isolated.is_none());

            paths::write_worktrees_enabled(true);
            let first = place_for("bot-a", &root);
            let dir = first.cwd.clone();
            let isolated = first.isolated.expect("worktree");
            assert_ne!(dir, root);
            assert_eq!(isolated.dir, dir);
            assert_eq!(norm(&isolated.shared), norm(&root));
            assert_eq!(
                std::fs::read_to_string(dir.join("readme.txt")).unwrap(),
                "hello\n"
            );

            std::fs::write(dir.join("from-bot.txt"), "bot\n").unwrap();
            let status = Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(["status", "--porcelain"])
                .output()
                .unwrap();
            assert!(status.status.success());
            assert!(
                String::from_utf8_lossy(&status.stdout).trim().is_empty(),
                "the shared checkout stays clean"
            );

            let second = place_for("bot-a", &root);
            assert_eq!(second.cwd, dir);
            let nested = place_for("bot-a", &root.join("sub/deep"));
            let nested_root = nested.isolated.expect("same worktree").dir;
            assert_eq!(nested_root, dir);
            assert_eq!(nested.cwd, dir.join("sub/deep"));
            assert_eq!(
                std::fs::read_to_string(nested.cwd.join("note.txt")).unwrap(),
                "n\n"
            );
            let other = place_for("bot-b", &root);
            assert_ne!(other.cwd, dir);
            let existing = place_for("bot-c", &root);
            assert!(existing.isolated.is_some());
            assert_ne!(existing.cwd, dir);

            let plain = std::env::temp_dir().join(format!("cw-plain-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&plain);
            std::fs::create_dir_all(&plain).unwrap();
            let stayed = place_for("bot-a", &plain);
            assert_eq!(stayed.cwd, plain);
            assert!(stayed.isolated.is_none());

            let _ = std::fs::remove_dir_all(&root);
            let _ = std::fs::remove_dir_all(&plain);
        });
    }
}
