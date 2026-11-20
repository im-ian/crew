//! What a user pinned in a bot's archive tab: a link, a file or an image,
//! each by a key the window chooses (the daemon does not read it). Kept per
//! bot in `pins.json` in the Crew home, so the window and a paired phone see
//! the same pins.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::paths;

/// Most pins a bot keeps. The oldest is not dropped: a new one past this is refused.
pub const MAX_PINS: usize = 200;
/// Longest key, in characters. A key is a URL or a path, not a document.
const KEY_MAX: usize = 2000;

/// One writer at a time in this process; the file is whole or not at all for
/// the other (`write_atomic`).
static LOCK: Mutex<()> = Mutex::new(());

fn path() -> PathBuf {
    paths::home_dir().join("pins.json")
}

type Pins = BTreeMap<String, Vec<String>>;

fn read() -> Pins {
    fs::read_to_string(path())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write(pins: &Pins) -> Result<(), String> {
    if pins.is_empty() {
        return match fs::remove_file(path()) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("write pins: {e}")),
        };
    }
    fs::create_dir_all(paths::home_dir()).map_err(|e| format!("write pins: {e}"))?;
    let raw = serde_json::to_vec_pretty(pins).map_err(|e| e.to_string())?;
    paths::write_atomic(&path(), &raw).map_err(|e| format!("write pins: {e}"))
}

/// The bot's pins, oldest first.
pub fn get(agent: &str) -> Vec<String> {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    read().remove(agent).unwrap_or_default()
}

/// Pin `key` (at the end, once) or unpin it. Returns the bot's pins after.
pub fn set(agent: &str, key: &str, pinned: bool) -> Result<Vec<String>, String> {
    if agent.trim().is_empty() {
        return Err("pin needs a bot".into());
    }
    let key = key.trim();
    if key.is_empty() {
        return Err("pin needs a key".into());
    }
    if key.chars().count() > KEY_MAX || key.chars().any(char::is_control) {
        return Err("that key cannot be pinned".into());
    }
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut all = read();
    let mine = all.entry(agent.to_string()).or_default();
    let at = mine.iter().position(|k| k == key);
    match (pinned, at) {
        (true, None) => {
            if mine.len() >= MAX_PINS {
                return Err(format!("a bot keeps at most {MAX_PINS} pins"));
            }
            mine.push(key.to_string());
        }
        (false, Some(i)) => {
            mine.remove(i);
        }
        _ => {}
    }
    let now = mine.clone();
    if now.is_empty() {
        all.remove(agent);
    }
    write(&all)?;
    Ok(now)
}

/// Forget all of a bot's pins, as when the bot is removed.
pub fn clear(agent: &str) -> Result<(), String> {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut all = read();
    if all.remove(agent).is_some() {
        write(&all)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::testing::with_home;

    #[test]
    fn a_pin_is_kept_once_in_order_and_unpinned() {
        with_home("pins", || {
            assert!(get("dev").is_empty());
            assert_eq!(set("dev", "https://a.example/1", true).unwrap(), vec!["https://a.example/1"]);
            set("dev", "/tmp/x.png", true).unwrap();
            // Pinning again changes nothing.
            let now = set("dev", "https://a.example/1", true).unwrap();
            assert_eq!(now, vec!["https://a.example/1", "/tmp/x.png"]);
            // Another bot's pins are its own.
            set("qa", "https://b.example", true).unwrap();
            assert_eq!(get("dev"), now);
            assert_eq!(get("qa"), vec!["https://b.example"]);
            // They survive a fresh read, and unpinning one leaves the other.
            assert_eq!(set("dev", "https://a.example/1", false).unwrap(), vec!["/tmp/x.png"]);
            assert_eq!(get("dev"), vec!["/tmp/x.png"]);
            // Unpinning what is not pinned is no error.
            assert_eq!(set("dev", "nope", false).unwrap(), vec!["/tmp/x.png"]);
        });
    }

    #[test]
    fn clearing_a_bot_forgets_its_pins_and_the_last_one_removes_the_file() {
        with_home("pins-clear", || {
            set("dev", "a", true).unwrap();
            set("qa", "b", true).unwrap();
            clear("dev").unwrap();
            assert!(get("dev").is_empty());
            assert_eq!(get("qa"), vec!["b"]);
            clear("nobody").unwrap();
            assert!(path().exists());
            set("qa", "b", false).unwrap();
            assert!(!path().exists(), "an empty pin file is not left behind");
        });
    }

    #[test]
    fn a_bad_pin_is_refused() {
        with_home("pins-bad", || {
            assert!(set("", "a", true).is_err());
            assert!(set("dev", "  ", true).is_err());
            assert!(set("dev", "a\nb", true).is_err());
            assert!(set("dev", &"x".repeat(KEY_MAX + 1), true).is_err());
            for i in 0..MAX_PINS {
                set("dev", &format!("k{i}"), true).unwrap();
            }
            assert!(set("dev", "one more", true).is_err());
            // Unpinning still works at the limit.
            assert_eq!(set("dev", "k0", false).unwrap().len(), MAX_PINS - 1);
        });
    }

    #[test]
    fn a_broken_file_reads_as_no_pins() {
        with_home("pins-broken", || {
            fs::write(path(), "{not json").unwrap();
            assert!(get("dev").is_empty());
            assert_eq!(set("dev", "a", true).unwrap(), vec!["a"]);
        });
    }
}
