//! Whether a bot's turn was cut off by a daemon restart.
//!
//! PR #293 (`waits/<id>.json`'s `turn`) writes that record before the CLI
//! gets the prompt and leaves it on disk when the process dies. A turn that
//! is still running writes the same field, so this only counts a record with
//! nobody running it. The file is read and never rewritten: a later build
//! that owns the record must not lose fields this one does not know.

use serde_json::Value;

use crate::paths;

/// `running` is the headless CLI still being inside the turn. A record left
/// behind while nothing is running it is the turn a restart cut off.
pub fn cut_off(id: &str, running: bool) -> bool {
    !running && turn_on_disk(id)
}

fn turn_on_disk(id: &str) -> bool {
    let Ok(bytes) = std::fs::read(paths::waits_path(id)) else {
        return false;
    };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return false;
    };
    match value.get("turn") {
        Some(turn) if !turn.is_null() => true,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_turn_left_on_disk_is_a_cut_when_nothing_is_running_it() {
        paths::testing::with_home("idle-cut", || {
            let id = "bot";
            let path = paths::waits_path(id);
            assert!(!cut_off(id, false), "no file");

            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            let waiting = br#"{"epoch":1,"parked":[],"tells":[]}"#;
            std::fs::write(&path, waiting).unwrap();
            assert!(!cut_off(id, false), "waits without a turn");

            let recorded = br#"{"epoch":2,"turn":{"text":"fix the rail","resumes":0}}"#;
            std::fs::write(&path, recorded).unwrap();
            assert!(cut_off(id, false));
            assert!(!cut_off(id, true), "a live turn writes the same field");

            std::fs::write(&path, br#"{"turn":null}"#).unwrap();
            assert!(!cut_off(id, false));

            std::fs::write(&path, recorded).unwrap();
            assert!(cut_off(id, false));
            assert_eq!(std::fs::read(&path).unwrap(), recorded, "the file is only read");
        });
    }
}
