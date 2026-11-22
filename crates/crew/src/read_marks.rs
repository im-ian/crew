//! How far the user has read each chat, by the window's chat key
//! (`agent:<id>`) and the time of the last line seen. Kept in `read.json` in
//! the Crew home, so the window and a paired phone agree: a chat read on the
//! laptop does not open on the phone at the place the phone last saw it.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::paths;

/// Most chats remembered. Past it the ones read longest ago are dropped.
pub const MAX_MARKS: usize = 2000;
/// Longest chat key, in characters.
const KEY_MAX: usize = 200;

static LOCK: Mutex<()> = Mutex::new(());

pub type Marks = BTreeMap<String, u64>;

fn path() -> PathBuf {
    paths::home_dir().join("read.json")
}

fn read() -> Marks {
    fs::read_to_string(path())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write(marks: &Marks) -> Result<(), String> {
    fs::create_dir_all(paths::home_dir()).map_err(|e| format!("write read marks: {e}"))?;
    let raw = serde_json::to_vec(marks).map_err(|e| e.to_string())?;
    paths::write_atomic(&path(), &raw).map_err(|e| format!("write read marks: {e}"))
}

/// Every chat's mark.
pub fn get() -> Marks {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    read()
}

/// Move a chat's mark to `ts`. A mark only moves forward: two devices
/// reading the same chat keep the later of the two. Returns the mark after.
pub fn mark(key: &str, ts: u64) -> Result<u64, String> {
    let key = key.trim();
    if key.is_empty() || key.chars().count() > KEY_MAX || key.chars().any(char::is_control) {
        return Err("that chat cannot be marked read".into());
    }
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut all = read();
    let had = all.get(key).copied().unwrap_or(0);
    if ts <= had {
        return Ok(had);
    }
    all.insert(key.to_string(), ts);
    if all.len() > MAX_MARKS {
        let mut by_age: Vec<(String, u64)> = all.iter().map(|(k, v)| (k.clone(), *v)).collect();
        by_age.sort_by_key(|(_, v)| *v);
        for (k, _) in by_age.into_iter().take(all.len() - MAX_MARKS) {
            all.remove(&k);
        }
    }
    write(&all)?;
    Ok(ts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::testing::with_home;

    #[test]
    fn a_mark_only_moves_forward() {
        with_home("read-marks", || {
            assert!(get().is_empty());
            assert_eq!(mark("agent:dev", 100).unwrap(), 100);
            // The phone still holds an older place: the later one stays.
            assert_eq!(mark("agent:dev", 40).unwrap(), 100);
            assert_eq!(mark("agent:dev", 150).unwrap(), 150);
            mark("agent:ops", 7).unwrap();
            let all = get();
            assert_eq!(all.get("agent:dev"), Some(&150));
            assert_eq!(all.get("agent:ops"), Some(&7));
        });
    }

    #[test]
    fn a_bad_key_is_refused() {
        with_home("read-marks-bad", || {
            assert!(mark("", 1).is_err());
            assert!(mark("agent:a\nb", 1).is_err());
            assert!(mark(&"x".repeat(KEY_MAX + 1), 1).is_err());
            assert!(get().is_empty());
        });
    }

    #[test]
    fn the_oldest_marks_go_past_the_cap() {
        with_home("read-marks-cap", || {
            let mut all = Marks::new();
            for i in 0..MAX_MARKS as u64 {
                all.insert(format!("agent:{i}"), 1000 + i);
            }
            write(&all).unwrap();
            mark("agent:new", 5000).unwrap();
            let after = get();
            assert_eq!(after.len(), MAX_MARKS);
            assert!(!after.contains_key("agent:0"));
            assert_eq!(after.get("agent:new"), Some(&5000));
        });
    }
}
