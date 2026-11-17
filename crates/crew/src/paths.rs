use std::fs::{self, File, OpenOptions};
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::Context;

pub fn home_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("CREW_HOME") {
        return PathBuf::from(dir);
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    PathBuf::from(home).join("Library/Application Support/crew")
}

pub fn ensure_home() -> anyhow::Result<PathBuf> {
    let dir = home_dir();
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

pub fn socket_path() -> PathBuf {
    home_dir().join("crew.sock")
}

pub fn agents_path() -> PathBuf {
    home_dir().join("agents.json")
}

pub fn groups_path() -> PathBuf {
    home_dir().join("groups.json")
}

pub fn locale_path() -> PathBuf {
    home_dir().join("locale")
}

/// Language for daemon-side strings (desktop notifications, CLI labels).
/// The desktop app mirrors its UI language here. Korean when unset.
pub fn locale() -> String {
    match fs::read_to_string(locale_path()) {
        Ok(s) if s.trim() == "en" => "en".into(),
        _ => "ko".into(),
    }
}

pub fn write_locale(locale: &str) {
    let value = if locale.trim() == "en" { "en" } else { "ko" };
    let _ = fs::create_dir_all(home_dir());
    let _ = fs::write(locale_path(), value);
}

pub fn notifications_path() -> PathBuf {
    home_dir().join("notifications")
}

/// Desktop notifications. On when unset, so an older install keeps alerting.
pub fn notifications_enabled() -> bool {
    match fs::read_to_string(notifications_path()) {
        Ok(s) if s.trim() == "off" => false,
        _ => true,
    }
}

pub fn write_notifications_enabled(on: bool) {
    let _ = fs::create_dir_all(home_dir());
    let _ = fs::write(notifications_path(), if on { "on" } else { "off" });
}

pub fn lead_only_notify_path() -> PathBuf {
    home_dir().join("notify-lead-only")
}

/// In a sidebar group with a lead, only the lead's finishes notify. Off when
/// unset, so every bot keeps notifying as before.
pub fn lead_only_notify() -> bool {
    match fs::read_to_string(lead_only_notify_path()) {
        Ok(s) => s.trim() == "on",
        Err(_) => false,
    }
}

pub fn write_lead_only_notify(on: bool) {
    let _ = fs::create_dir_all(home_dir());
    let _ = fs::write(lead_only_notify_path(), if on { "on" } else { "off" });
}

pub fn worktree_path() -> PathBuf {
    home_dir().join("worktree")
}

/// Bots work in their own git worktree. Off when unset, so an older install
/// keeps editing the folder it was given.
pub fn worktrees_enabled() -> bool {
    match fs::read_to_string(worktree_path()) {
        Ok(s) if s.trim() == "on" => true,
        _ => false,
    }
}

pub fn write_worktrees_enabled(on: bool) {
    let _ = fs::create_dir_all(home_dir());
    let _ = fs::write(worktree_path(), if on { "on" } else { "off" });
}

pub fn pid_path() -> PathBuf {
    home_dir().join("crew.pid")
}

pub fn ui_pid_path() -> PathBuf {
    home_dir().join("ui.pid")
}

pub fn write_ui_pid() {
    let _ = fs::write(ui_pid_path(), format!("{}\n", std::process::id()));
}

pub fn clear_ui_pid() {
    let _ = fs::remove_file(ui_pid_path());
}

pub fn ui_is_live() -> bool {
    let raw = match fs::read_to_string(ui_pid_path()) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let pid: i32 = match raw.trim().parse() {
        Ok(n) if n > 0 => n,
        _ => return false,
    };
    unsafe { libc::kill(pid, 0) == 0 }
}

pub fn log_path() -> PathBuf {
    home_dir().join("crew.log")
}

pub fn expand_tilde(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
        return PathBuf::from(home).join(rest);
    }
    if path == "~" {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
        return PathBuf::from(home);
    }
    PathBuf::from(path)
}

pub fn resolve_program(name: &str) -> PathBuf {
    let expanded = expand_tilde(name);
    if expanded.is_absolute() || expanded.components().count() > 1 {
        return expanded;
    }
    let extra = extra_bin_dirs();
    let path = std::env::var("PATH").unwrap_or_default();
    let mut dirs: Vec<PathBuf> = extra;
    dirs.extend(std::env::split_paths(&path));
    for dir in dirs {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return candidate;
        }
    }
    PathBuf::from(name)
}

pub fn extra_bin_dirs() -> Vec<PathBuf> {
    let home = PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/tmp".into()));
    vec![
        home.join(".grok/bin"),
        home.join(".local/bin"),
        home.join(".cargo/bin"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/bin"),
        PathBuf::from("/usr/bin"),
    ]
}

pub fn crew_bin_dir() -> Option<PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            return Some(parent.to_path_buf());
        }
    }
    let arg0 = std::env::args_os().next()?;
    let p = PathBuf::from(arg0);
    let parent = p.parent()?;
    if parent.as_os_str().is_empty() {
        None
    } else {
        Some(parent.to_path_buf())
    }
}

pub fn enriched_path() -> String {
    let mut dirs = Vec::new();
    if let Some(dir) = crew_bin_dir() {
        dirs.push(dir);
    }
    dirs.extend(extra_bin_dirs());
    if let Ok(path) = std::env::var("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    let mut seen = std::collections::BTreeSet::new();
    let mut out = Vec::new();
    for dir in dirs {
        let key = dir.display().to_string();
        if seen.insert(key) {
            out.push(dir);
        }
    }
    std::env::join_paths(out)
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|_| std::env::var("PATH").unwrap_or_default())
}

pub fn remove_stale_socket() {
    let sock = socket_path();
    if sock.exists() {
        let _ = fs::remove_file(&sock);
    }
}

/// Which file the socket path points at, as the kernel sees it. Two daemons
/// can end up with a socket each — one unlinks the other's and binds its own —
/// and the one that was unlinked has no other way to notice: its listener
/// still works, nothing connects to it, and the path now names somebody else.
pub fn socket_identity() -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let meta = fs::metadata(socket_path()).ok()?;
    Some((meta.dev(), meta.ino()))
}

pub fn is_socket_live() -> bool {
    let sock = socket_path();
    if !sock.exists() {
        return false;
    }
    std::os::unix::net::UnixStream::connect(&sock).is_ok()
}

pub fn write_pid(pid: u32) -> anyhow::Result<()> {
    ensure_home()?;
    fs::write(pid_path(), pid.to_string())?;
    Ok(())
}

pub fn read_pid() -> Option<u32> {
    fs::read_to_string(pid_path()).ok()?.trim().parse().ok()
}

pub fn remove_pid() {
    let _ = fs::remove_file(pid_path());
}

/// `pid` is still a process. `0` is not a daemon: `kill(0, 0)` asks about
/// the whole group and would look alive.
pub fn pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    let rc = unsafe { libc::kill(pid as i32, 0) };
    rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

pub fn lock_path() -> PathBuf {
    home_dir().join("crew.lock")
}

/// The exclusive lock `daemon::run` holds for its whole life. Dropping the
/// file releases it. A second open of this path in the same process would
/// drop the lock on close, so only another process may ask `daemon_lock_held`.
pub struct DaemonLock {
    _file: File,
}

/// Take the daemon lock without waiting. `None` means another process has it.
pub fn try_daemon_lock() -> anyhow::Result<Option<DaemonLock>> {
    ensure_home()?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(lock_path())
        .with_context(|| format!("open {}", lock_path().display()))?;
    match lock_exclusive(&file) {
        Ok(true) => Ok(Some(DaemonLock { _file: file })),
        Ok(false) => Ok(None),
        Err(err) => Err(err).context("lock crew.lock"),
    }
}

/// Whether some other process holds `crew.lock`. Does not take the lock.
pub fn daemon_lock_held() -> bool {
    let Ok(file) = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(lock_path())
    else {
        return false;
    };
    let mut fl: libc::flock = unsafe { std::mem::zeroed() };
    fl.l_type = libc::F_WRLCK;
    fl.l_whence = libc::SEEK_SET as i16;
    let rc = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETLK, &mut fl) };
    rc == 0 && fl.l_type != libc::F_UNLCK
}

/// A daemon has the lock, or the pid file names a live process, so a start
/// should wait for the socket instead of spawning another one.
pub fn daemon_coming_up() -> bool {
    daemon_lock_held() || read_pid().is_some_and(pid_alive)
}

/// Poll until the socket accepts a connection, or `timeout` runs out.
pub fn wait_for_socket(timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if is_socket_live() {
            return true;
        }
        if Instant::now() >= deadline {
            return is_socket_live();
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn lock_exclusive(file: &File) -> std::io::Result<bool> {
    let mut fl: libc::flock = unsafe { std::mem::zeroed() };
    fl.l_type = libc::F_WRLCK;
    fl.l_whence = libc::SEEK_SET as i16;
    let rc = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETLK, &mut fl) };
    if rc == 0 {
        return Ok(true);
    }
    let err = std::io::Error::last_os_error();
    if err.raw_os_error() == Some(libc::EAGAIN) || err.raw_os_error() == Some(libc::EACCES) {
        Ok(false)
    } else {
        Err(err)
    }
}

pub fn daemon_version_path() -> PathBuf {
    home_dir().join("daemon.version")
}

pub fn write_daemon_version(version: &str) -> anyhow::Result<()> {
    ensure_home()?;
    fs::write(daemon_version_path(), format!("{version}\n"))?;
    Ok(())
}

pub fn read_daemon_version() -> Option<String> {
    let raw = fs::read_to_string(daemon_version_path()).ok()?;
    let version = raw.trim();
    if version.is_empty() {
        None
    } else {
        Some(version.to_string())
    }
}

pub fn remove_daemon_version() {
    let _ = fs::remove_file(daemon_version_path());
}

/// True when the live daemon was started by this same package version.
pub fn daemon_version_matches(current: &str) -> bool {
    read_daemon_version().as_deref() == Some(current)
}

pub fn create_cwd(path: &Path) -> anyhow::Result<()> {
    fs::create_dir_all(path)?;
    Ok(())
}

pub fn safe_agent_id(id: &str) -> String {
    let s: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if s.is_empty() {
        "agent".into()
    } else {
        s
    }
}

/// Write `bytes` to a new file `<stamp>-<name>` in `dir`, never over another.
/// Pasted pictures are all `image.png` and the stamp counts seconds, so two in
/// one second would share a name: the later one is `<stamp>-2-<name>`.
pub fn write_new_file(
    dir: &Path,
    stamp: &str,
    name: &str,
    bytes: &[u8],
) -> std::io::Result<PathBuf> {
    use std::io::Write;
    for n in 1u32.. {
        let path = if n == 1 {
            dir.join(format!("{stamp}-{name}"))
        } else {
            dir.join(format!("{stamp}-{n}-{name}"))
        };
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => {
                // A half-written file would keep the name taken for nothing.
                if let Err(err) = file.write_all(bytes) {
                    let _ = fs::remove_file(&path);
                    return Err(err);
                }
                return Ok(path);
            }
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(err),
        }
    }
    unreachable!("ran out of names in {}", dir.display())
}

pub fn utc_timestamp() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (y, mo, d, h, mi, s) = secs_to_utc(secs);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}-{mi:02}-{s:02}Z")
}

fn secs_to_utc(mut secs: u64) -> (i32, u32, u32, u32, u32, u32) {
    let s = (secs % 60) as u32;
    secs /= 60;
    let mi = (secs % 60) as u32;
    secs /= 60;
    let h = (secs % 24) as u32;
    let mut days = secs / 24;
    let mut y = 1970i32;
    loop {
        let len = if is_leap(y) { 366 } else { 365 };
        if days < len {
            break;
        }
        days -= len;
        y += 1;
    }
    let months = [
        31,
        if is_leap(y) { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut mo = 1u32;
    for mlen in months {
        if days < mlen as u64 {
            break;
        }
        days -= mlen as u64;
        mo += 1;
    }
    (y, mo, days as u32 + 1, h, mi, s)
}

fn is_leap(y: i32) -> bool {
    y % 4 == 0 && (y % 100 != 0 || y % 400 == 0)
}

pub fn archive_agent_dir(agent_id: &str, stamp: &str) -> PathBuf {
    home_dir()
        .join("archive")
        .join(safe_agent_id(agent_id))
        .join(stamp)
}

pub fn transcripts_dir() -> PathBuf {
    home_dir().join("transcripts")
}

pub fn transcript_path(agent_id: &str) -> PathBuf {
    // A bot on another PC is `<alias>/<account>`. Its file is apart from any
    // local id that flattens to the same name.
    if let Some((alias, account)) = agent_id.split_once('/') {
        return transcripts_dir().join(format!(
            "remote~{}~{}.jsonl",
            safe_agent_id(alias),
            safe_agent_id(account)
        ));
    }
    transcripts_dir().join(format!("{}.jsonl", safe_agent_id(agent_id)))
}

/// Epoch, parked user lines, and bot-to-bot tells that have not been accepted.
/// The inbox itself dies with the process. This file is only those waits.
pub fn waits_path(agent_id: &str) -> PathBuf {
    home_dir()
        .join("waits")
        .join(format!("{}.json", safe_agent_id(agent_id)))
}

pub fn roster_path() -> PathBuf {
    home_dir().join("roster.md")
}

/// Team notes. The live teammate list is not stored here; it is written in
/// when the prompt or `crew share show` is built.
pub fn shared_memory_path() -> PathBuf {
    home_dir().join("shared.md")
}

pub fn memory_dir() -> PathBuf {
    home_dir().join("memory")
}

pub fn memory_path(agent_id: &str) -> PathBuf {
    memory_dir().join(format!("{}.md", safe_agent_id(agent_id)))
}

/// Notes the user keeps for one sidebar group, by group id.
pub fn group_memory_path(group_id: &str) -> PathBuf {
    home_dir()
        .join("group-memory")
        .join(format!("{}.md", safe_agent_id(group_id)))
}

/// Whole or not at all, for a file another process may read mid-write. One
/// temp name per write, since daemon threads write too.
pub fn write_atomic(path: &Path, data: &[u8]) -> std::io::Result<()> {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".{}-{n}.tmp", std::process::id()));
    let tmp = path.with_file_name(name);
    fs::write(&tmp, data)?;
    fs::rename(&tmp, path).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })
}

pub fn cli_sessions_dir() -> PathBuf {
    home_dir().join("cli-sessions")
}

pub fn cli_session_path(agent_id: &str) -> PathBuf {
    cli_sessions_dir().join(safe_agent_id(agent_id))
}

pub fn cli_memory_path(agent_id: &str) -> PathBuf {
    home_dir().join("cli-memory").join(safe_agent_id(agent_id))
}

/// The shared memory note this bot's CLI session was last given.
pub fn cli_shared_path(agent_id: &str) -> PathBuf {
    home_dir().join("cli-shared").join(safe_agent_id(agent_id))
}

/// A teammate's tell this bot was on when the session compacted, so the next
/// prompt can repeat it. Absent once a later turn has it and did not compact.
pub fn cli_tell_path(agent_id: &str) -> PathBuf {
    home_dir().join("cli-tell").join(safe_agent_id(agent_id))
}

pub fn cli_recap_path(agent_id: &str) -> PathBuf {
    home_dir().join("cli-recaps").join(safe_agent_id(agent_id))
}

#[cfg(test)]
pub(crate) mod testing {
    use std::fs;
    use std::sync::Mutex;

    static LOCK: Mutex<()> = Mutex::new(());

    /// Run `f` with `CREW_HOME` pointed at a fresh temp dir. Serialised across the
    /// suite, since the env var is process-wide.
    pub fn with_home<R>(tag: &str, f: impl FnOnce() -> R) -> R {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // Short on purpose: tests bind a socket in here, and macOS caps a
        // unix path at 104 bytes counting the temp dir in front of it.
        let dir = std::env::temp_dir().join(format!(
            "cw-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos() % 1_000_000)
                .unwrap_or(0)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp home");
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
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two pastes in one second keep both pictures.
    #[test]
    fn a_new_file_never_writes_over_another() {
        let dir = std::env::temp_dir().join(format!(
            "crew-new-file-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&dir).unwrap();
        let stamp = "2026-11-13T02-00-00Z";
        let a = write_new_file(&dir, stamp, "image_png", b"first").unwrap();
        let b = write_new_file(&dir, stamp, "image_png", b"second").unwrap();
        let c = write_new_file(&dir, stamp, "image_png", b"third").unwrap();
        assert_eq!(a, dir.join("2026-11-13T02-00-00Z-image_png"));
        assert_eq!(b, dir.join("2026-11-13T02-00-00Z-2-image_png"));
        assert_eq!(c, dir.join("2026-11-13T02-00-00Z-3-image_png"));
        assert_eq!(fs::read(&a).unwrap(), b"first");
        assert_eq!(fs::read(&b).unwrap(), b"second");
        assert_eq!(fs::read(&c).unwrap(), b"third");
        let _ = fs::remove_dir_all(&dir);
    }

    /// The whole orphan check rests on this telling one socket from the next
    /// at the same path — a comparison on the path alone would never fire.
    #[test]
    fn a_rebound_socket_is_a_different_socket() {
        testing::with_home("ident", || {
            ensure_home().expect("home");
            assert_eq!(socket_identity(), None, "nothing bound yet");

            let first = std::os::unix::net::UnixListener::bind(socket_path()).expect("bind");
            let before = socket_identity().expect("bound");

            assert_eq!(socket_identity(), Some(before), "same socket, same answer");

            // What the losing daemon in the race has done to us.
            remove_stale_socket();
            assert_eq!(socket_identity(), None, "unlinked");
            let second = std::os::unix::net::UnixListener::bind(socket_path()).expect("rebind");
            assert_ne!(
                socket_identity(),
                Some(before),
                "a new socket at the same path is not ours"
            );

            drop(first);
            drop(second);
        });
    }

    #[test]
    fn locale_defaults_to_korean_and_only_accepts_known_tags() {
        testing::with_home("locale", || {
            assert_eq!(locale(), "ko");
            write_locale("en");
            assert_eq!(locale(), "en");
            write_locale("ko");
            assert_eq!(locale(), "ko");
            write_locale("  en\n");
            assert_eq!(locale(), "en");
            write_locale("klingon");
            assert_eq!(
                locale(),
                "ko",
                "an unknown tag falls back, it does not stick"
            );
            fs::write(locale_path(), "en").unwrap();
            assert_eq!(locale(), "en");
        });
    }

    #[test]
    fn lead_only_notify_defaults_off_and_only_on_enables_it() {
        testing::with_home("leadnote", || {
            assert!(!lead_only_notify());
            write_lead_only_notify(true);
            assert!(lead_only_notify());
            write_lead_only_notify(false);
            assert!(!lead_only_notify());
            fs::write(lead_only_notify_path(), "on\n").unwrap();
            assert!(lead_only_notify());
            fs::write(lead_only_notify_path(), "yes").unwrap();
            assert!(!lead_only_notify());
        });
    }

    #[test]
    fn notifications_default_on_and_only_off_disables_them() {
        testing::with_home("notify", || {
            assert!(notifications_enabled());
            write_notifications_enabled(false);
            assert!(!notifications_enabled());
            write_notifications_enabled(true);
            assert!(notifications_enabled());
            fs::write(notifications_path(), "off\n").unwrap();
            assert!(!notifications_enabled());
            fs::write(notifications_path(), "nope").unwrap();
            assert!(notifications_enabled());
        });
    }

    #[test]
    fn worktrees_default_off_and_only_on_enables_them() {
        testing::with_home("worktree", || {
            assert!(!worktrees_enabled());
            write_worktrees_enabled(true);
            assert!(worktrees_enabled());
            write_worktrees_enabled(false);
            assert!(!worktrees_enabled());
            fs::write(worktree_path(), "on\n").unwrap();
            assert!(worktrees_enabled());
            fs::write(worktree_path(), "yes").unwrap();
            assert!(!worktrees_enabled());
        });
    }

    #[test]
    fn daemon_version_roundtrip_and_match() {
        testing::with_home("daemon-version", || {
            assert!(
                !daemon_version_matches("0.1.0"),
                "a missing file is treated as a stale daemon"
            );
            write_daemon_version("0.1.0").unwrap();
            assert!(daemon_version_matches("0.1.0"));
            assert!(!daemon_version_matches("0.2.0"));
            remove_daemon_version();
            assert!(!daemon_version_matches("0.1.0"));
        });
    }

    #[test]
    fn a_dead_pid_is_not_a_daemon_coming_up() {
        testing::with_home("pid-alive", || {
            assert!(pid_alive(std::process::id()));
            assert!(!pid_alive(0));
            let mut child = std::process::Command::new("sleep")
                .arg("30")
                .spawn()
                .expect("sleep");
            let pid = child.id();
            assert!(pid_alive(pid));
            child.kill().expect("kill");
            child.wait().expect("wait");
            assert!(!pid_alive(pid));
            write_pid(pid).unwrap();
            assert!(!daemon_coming_up());
        });
    }

    /// The lock is per process. Opening `crew.lock` again in the holder and
    /// closing that fd releases every lock this process has, so the probe is
    /// a child. The holder must not call `daemon_lock_held` while it holds it.
    #[test]
    fn a_second_process_cannot_take_the_daemon_lock() {
        match std::env::var("CREW_LOCK_PROBE").ok().as_deref() {
            Some("held") => {
                let held = daemon_lock_held();
                let got = try_daemon_lock().ok().flatten();
                assert!(
                    held && got.is_none(),
                    "want held, held={held} got={}",
                    got.is_some()
                );
                println!("held");
                return;
            }
            Some("free") => {
                let held = daemon_lock_held();
                let got = try_daemon_lock().ok().flatten();
                assert!(
                    !held && got.is_some(),
                    "want free, held={held} got={}",
                    got.is_some()
                );
                println!("free");
                return;
            }
            _ => {}
        }
        testing::with_home("daemon-lock", || {
            let lock = try_daemon_lock().expect("lock").expect("first lock");
            let home = home_dir();
            let out = lock_probe(&home, "held");
            assert!(
                out.status.success(),
                "held probe {}: {}",
                out.status,
                String::from_utf8_lossy(&out.stderr)
            );
            assert!(
                String::from_utf8_lossy(&out.stdout).contains("held"),
                "{}",
                String::from_utf8_lossy(&out.stdout)
            );
            drop(lock);
            let out = lock_probe(&home, "free");
            assert!(
                out.status.success(),
                "free probe {}: {}",
                out.status,
                String::from_utf8_lossy(&out.stderr)
            );
            assert!(
                String::from_utf8_lossy(&out.stdout).contains("free"),
                "{}",
                String::from_utf8_lossy(&out.stdout)
            );
        });
    }

    fn lock_probe(home: &std::path::Path, mode: &str) -> std::process::Output {
        std::process::Command::new(std::env::current_exe().expect("exe"))
            .arg("--exact")
            .arg("paths::tests::a_second_process_cannot_take_the_daemon_lock")
            .arg("--nocapture")
            .env("CREW_LOCK_PROBE", mode)
            .env("CREW_HOME", home)
            .output()
            .expect("child")
    }

    #[test]
    fn wait_for_socket_sees_a_listener() {
        testing::with_home("sock-wait", || {
            assert!(!wait_for_socket(Duration::from_millis(80)));
            let listener = std::os::unix::net::UnixListener::bind(socket_path()).expect("bind");
            assert!(wait_for_socket(Duration::from_secs(2)));
            drop(listener);
        });
    }
}
