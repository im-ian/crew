//! One git worktree per bot, so bots do not edit the shared checkout together.
//!
//! A group's own choice is on or off. A new group starts on. A bot in no
//! group follows the legacy `$CREW_HOME/worktree` file when that file exists,
//! and is on when it does not. While the choice is on, a bot whose folder is
//! a git repository gets a worktree under `$CREW_HOME/worktrees` and every
//! later turn of that bot reuses it. A folder that is not a repository stays put.
//!
//! Bots of one repository share `$CREW_HOME/cargo-target/<repo>`. The
//! worktree's `target` is a symlink to that directory, so `target/debug/...`
//! is the shared cache. Cargo's target lock is exclusive, so two builds of
//! the same repo wait their turn. Builds of different repos do not. A real
//! per-bot `target/` left from before is replaced with that symlink once the
//! bot is idle and nothing is compiling into it. The symlink stays, and a
//! sweep does not follow it into the shared cache. The shared directory goes
//! when that repo has no worktree left, or when no bot has used it for a week.
//! A directory a build still holds is left alone. A shared checkout listed in
//! `$CREW_HOME/cargo-target-skip` is left out of all of this: its worktrees
//! keep the target Cargo chooses. A group whose worktree choice is off is not
//! given the symlink.

use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use std::os::unix::io::AsRawFd;

use crate::paths;

/// Held across prepare so two bots cannot `git worktree add` the same repo at once.
static PREPARE: Mutex<()> = Mutex::new(());

/// A per-bot `target/` written this recently is still in use, even when the
/// bot already looks idle. Long enough for cargo to take its lock.
const BUILD_CACHE_GRACE: Duration = Duration::from_secs(2 * 60);

/// A shared cache no bot has used for this long is rebuilt on the next build.
const BUILD_CACHE_STALE: Duration = Duration::from_secs(7 * 24 * 60 * 60);

static SWEEP_NONCE: AtomicU64 = AtomicU64::new(0);

/// A bot in no group edits a worktree of its own when its choice is on and
/// `dir` is a git repository with a commit to branch from. A clone is not in
/// a group yet, so it uses that same rule and may share the folder only then.
pub fn isolates(dir: &Path) -> bool {
    // Fails outside a repository too, so one call answers both.
    loose_enabled() && run_git(dir, &["rev-parse", "--verify", "-q", "HEAD"]).status
}

/// The legacy app file, when it exists. A home that never wrote one is on.
fn loose_enabled() -> bool {
    paths::legacy_worktree_setting().unwrap_or(true)
}

/// A group's on or off wins. A group not yet copied follows the old file
/// (missing counts as off). A bot in no group follows `loose_enabled`.
fn enabled_for(agent_id: &str) -> bool {
    match crate::groups::folder_of(agent_id).map(|group| group.worktree) {
        Some(crate::groups::WorktreeChoice::On) => true,
        Some(crate::groups::WorktreeChoice::Off) => false,
        Some(crate::groups::WorktreeChoice::Unset) => paths::worktrees_enabled(),
        None => loose_enabled(),
    }
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
/// Read at the start of a turn. A change while a turn is running waits
/// until the next one, and turning it off leaves a worktree that exists.
pub fn place_for(agent_id: &str, base: &Path) -> Place {
    let cwd = base.to_path_buf();
    if !enabled_for(agent_id) {
        return Place {
            cwd,
            isolated: None,
        };
    }
    let _guard = PREPARE.lock().unwrap_or_else(|err| err.into_inner());
    match prepare(agent_id, base) {
        Ok(place) => place,
        Err(err) => {
            // The shared checkout is what several bots edit at once. A failed
            // worktree used to land there with only a log line.
            show_worktree_failure(agent_id, &err);
            Place {
                cwd: unavailable_dir(agent_id),
                isolated: None,
            }
        }
    }
}

fn unavailable_dir(agent_id: &str) -> PathBuf {
    let dir = paths::home_dir()
        .join("worktrees")
        .join("unavailable")
        .join(paths::safe_agent_id(agent_id));
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn show_worktree_failure(agent_id: &str, err: &anyhow::Error) {
    eprintln!("[crew] worktree {agent_id}: {err:#}");
    static SHOWN: Mutex<Vec<String>> = Mutex::new(Vec::new());
    let mut shown = SHOWN.lock().unwrap_or_else(|poison| poison.into_inner());
    if shown.iter().any(|id| id == agent_id) {
        return;
    }
    shown.push(agent_id.to_string());
    drop(shown);
    let text = if paths::locale() == "en" {
        format!(
            "Could not make a worktree for this bot ({err:#}). It is not using the shared checkout."
        )
    } else {
        format!("이 봇의 워크트리를 만들지 못했어요 ({err:#}). 공유 체크아웃에서는 일하지 않아요.")
    };
    crate::transcript::push_system(agent_id, "crew", &text, None);
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
        if dir.is_dir() && !dir_is_empty(&dir) {
            return Ok(place_at(dir, shared, base));
        }
        // An empty directory is still registered, so `git worktree add` would
        // refuse it. Remove it first; prune only sees a missing path.
        remove_empty_dir(&dir)?;
        let _ = run_git(&shared, &["worktree", "prune"]);
    } else if dir.exists() {
        if dir_is_empty(&dir) {
            remove_empty_dir(&dir)?;
            let _ = run_git(&shared, &["worktree", "prune"]);
        } else {
            anyhow::bail!(
                "{} exists and is not a worktree of {}",
                dir.display(),
                shared.display()
            );
        }
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
    link_shared_target(&dir, &shared);
    let cwd = match norm(base).strip_prefix(&norm(&shared)) {
        Ok(rel) if !rel.as_os_str().is_empty() => dir.join(rel),
        _ => dir.clone(),
    };
    Place {
        cwd,
        isolated: Some(Isolated { dir, shared }),
    }
}

/// Point `worktree/target` at this repo's shared Cargo cache.
/// A real directory is replaced only when it is idle and unlocked, the same
/// rule as the sweep. A skipped checkout is left untouched.
fn link_shared_target(worktree: &Path, shared: &Path) {
    let key = repo_key(shared);
    if skipped_repo_keys().contains(&key) {
        return;
    }
    let cache = paths::home_dir().join("cargo-target").join(key);
    if fs::create_dir_all(&cache).is_err() {
        return;
    }
    let link = worktree.join("target");
    if is_real_dir(&link) && !take_real_target(&link) {
        return;
    }
    point_target_at_cache(worktree, &cache);
}

fn take_real_target(target: &Path) -> bool {
    if !is_real_dir(target) || written_since(target, SystemTime::now(), BUILD_CACHE_GRACE) {
        return false;
    }
    reclaim_tree(target).is_some()
}

fn point_target_at_cache(worktree: &Path, cache: &Path) {
    let link = worktree.join("target");
    if link_points_at(&link, cache) {
        hide_target_link(worktree);
        return;
    }
    match fs::symlink_metadata(&link) {
        Ok(meta) if meta.file_type().is_symlink() => {
            if fs::remove_file(&link).is_err() {
                return;
            }
        }
        Ok(_) => return,
        Err(err) if err.kind() == ErrorKind::NotFound => {}
        Err(_) => return,
    }
    if std::os::unix::fs::symlink(cache, &link).is_ok() {
        hide_target_link(worktree);
    }
}

fn link_points_at(link: &Path, cache: &Path) -> bool {
    fs::read_link(link).is_ok_and(|dest| dest == cache)
}

/// `target/` in a gitignore does not match a symlink. One `/target` line in
/// the exclude git actually reads keeps it out of `git status`. That file is
/// not part of the commit.
fn hide_target_link(worktree: &Path) {
    let out = run_git(worktree, &["rev-parse", "--git-path", "info/exclude"]);
    if !out.status {
        return;
    }
    let raw = out.stdout.trim();
    if raw.is_empty() {
        return;
    }
    let path = PathBuf::from(raw);
    let path = if path.is_absolute() {
        path
    } else {
        worktree.join(path)
    };
    if let Some(parent) = path.parent() {
        if fs::create_dir_all(parent).is_err() {
            return;
        }
    }
    let existing = fs::read_to_string(&path).unwrap_or_default();
    if existing.lines().any(|line| line.trim() == "/target") {
        return;
    }
    let mut next = existing;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str("/target\n");
    let _ = fs::write(&path, next);
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

fn dir_is_empty(path: &Path) -> bool {
    std::fs::read_dir(path)
        .map(|mut entries| entries.next().is_none())
        .unwrap_or(false)
}

fn remove_empty_dir(dir: &Path) -> anyhow::Result<()> {
    if dir.is_dir() && dir_is_empty(dir) {
        std::fs::remove_dir(dir)?;
    }
    Ok(())
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

/// One Cargo target directory for every worktree of `shared`.
pub fn cargo_target_dir(shared: &Path) -> PathBuf {
    paths::home_dir()
        .join("cargo-target")
        .join(repo_key(shared))
}

/// The shared target dir for a turn whose `cwd` is inside a Crew worktree.
/// `None` when this turn is not in one, or the process already chose a dir.
/// Creates the directory and marks it used.
pub fn cargo_target_for_cwd(cwd: &Path) -> Option<PathBuf> {
    if std::env::var_os("CARGO_TARGET_DIR").is_some_and(|value| !value.is_empty()) {
        return None;
    }
    let dir = shared_cargo_dir(cwd)?;
    if let Err(err) = fs::create_dir_all(&dir) {
        eprintln!("[crew] cargo target {}: {err:#}", dir.display());
        return None;
    }
    touch_stamp(&dir);
    Some(dir)
}

/// Remember that a bot is working in the worktree at `cwd`, so a long turn
/// does not look abandoned. Does nothing until that repo already has a cache.
pub fn note_build_use(cwd: &Path) {
    let Some(dir) = shared_cargo_dir(cwd) else {
        return;
    };
    if !dir.is_dir() || stamp_age_under(&dir, Duration::from_secs(60)) {
        return;
    }
    touch_stamp(&dir);
}

pub struct RemovedCache {
    pub path: PathBuf,
    pub bytes: u64,
}

pub fn format_bytes(bytes: u64) -> String {
    const GIB: u64 = 1024 * 1024 * 1024;
    const MIB: u64 = 1024 * 1024;
    if bytes >= GIB {
        format!("{:.1} GiB", bytes as f64 / GIB as f64)
    } else if bytes >= MIB {
        format!("{:.1} MiB", bytes as f64 / MIB as f64)
    } else {
        format!("{bytes} B")
    }
}

/// Drop build caches that are safe to rebuild.
///
/// `busy` is the agents in a turn. Their per-bot `target/` stays, and so does
/// the shared cache of any repo they have a worktree in. A directory whose
/// `.cargo-lock` is held stays too. A real per-bot `target/` that is dropped
/// becomes a symlink to the shared cache when that bot still works in a
/// worktree. An existing symlink is left alone, and is never followed.
pub fn sweep_build_caches(busy: &HashSet<String>) -> Vec<RemovedCache> {
    sweep_at(busy, SystemTime::now(), BUILD_CACHE_GRACE, BUILD_CACHE_STALE)
}

fn sweep_at(
    busy: &HashSet<String>,
    now: SystemTime,
    grace: Duration,
    stale: Duration,
) -> Vec<RemovedCache> {
    let busy_dirs: HashSet<String> = busy.iter().map(|id| paths::safe_agent_id(id)).collect();
    let skipped = skipped_repo_keys();
    let mut removed = Vec::new();
    let worktrees = paths::home_dir().join("worktrees");
    reclaim_per_bot(&worktrees, &busy_dirs, &skipped, now, grace, &mut removed);
    reclaim_shared(&worktrees, &busy_dirs, &skipped, now, stale, &mut removed);
    removed
}

fn shared_cargo_dir(cwd: &Path) -> Option<PathBuf> {
    let key = repo_key_of_cwd(cwd)?;
    if skipped_repo_keys().contains(&key) {
        return None;
    }
    Some(paths::home_dir().join("cargo-target").join(key))
}

/// Repo keys for the shared checkouts named in `$CREW_HOME/cargo-target-skip`.
/// One path per line. A blank line, or a line whose first character is `#`,
/// is a note. A leading `~` is the user's home directory. A missing file
/// skips nothing.
fn skipped_repo_keys() -> HashSet<String> {
    let path = paths::home_dir().join("cargo-target-skip");
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(err) if err.kind() == ErrorKind::NotFound => return HashSet::new(),
        Err(err) => {
            eprintln!("[crew] cargo target skip {}: {err}", path.display());
            return HashSet::new();
        }
    };
    let mut keys = HashSet::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        keys.insert(repo_key(&expand_user_path(line)));
    }
    keys
}

fn expand_user_path(line: &str) -> PathBuf {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return PathBuf::from(line);
    };
    if line == "~" {
        return home;
    }
    if let Some(rest) = line.strip_prefix("~/") {
        return home.join(rest);
    }
    PathBuf::from(line)
}

fn repo_key_of_cwd(cwd: &Path) -> Option<String> {
    let cwd = norm(cwd);
    let root = norm(&paths::home_dir().join("worktrees"));
    let rel = cwd.strip_prefix(&root).ok()?;
    let key = rel.components().next()?.as_os_str().to_str()?;
    if key.is_empty() || key.starts_with('.') {
        return None;
    }
    Some(key.to_string())
}

fn stamp_path(dir: &Path) -> PathBuf {
    dir.join(".crew-used")
}

fn touch_stamp(dir: &Path) {
    let _ = File::create(stamp_path(dir));
}

fn stamp_age_under(dir: &Path, window: Duration) -> bool {
    let Ok(meta) = fs::metadata(stamp_path(dir)) else {
        return false;
    };
    let Ok(modified) = meta.modified() else {
        return true;
    };
    modified
        .elapsed()
        .map(|age| age < window)
        .unwrap_or(true)
}

fn stamp_mtime(dir: &Path) -> Option<SystemTime> {
    fs::metadata(stamp_path(dir))
        .and_then(|meta| meta.modified())
        .ok()
}

fn reclaim_per_bot(
    worktrees: &Path,
    busy_dirs: &HashSet<String>,
    skipped: &HashSet<String>,
    now: SystemTime,
    grace: Duration,
    removed: &mut Vec<RemovedCache>,
) {
    let Ok(repos) = fs::read_dir(worktrees) else {
        return;
    };
    for repo in repos.flatten() {
        if !is_real_dir(&repo.path()) {
            continue;
        }
        if repo
            .file_name()
            .to_str()
            .is_some_and(|key| skipped.contains(key))
        {
            continue;
        }
        reap_leftovers(&repo.path(), removed);
        let Ok(bots) = fs::read_dir(repo.path()) else {
            continue;
        };
        for bot in bots.flatten() {
            let path = bot.path();
            if !is_real_dir(&path) {
                continue;
            }
            let Some(name) = bot.file_name().to_str().map(str::to_string) else {
                continue;
            };
            if busy_dirs.contains(&name) {
                continue;
            }
            reap_leftovers(&path, removed);
            let target = path.join("target");
            if !is_real_dir(&target) || written_since(&target, now, grace) {
                continue;
            }
            if let Some(bytes) = reclaim_tree(&target) {
                removed.push(RemovedCache {
                    path: target,
                    bytes,
                });
                // An off group is not working here. Skip repos never reach this
                // loop. A loose bot still follows the legacy file.
                if enabled_for(&name) {
                    if let Some(key) = repo.file_name().to_str() {
                        let cache = paths::home_dir().join("cargo-target").join(key);
                        if fs::create_dir_all(&cache).is_ok() {
                            point_target_at_cache(&path, &cache);
                        }
                    }
                }
            }
        }
    }
}

fn reclaim_shared(
    worktrees: &Path,
    busy_dirs: &HashSet<String>,
    skipped: &HashSet<String>,
    now: SystemTime,
    stale: Duration,
    removed: &mut Vec<RemovedCache>,
) {
    let root = paths::home_dir().join("cargo-target");
    reap_leftovers(&root, removed);
    let Ok(repos) = fs::read_dir(&root) else {
        return;
    };
    for repo in repos.flatten() {
        let dir = repo.path();
        if !is_real_dir(&dir) {
            continue;
        }
        let Some(key) = repo.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if key.starts_with('.') || skipped.contains(&key) {
            continue;
        }
        let bots = worktrees.join(&key);
        if repo_is_busy(&bots, busy_dirs) || try_hold(&dir).is_none() {
            // A turn or a build is using this cache. Taking the lock failed,
            // or a bot is in a turn, so the week starts over.
            touch_stamp(&dir);
            continue;
        }
        match worktree_bots(&bots) {
            None => continue,
            Some(true) if shared_is_fresh(&dir, now, stale) => continue,
            Some(_) => {}
        }
        if let Some(bytes) = reclaim_tree(&dir) {
            removed.push(RemovedCache { path: dir, bytes });
        }
    }
}

/// `None` when the worktree list could not be read. An unreadable list is not
/// proof the repo is gone, so the caller keeps the cache.
fn worktree_bots(repo_dir: &Path) -> Option<bool> {
    match fs::read_dir(repo_dir) {
        Ok(entries) => Some(
            entries
                .flatten()
                .any(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false)),
        ),
        Err(err) if err.kind() == ErrorKind::NotFound => Some(false),
        Err(_) => None,
    }
}

fn repo_is_busy(repo_dir: &Path, busy_dirs: &HashSet<String>) -> bool {
    let Ok(entries) = fs::read_dir(repo_dir) else {
        return false;
    };
    entries.flatten().any(|entry| {
        entry
            .file_name()
            .to_str()
            .is_some_and(|name| busy_dirs.contains(name))
    })
}

fn shared_is_fresh(dir: &Path, now: SystemTime, stale: Duration) -> bool {
    let cutoff = now.checked_sub(stale).unwrap_or(UNIX_EPOCH);
    if let Some(when) = stamp_mtime(dir) {
        return when >= cutoff;
    }
    // No stamp yet. A directory just created for a bot stays until it is
    // either stamped or old enough that nobody came back for it.
    fs::metadata(dir)
        .and_then(|meta| meta.modified())
        .map(|when| when >= cutoff)
        .unwrap_or(true)
}

fn written_since(dir: &Path, now: SystemTime, window: Duration) -> bool {
    let cutoff = now.checked_sub(window).unwrap_or(UNIX_EPOCH);
    let recent = |path: &Path| {
        fs::symlink_metadata(path)
            .and_then(|meta| meta.modified())
            .map(|when| when >= cutoff)
            .unwrap_or(true)
    };
    if recent(dir) {
        return true;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return true;
    };
    entries.flatten().any(|entry| recent(&entry.path()))
}

fn is_real_dir(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|meta| meta.file_type().is_dir())
        .unwrap_or(false)
}

fn reap_leftovers(parent: &Path, removed: &mut Vec<RemovedCache>) {
    let Ok(entries) = fs::read_dir(parent) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !name.starts_with(".sweep-") {
            continue;
        }
        let path = entry.path();
        if !is_real_dir(&path) {
            continue;
        }
        let bytes = dir_size(&path);
        if fs::remove_dir_all(&path).is_ok() {
            removed.push(RemovedCache { path, bytes });
        }
    }
}

/// Keeps an exclusive lock on `.cargo-lock` until dropped.
struct CargoHold {
    file: Option<File>,
}

impl Drop for CargoHold {
    fn drop(&mut self) {
        if let Some(file) = self.file.take() {
            unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_UN) };
        }
    }
}

/// `None` when a build holds the lock, or the lock file cannot be judged.
fn try_hold(dir: &Path) -> Option<CargoHold> {
    match OpenOptions::new()
        .read(true)
        .write(true)
        .open(dir.join(".cargo-lock"))
    {
        Ok(file) => {
            let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
            if rc == 0 {
                Some(CargoHold { file: Some(file) })
            } else {
                None
            }
        }
        Err(err) if err.kind() == ErrorKind::NotFound => Some(CargoHold { file: None }),
        Err(_) => None,
    }
}

/// Move `dir` aside and delete it. `None` when it is a link, a build holds it,
/// or the rename did not happen.
fn reclaim_tree(dir: &Path) -> Option<u64> {
    if !is_real_dir(dir) {
        return None;
    }
    let hold = try_hold(dir)?;
    let parent = dir.parent()?;
    let tmp = parent.join(format!(
        ".sweep-{}-{}",
        std::process::id(),
        SWEEP_NONCE.fetch_add(1, Ordering::Relaxed)
    ));
    if fs::rename(dir, &tmp).is_err() {
        return None;
    }
    drop(hold);
    let bytes = dir_size(&tmp);
    if let Err(err) = fs::remove_dir_all(&tmp) {
        eprintln!("[crew] build cache {}: {err:#}", tmp.display());
        return None;
    }
    Some(bytes)
}

fn dir_size(dir: &Path) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(path) = stack.pop() {
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.file_type().is_symlink() || meta.is_file() {
            total = total.saturating_add(meta.len());
            continue;
        }
        if !meta.is_dir() {
            continue;
        }
        if let Ok(entries) = fs::read_dir(&path) {
            for entry in entries.flatten() {
                stack.push(entry.path());
            }
        }
    }
    total
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
            std::fs::remove_file(paths::worktree_path()).unwrap();
            assert!(isolates(&repo), "no legacy file means a loose bot is on");
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

    fn temp_repo(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "cw-{tag}-{}-{}",
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
        git(&root, &["add", "readme.txt"]);
        git(&root, &["commit", "-m", "init"]);
        root
    }

    fn is_symlink(path: &Path) -> bool {
        fs::symlink_metadata(path)
            .map(|meta| meta.file_type().is_symlink())
            .unwrap_or(false)
    }

    fn wipe(dir: &Path) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            let meta = std::fs::symlink_metadata(&path).unwrap();
            if meta.is_dir() {
                std::fs::remove_dir_all(&path).unwrap();
            } else {
                std::fs::remove_file(&path).unwrap();
            }
        }
    }

    #[test]
    fn an_empty_worktree_dir_is_created_again() {
        if Command::new("git").arg("--version").output().is_err() {
            return;
        }
        paths::testing::with_home("wt-empty", || {
            let root = temp_repo("empty");
            paths::write_worktrees_enabled(true);
            let first = place_for("bot-empty", &root);
            let dir = first.cwd.clone();
            assert!(first.isolated.is_some());
            wipe(&dir);
            assert!(dir_is_empty(&dir));

            let again = place_for("bot-empty", &root);
            assert_ne!(again.cwd, root);
            assert!(again.isolated.is_some());
            assert_eq!(
                std::fs::read_to_string(again.cwd.join("readme.txt")).unwrap(),
                "hello\n"
            );
            let _ = std::fs::remove_dir_all(&root);
        });
    }

    #[test]
    fn a_blocked_worktree_is_not_the_shared_checkout() {
        if Command::new("git").arg("--version").output().is_err() {
            return;
        }
        paths::testing::with_home("wt-block", || {
            let root = temp_repo("block");
            paths::write_worktrees_enabled(true);
            let dir = worktree_dir("bot-blocked", &root);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("keep.txt"), "mine\n").unwrap();

            let place = place_for("bot-blocked", &root);
            assert_ne!(place.cwd, root);
            assert!(place.isolated.is_none());
            assert_eq!(
                std::fs::read_to_string(dir.join("keep.txt")).unwrap(),
                "mine\n"
            );
            let said = crate::transcript::messages("bot-blocked")
                .iter()
                .any(|m| m.text.contains("공유 체크아웃"));
            assert!(said, "the chat should say the worktree was not made");
            let _ = std::fs::remove_dir_all(&root);
        });
    }

    fn restore_cargo_env() -> Option<std::ffi::OsString> {
        let old = std::env::var_os("CARGO_TARGET_DIR");
        std::env::remove_var("CARGO_TARGET_DIR");
        old
    }

    fn put_cargo_env(old: Option<std::ffi::OsString>) {
        match old {
            Some(value) => std::env::set_var("CARGO_TARGET_DIR", value),
            None => std::env::remove_var("CARGO_TARGET_DIR"),
        }
    }

    struct PutBack(Option<std::ffi::OsString>);

    impl Drop for PutBack {
        fn drop(&mut self) {
            put_cargo_env(self.0.take());
        }
    }

    fn age(path: &Path, secs: u64) {
        let when = SystemTime::now() - Duration::from_secs(secs);
        let file = File::open(path).expect("open to set mtime");
        file.set_modified(when).unwrap();
    }

    #[test]
    fn bots_of_one_repo_share_a_cargo_target() {
        if Command::new("git").arg("--version").output().is_err() {
            return;
        }
        paths::testing::with_home("wt-share", || {
            let _env = PutBack(restore_cargo_env());
            let root = temp_repo("share");
            paths::write_worktrees_enabled(true);
            let first = place_for("bot-a", &root);
            let second = place_for("bot-b", &root);
            let a = cargo_target_for_cwd(&first.cwd).expect("shared target");
            let b = cargo_target_for_cwd(&second.cwd).expect("same repo");
            assert_eq!(a, b);
            assert_eq!(a, cargo_target_dir(&root));
            assert!(a.join(".crew-used").is_file());
            let outside = paths::home_dir().join("not-a-worktree");
            std::fs::create_dir_all(&outside).unwrap();
            assert!(cargo_target_for_cwd(&outside).is_none());
            std::env::set_var("CARGO_TARGET_DIR", "/tmp/crew-chosen-target");
            assert!(cargo_target_for_cwd(&first.cwd).is_none());
            let _ = std::fs::remove_dir_all(&root);
        });
    }

    #[test]
    fn a_skipped_checkout_keeps_its_own_target() {
        if Command::new("git").arg("--version").output().is_err() {
            return;
        }
        paths::testing::with_home("wt-skip", || {
            let _env = PutBack(restore_cargo_env());
            let kept = temp_repo("kept");
            let other = temp_repo("other");
            paths::write_worktrees_enabled(true);
            let home = std::env::var("HOME").expect("HOME");
            let tilde_root = PathBuf::from(&home).join("crew-skip-tilde-not-created");
            std::fs::write(
                paths::home_dir().join("cargo-target-skip"),
                format!(
                    "# leave this checkout alone\n\n~/crew-skip-tilde-not-created\n{}\n",
                    kept.display()
                ),
            )
            .unwrap();
            assert!(
                skipped_repo_keys().contains(&repo_key(&tilde_root)),
                "a leading ~ is the home directory"
            );

            let idle = place_for("bot-kept", &kept);
            assert!(cargo_target_for_cwd(&idle.cwd).is_none());
            note_build_use(&idle.cwd);
            let key = repo_key(&kept);
            let shared_cache = paths::home_dir().join("cargo-target").join(&key);
            assert!(!shared_cache.exists(), "a skipped repo grows no shared cache");

            let target = idle.cwd.join("target");
            std::fs::create_dir_all(target.join("debug")).unwrap();
            std::fs::write(target.join("debug").join("lib.rlib"), vec![7u8; 64]).unwrap();
            age(&target, 3600);
            age(&target.join("debug"), 3600);
            std::fs::create_dir_all(&shared_cache).unwrap();
            std::fs::write(shared_cache.join("lib.rlib"), b"stay").unwrap();
            touch_stamp(&shared_cache);
            age(&stamp_path(&shared_cache), 30 * 24 * 60 * 60);

            let elsewhere = place_for("bot-other", &other);
            let other_target = elsewhere.cwd.join("target");
            if is_symlink(&other_target) {
                std::fs::remove_file(&other_target).unwrap();
            }
            std::fs::create_dir_all(other_target.join("debug")).unwrap();
            std::fs::write(other_target.join("debug").join("lib.rlib"), vec![7u8; 32]).unwrap();
            age(&other_target, 3600);
            age(&other_target.join("debug"), 3600);

            let removed = sweep_at(
                &HashSet::new(),
                SystemTime::now(),
                Duration::from_secs(60),
                Duration::from_secs(60),
            );
            assert!(
                removed.iter().all(|item| item.path != target),
                "an idle skipped target stays"
            );
            assert!(target.join("debug").join("lib.rlib").is_file());
            assert_eq!(std::fs::read(shared_cache.join("lib.rlib")).unwrap(), b"stay");
            assert!(
                removed.iter().any(|item| item.path == other_target),
                "another repo is still swept"
            );
            assert!(
                is_symlink(&other_target),
                "an idle real target becomes the shared-cache link"
            );
            assert_eq!(
                std::fs::read_link(&other_target).unwrap(),
                cargo_target_dir(&other)
            );
            assert!(!other_target.join("debug").join("lib.rlib").exists());
            let shared = cargo_target_for_cwd(&elsewhere.cwd).expect("not skipped");
            assert_eq!(shared, cargo_target_dir(&other));

            let _ = std::fs::remove_dir_all(&kept);
            let _ = std::fs::remove_dir_all(&other);
        });
    }

    #[test]
    fn a_group_is_on_or_off_and_a_loose_bot_keeps_the_old_file() {
        if Command::new("git").arg("--version").output().is_err() {
            return;
        }
        paths::testing::with_home("wt-group", || {
            let _env = PutBack(restore_cargo_env());
            let root = temp_repo("group");
            let group = |id: &str, bot: &str, choice: crate::groups::WorktreeChoice| {
                crate::groups::SidebarGroup {
                    id: id.into(),
                    name: id.into(),
                    collapsed: false,
                    items: vec![format!("agent:{bot}")],
                    path: None,
                    lead: None,
                    worktree: choice,
                }
            };
            use crate::groups::WorktreeChoice::{Off, On};
            let save = |rows: Vec<crate::groups::SidebarGroup>| {
                crate::groups::save(&rows).unwrap();
            };
            save(vec![
                group("on", "bot-on", On),
                group("off", "bot-off", Off),
            ]);
            let uses = |bot: &str| place_for(bot, &root).isolated.is_some();

            assert!(uses("bot-on"), "a group can turn worktrees on");
            assert!(!uses("bot-off"));
            assert!(uses("bot-loose"), "no legacy file means a loose bot is on");

            let made = place_for("bot-on", &root);
            let dir = made.cwd.clone();
            std::fs::write(dir.join("keep.txt"), "mine\n").unwrap();
            let shared = cargo_target_for_cwd(&dir).expect("a worktree shares a cargo target");
            assert_eq!(shared, cargo_target_dir(&root));
            assert!(cargo_target_for_cwd(&root).is_none());

            paths::write_worktrees_enabled(false);
            assert!(uses("bot-on"));
            assert!(!uses("bot-off"), "a group can turn worktrees off");
            assert!(!uses("bot-loose"), "a loose bot keeps an old file that is off");
            paths::write_worktrees_enabled(true);
            assert!(uses("bot-loose"), "a loose bot keeps an old file that is on");
            let off = place_for("bot-off", &root);
            assert!(cargo_target_for_cwd(&off.cwd).is_none());

            save(vec![group("on", "bot-on", Off)]);
            let back = place_for("bot-on", &root);
            assert!(back.isolated.is_none());
            assert_eq!(back.cwd, root);
            assert_eq!(
                std::fs::read_to_string(dir.join("keep.txt")).unwrap(),
                "mine\n",
                "turning it off leaves the worktree"
            );

            save(vec![group("on", "bot-on", On)]);
            std::fs::write(
                paths::home_dir().join("cargo-target-skip"),
                format!("{}\n", root.display()),
            )
            .unwrap();
            let skipped = place_for("bot-on", &root);
            assert!(skipped.isolated.is_some());
            assert!(cargo_target_for_cwd(&skipped.cwd).is_none());

            let _ = std::fs::remove_dir_all(&root);
        });
    }

    #[test]
    fn sweep_drops_an_idle_target_and_keeps_a_busy_one() {
        paths::testing::with_home("wt-sweep", || {
            let idle = paths::home_dir()
                .join("worktrees")
                .join("repo-1")
                .join("bot-idle")
                .join("target");
            let busy = paths::home_dir()
                .join("worktrees")
                .join("repo-1")
                .join("bot-busy")
                .join("target");
            for dir in [&idle, &busy] {
                std::fs::create_dir_all(dir.join("debug")).unwrap();
                std::fs::write(dir.join("debug").join("lib.rlib"), vec![7u8; 64]).unwrap();
                age(dir, 3600);
                age(&dir.join("debug"), 3600);
            }
            let fresh = paths::home_dir()
                .join("worktrees")
                .join("repo-1")
                .join("bot-fresh")
                .join("target");
            std::fs::create_dir_all(fresh.join("debug")).unwrap();
            std::fs::write(fresh.join("debug").join("lib.rlib"), vec![7u8; 8]).unwrap();

            let mut working = HashSet::new();
            working.insert("bot-busy".to_string());
            let removed = sweep_at(
                &working,
                SystemTime::now(),
                Duration::from_secs(60),
                Duration::from_secs(7 * 24 * 60 * 60),
            );
            assert!(
                removed.iter().any(|item| item.path == idle && item.bytes >= 64),
                "idle cache should be reported"
            );
            assert!(is_symlink(&idle), "an idle real target becomes the link");
            assert_eq!(
                std::fs::read_link(&idle).unwrap(),
                paths::home_dir().join("cargo-target").join("repo-1")
            );
            assert!(!idle.join("debug").join("lib.rlib").exists());
            assert!(busy.join("debug").join("lib.rlib").is_file());
            assert!(!is_symlink(&busy));
            assert!(fresh.join("debug").join("lib.rlib").is_file());
            assert!(!is_symlink(&fresh));
        });
    }

    #[test]
    fn sweep_leaves_a_target_cargo_has_locked() {
        paths::testing::with_home("wt-lock", || {
            let target = paths::home_dir()
                .join("worktrees")
                .join("repo-1")
                .join("bot-idle")
                .join("target");
            std::fs::create_dir_all(target.join("debug")).unwrap();
            std::fs::write(target.join("debug").join("lib.rlib"), b"keep").unwrap();
            let lock = File::create(target.join(".cargo-lock")).unwrap();
            age(&target, 3600);
            age(&target.join("debug"), 3600);
            age(&target.join(".cargo-lock"), 3600);
            let rc = unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
            assert_eq!(rc, 0);
            let removed = sweep_at(
                &HashSet::new(),
                SystemTime::now(),
                Duration::from_secs(60),
                Duration::from_secs(60),
            );
            assert!(removed.iter().all(|item| item.path != target));
            assert_eq!(
                std::fs::read(target.join("debug").join("lib.rlib")).unwrap(),
                b"keep"
            );
            drop(lock);
        });
    }

    #[test]
    fn sweep_does_not_follow_a_linked_target() {
        paths::testing::with_home("wt-link", || {
            let real = paths::home_dir().join("real-target");
            std::fs::create_dir_all(&real).unwrap();
            std::fs::write(real.join("keep"), b"safe").unwrap();
            let bot = paths::home_dir()
                .join("worktrees")
                .join("repo-1")
                .join("bot-idle");
            std::fs::create_dir_all(&bot).unwrap();
            std::os::unix::fs::symlink(&real, bot.join("target")).unwrap();
            let _ = sweep_at(
                &HashSet::new(),
                SystemTime::now(),
                Duration::from_secs(0),
                Duration::from_secs(0),
            );
            assert_eq!(std::fs::read(real.join("keep")).unwrap(), b"safe");
        });
    }

    #[test]
    fn sweep_drops_a_shared_cache_when_the_worktrees_are_gone_or_stale() {
        paths::testing::with_home("wt-shared", || {
            let gone = paths::home_dir().join("cargo-target").join("repo-gone");
            std::fs::create_dir_all(&gone).unwrap();
            std::fs::write(gone.join("lib.rlib"), vec![1u8; 16]).unwrap();
            touch_stamp(&gone);

            let live_repo = paths::home_dir().join("worktrees").join("repo-live");
            std::fs::create_dir_all(live_repo.join("bot-a")).unwrap();
            let live = paths::home_dir().join("cargo-target").join("repo-live");
            std::fs::create_dir_all(&live).unwrap();
            std::fs::write(live.join("lib.rlib"), vec![1u8; 16]).unwrap();
            touch_stamp(&live);

            let old_repo = paths::home_dir().join("worktrees").join("repo-old");
            std::fs::create_dir_all(old_repo.join("bot-a")).unwrap();
            let old = paths::home_dir().join("cargo-target").join("repo-old");
            std::fs::create_dir_all(&old).unwrap();
            std::fs::write(old.join("lib.rlib"), vec![1u8; 16]).unwrap();
            touch_stamp(&old);
            age(&stamp_path(&old), 8 * 24 * 60 * 60);

            let week = Duration::from_secs(7 * 24 * 60 * 60);
            let removed = sweep_at(&HashSet::new(), SystemTime::now(), week, week);
            assert!(removed.iter().any(|item| item.path == gone && item.bytes >= 16));
            assert!(!gone.exists());
            assert!(live.join("lib.rlib").is_file(), "a fresh shared cache stays");
            assert!(removed.iter().any(|item| item.path == old));
            assert!(!old.exists(), "a week without use drops the shared cache");
        });
    }

    #[test]
    fn sweep_keeps_a_shared_cache_a_busy_bot_still_has() {
        paths::testing::with_home("wt-shared-busy", || {
            let repo = paths::home_dir().join("worktrees").join("repo-live");
            std::fs::create_dir_all(repo.join("bot-busy")).unwrap();
            let live = paths::home_dir().join("cargo-target").join("repo-live");
            std::fs::create_dir_all(&live).unwrap();
            std::fs::write(live.join("lib.rlib"), b"hot").unwrap();
            touch_stamp(&live);
            age(&stamp_path(&live), 30 * 24 * 60 * 60);
            let mut busy = HashSet::new();
            busy.insert("bot-busy".into());
            let removed = sweep_at(
                &busy,
                SystemTime::now(),
                Duration::from_secs(1),
                Duration::from_secs(1),
            );
            assert!(removed.iter().all(|item| item.path != live));
            assert_eq!(std::fs::read(live.join("lib.rlib")).unwrap(), b"hot");
            assert!(stamp_age_under(&live, Duration::from_secs(60)));
        });
    }

    #[test]
    fn a_worktree_target_links_at_the_shared_cache() {
        if Command::new("git").arg("--version").output().is_err() {
            return;
        }
        paths::testing::with_home("wt-link-cache", || {
            let _env = PutBack(restore_cargo_env());
            let root = temp_repo("link");
            std::fs::write(root.join(".gitignore"), "target/\n").unwrap();
            git(&root, &["add", ".gitignore"]);
            git(&root, &["commit", "-m", "ignore real target dirs"]);
            paths::write_worktrees_enabled(true);

            let place = place_for("bot-link", &root);
            let dir = place.isolated.expect("worktree").dir;
            let cache = cargo_target_dir(&root);
            let link = dir.join("target");
            assert!(is_symlink(&link), "a new worktree points target at the cache");
            assert_eq!(std::fs::read_link(&link).unwrap(), cache);
            assert!(cache.is_dir());
            std::fs::create_dir_all(cache.join("debug")).unwrap();
            std::fs::write(cache.join("debug").join("crew"), b"bin").unwrap();
            assert_eq!(std::fs::read(dir.join("target/debug/crew")).unwrap(), b"bin");

            let status = Command::new("git")
                .arg("-C")
                .arg(&dir)
                .args(["status", "--porcelain"])
                .output()
                .unwrap();
            assert!(status.status.success());
            let text = String::from_utf8_lossy(&status.stdout);
            assert!(
                !text.lines().any(|line| line.contains("target")),
                "git status shows the link: {text}"
            );
            let shared_status = Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(["status", "--porcelain"])
                .output()
                .unwrap();
            assert!(
                String::from_utf8_lossy(&shared_status.stdout)
                    .trim()
                    .is_empty(),
                "the shared checkout stays clean"
            );

            std::fs::remove_file(&link).unwrap();
            std::fs::create_dir_all(link.join("debug")).unwrap();
            std::fs::write(link.join("debug").join("old"), b"old").unwrap();
            age(&link, 3600);
            age(&link.join("debug"), 3600);
            let again = place_for("bot-link", &root);
            assert_eq!(again.cwd, dir);
            assert!(is_symlink(&link), "an idle real target becomes the link");
            assert!(!link.join("debug").join("old").exists());
            assert_eq!(std::fs::read(cache.join("debug").join("crew")).unwrap(), b"bin");

            std::fs::remove_file(&link).unwrap();
            std::fs::create_dir_all(link.join("debug")).unwrap();
            std::fs::write(link.join("debug").join("keep"), b"keep").unwrap();
            let lock = File::create(link.join(".cargo-lock")).unwrap();
            age(&link, 3600);
            age(&link.join("debug"), 3600);
            age(&link.join(".cargo-lock"), 3600);
            let rc = unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
            assert_eq!(rc, 0);
            place_for("bot-link", &root);
            assert!(!is_symlink(&link), "a locked target stays a real directory");
            assert_eq!(std::fs::read(link.join("debug").join("keep")).unwrap(), b"keep");

            let mut working = HashSet::new();
            working.insert("bot-link".into());
            let removed = sweep_at(
                &working,
                SystemTime::now(),
                Duration::from_secs(60),
                Duration::from_secs(7 * 24 * 60 * 60),
            );
            assert!(removed.iter().all(|item| item.path != link));
            assert_eq!(
                std::fs::read(link.join("debug").join("keep")).unwrap(),
                b"keep",
                "a working bot keeps its real target"
            );
            drop(lock);

            let removed = sweep_at(
                &HashSet::new(),
                SystemTime::now(),
                Duration::from_secs(60),
                Duration::from_secs(7 * 24 * 60 * 60),
            );
            assert!(removed.iter().any(|item| item.path == link));
            assert!(is_symlink(&link));
            assert_eq!(
                std::fs::read(cache.join("debug").join("crew")).unwrap(),
                b"bin",
                "a sweep does not follow the link into the shared cache"
            );

            let skipped_root = temp_repo("skipped");
            std::fs::write(
                paths::home_dir().join("cargo-target-skip"),
                format!("{}\n", skipped_root.display()),
            )
            .unwrap();
            let skipped = place_for("bot-skip", &skipped_root);
            let skipped_dir = skipped.isolated.expect("skip still isolates").dir;
            assert!(
                !skipped_dir.join("target").exists(),
                "a skipped repo grows no target link"
            );
            assert!(cargo_target_for_cwd(&skipped.cwd).is_none());

            let off_root = temp_repo("off");
            crate::groups::save(&[crate::groups::SidebarGroup {
                id: "off".into(),
                name: "off".into(),
                collapsed: false,
                items: vec!["agent:bot-off".into()],
                path: None,
                lead: None,
                worktree: crate::groups::WorktreeChoice::Off,
            }])
            .unwrap();
            let off = place_for("bot-off", &off_root);
            assert!(off.isolated.is_none());
            assert!(!off_root.join("target").exists());

            let _ = std::fs::remove_dir_all(&root);
            let _ = std::fs::remove_dir_all(&skipped_root);
            let _ = std::fs::remove_dir_all(&off_root);
        });
    }

    #[test]
    fn format_bytes_uses_mib_and_gib() {
        assert_eq!(format_bytes(12), "12 B");
        assert_eq!(format_bytes(2 * 1024 * 1024), "2.0 MiB");
        assert_eq!(format_bytes(3 * 1024 * 1024 * 1024), "3.0 GiB");
    }
}
