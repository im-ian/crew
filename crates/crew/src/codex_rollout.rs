//! Codex's `exec --json` leaves its compaction item out (openai/codex#50593),
//! so a compact shows only in the thread's own rollout file. Crew reads what a
//! turn appends there.

use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::Value;

/// How long a turn waits before it looks again for a rollout codex has not
/// written yet. Finding one walks every session folder.
const LOOK_AGAIN: Duration = Duration::from_secs(2);

/// One thread's rollout, read from where this turn first found it.
pub struct Rollout {
    thread: String,
    path: Option<PathBuf>,
    /// Bytes already read, up to the end of the last whole line.
    read: u64,
    next_look: Instant,
}

impl Rollout {
    /// A rollout already there is read from its end: what it holds is earlier
    /// turns'. One codex writes later is this turn's, so it is read whole.
    pub fn new(thread: &str) -> Self {
        let path = find(thread);
        let read = path
            .as_ref()
            .and_then(|p| fs::metadata(p).ok())
            .map_or(0, |m| m.len());
        Self {
            thread: thread.to_string(),
            path,
            read,
            next_look: Instant::now() + LOOK_AGAIN,
        }
    }

    pub fn thread(&self) -> &str {
        &self.thread
    }

    /// Compacts codex finished since the last look.
    pub fn compactions(&mut self) -> usize {
        if self.path.is_none() {
            if Instant::now() < self.next_look {
                return 0;
            }
            self.next_look = Instant::now() + LOOK_AGAIN;
            self.path = find(&self.thread);
        }
        let Some(path) = self.path.as_ref() else {
            return 0;
        };
        let Some(bytes) = read_from(path, self.read) else {
            return 0;
        };
        // A line codex is still writing waits for the next look.
        let Some(end) = bytes.iter().rposition(|&b| b == b'\n') else {
            return 0;
        };
        self.read += end as u64 + 1;
        String::from_utf8_lossy(&bytes[..end])
            .lines()
            .filter(|line| is_compaction(line))
            .count()
    }
}

fn find(thread: &str) -> Option<PathBuf> {
    let sessions = crate::usage::codex_home()?.join("sessions");
    find_in(&sessions, &format!("-{thread}.jsonl"), 3)
}

/// `sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl`. Newest folders first:
/// a thread being resumed is most often a recent one.
fn find_in(dir: &Path, suffix: &str, depth: u32) -> Option<PathBuf> {
    let mut entries: Vec<_> = fs::read_dir(dir).ok()?.flatten().collect();
    entries.sort_by_key(|e| std::cmp::Reverse(e.file_name()));
    for entry in entries {
        let path = entry.path();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() && depth > 0 {
            if let Some(found) = find_in(&path, suffix, depth - 1) {
                return Some(found);
            }
        } else if kind.is_file() && entry.file_name().to_string_lossy().ends_with(suffix) {
            return Some(path);
        }
    }
    None
}

fn read_from(path: &Path, start: u64) -> Option<Vec<u8>> {
    let mut file = fs::File::open(path).ok()?;
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).ok()?;
    Some(buf)
}

/// Codex 0.147 and later finish a `ContextCompaction` item; earlier ones sent
/// `context_compacted`. A fork copies its parent's `compacted` history line
/// but neither event, so a fork does not count as a compact.
fn is_compaction(line: &str) -> bool {
    if !line.contains("ompact") {
        return false;
    }
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return false;
    };
    if v.get("type").and_then(Value::as_str) != Some("event_msg") {
        return false;
    }
    let Some(payload) = v.get("payload") else {
        return false;
    };
    match payload.get("type").and_then(Value::as_str) {
        Some("context_compacted") => true,
        Some("item_completed") => {
            payload.pointer("/item/type").and_then(Value::as_str) == Some("ContextCompaction")
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OLD: &str =
        r#"{"timestamp":"t","type":"event_msg","payload":{"type":"context_compacted"}}"#;
    const NEW: &str = r#"{"timestamp":"t","type":"event_msg","payload":{"type":"item_completed","thread_id":"a","turn_id":"b","item":{"type":"ContextCompaction","id":"c"}}}"#;
    const HISTORY: &str =
        r#"{"timestamp":"t","type":"compacted","payload":{"message":"","replacement_history":[]}}"#;

    #[test]
    fn both_codex_compact_events_count_and_a_copied_history_does_not() {
        assert!(is_compaction(OLD));
        assert!(is_compaction(NEW));
        assert!(!is_compaction(HISTORY));
        assert!(!is_compaction(
            r#"{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"AgentMessage","id":"c"}}}"#
        ));
    }

    #[test]
    fn a_turn_reads_only_what_it_appended_and_waits_for_a_whole_line() {
        let root = std::env::temp_dir().join(format!("crew-codex-rollout-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let day = root.join("sessions/2026/11/04");
        fs::create_dir_all(&day).unwrap();
        let file = day.join("rollout-2026-11-04T10-00-00-thread-1.jsonl");
        fs::write(&file, format!("{OLD}\n")).unwrap();
        assert_eq!(
            find_in(&root.join("sessions"), "-thread-1.jsonl", 3),
            Some(file.clone())
        );

        let mut rollout = Rollout {
            thread: "thread-1".into(),
            path: Some(file.clone()),
            read: fs::metadata(&file).unwrap().len(),
            next_look: Instant::now(),
        };
        assert_eq!(rollout.compactions(), 0);

        let mut f = fs::OpenOptions::new().append(true).open(&file).unwrap();
        use std::io::Write;
        write!(f, "{HISTORY}\n{NEW}").unwrap();
        assert_eq!(rollout.compactions(), 0);
        writeln!(f).unwrap();
        assert_eq!(rollout.compactions(), 1);
        assert_eq!(rollout.compactions(), 0);
        let _ = fs::remove_dir_all(&root);
    }
}
