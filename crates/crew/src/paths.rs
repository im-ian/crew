use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

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

pub fn pid_path() -> PathBuf {
    home_dir().join("crew.pid")
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
    transcripts_dir().join(format!("{}.jsonl", safe_agent_id(agent_id)))
}

pub fn roster_path() -> PathBuf {
    home_dir().join("roster.md")
}

pub fn channels_dir() -> PathBuf {
    home_dir().join("channels")
}

pub fn channel_transcript_path(channel_id: &str) -> PathBuf {
    channels_dir().join(format!("{}.jsonl", safe_agent_id(channel_id)))
}

pub fn memory_dir() -> PathBuf {
    home_dir().join("memory")
}

pub fn memory_path(agent_id: &str) -> PathBuf {
    memory_dir().join(format!("{}.md", safe_agent_id(agent_id)))
}

pub fn cli_sessions_dir() -> PathBuf {
    home_dir().join("cli-sessions")
}

pub fn cli_session_path(agent_id: &str) -> PathBuf {
    cli_sessions_dir().join(safe_agent_id(agent_id))
}
