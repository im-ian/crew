//! The window's page data across a change of the app's bundle identifier.
//!
//! The window's settings (theme, fonts, last chat, … in `localStorage`) and
//! its other page data are kept by WebKit under the app's bundle identifier:
//! `~/Library/WebKit/<identifier>/WebsiteData/…`. An app with another
//! identifier starts with none, so the first start under `com.imian.crew`
//! copies what `dev.jthefloor.crew` left, before the window (and so WebKit)
//! exists. Copied, not moved: the old folder stays, and so does the way back.
//!
//! The bots and their chats are not in there: they are in `~/Library/Application
//! Support/crew` (`CREW_HOME`), which an identifier does not touch.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// The identifier of the app until 0.15.1.
pub const OLD_ID: &str = "dev.jthefloor.crew";
/// The identifier from the next release on. `tauri.conf.json` says the same.
pub const NEW_ID: &str = "com.imian.crew";

#[derive(Debug, PartialEq, Eq)]
pub enum Carried {
    /// What the old identifier left was copied to the new one.
    Copied,
    /// Done before, or nothing to do.
    Skipped(&'static str),
}

fn data_dir(home: &Path, id: &str) -> PathBuf {
    home.join("Library").join("WebKit").join(id)
}

/// A mark in the Crew home that this was done, so it happens once: not again
/// when the new folder is later emptied on purpose.
fn marker(crew_home: &Path, from: &str) -> PathBuf {
    crew_home.join(format!("webkit-carried-{from}"))
}

fn is_empty_dir(dir: &Path) -> io::Result<bool> {
    Ok(fs::read_dir(dir)?.next().is_none())
}

/// Copy `from` to `to`, files, folders and links, with the modes they have.
fn copy_tree(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let (src, dst) = (entry.path(), to.join(entry.file_name()));
        let kind = entry.file_type()?;
        if kind.is_dir() {
            copy_tree(&src, &dst)?;
        } else if kind.is_symlink() {
            #[cfg(unix)]
            std::os::unix::fs::symlink(fs::read_link(&src)?, &dst)?;
        } else {
            // `fs::copy` carries the permissions along.
            fs::copy(&src, &dst)?;
        }
    }
    Ok(())
}

/// Copy the page data `from` left at `home` to `to`'s place, once. Nothing here
/// may stop the app: the caller only logs a failure.
///
/// - Done before (the mark is in `crew_home`): nothing.
/// - No folder from `from`: nothing to carry.
/// - `to` already holds something: it is the newer, and is left alone.
/// - Otherwise the folder is copied beside `to` and renamed into place, so a
///   copy that fails halfway leaves no `to` for WebKit to find half-filled, and
///   the next start tries again.
pub fn carry_over(home: &Path, crew_home: &Path, from: &str, to: &str) -> io::Result<Carried> {
    let mark = marker(crew_home, from);
    if mark.exists() {
        return Ok(Carried::Skipped("done before"));
    }
    let done = |why: &'static str| -> io::Result<Carried> {
        fs::create_dir_all(crew_home)?;
        fs::write(&mark, format!("{from} -> {to}\n"))?;
        Ok(Carried::Skipped(why))
    };
    let (old, new) = (data_dir(home, from), data_dir(home, to));
    if !old.is_dir() {
        return done("the old identifier left nothing");
    }
    if new.is_dir() && !is_empty_dir(&new)? {
        return done("the new identifier has data already");
    }
    let staging = new.with_extension("copying");
    let _ = fs::remove_dir_all(&staging);
    let copied = copy_tree(&old, &staging).and_then(|_| {
        if let Some(parent) = new.parent() {
            fs::create_dir_all(parent)?;
        }
        // An empty folder in the way is replaced; `rename` allows that.
        fs::rename(&staging, &new)
    });
    if let Err(err) = copied {
        let _ = fs::remove_dir_all(&staging);
        return Err(err);
    }
    fs::create_dir_all(crew_home)?;
    fs::write(&mark, format!("{from} -> {to}\n"))?;
    Ok(Carried::Copied)
}

/// At the start of the app, before its window: carry the old identifier's page
/// data over to this one's.
pub fn carry_over_at_start() {
    let Ok(home) = std::env::var("HOME") else {
        return;
    };
    let crew_home = crate::paths::home_dir();
    match carry_over(Path::new(&home), &crew_home, OLD_ID, NEW_ID) {
        Ok(Carried::Copied) => {
            eprintln!("crew: copied the window's page data from {OLD_ID} to {NEW_ID}")
        }
        Ok(Carried::Skipped(_)) => {}
        Err(err) => {
            eprintln!("crew: could not copy the window's page data from {OLD_ID}: {err}")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// A fresh `HOME` and Crew home under the temp folder.
    struct Dirs {
        root: PathBuf,
        home: PathBuf,
        crew: PathBuf,
    }

    impl Dirs {
        fn new(tag: &str) -> Self {
            let root = std::env::temp_dir().join(format!("cw-wv-{tag}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&root);
            let (home, crew) = (root.join("home"), root.join("crew"));
            fs::create_dir_all(&home).unwrap();
            Dirs { root, home, crew }
        }

        /// What WebKit left for `id` on a recent macOS: page data in
        /// `WebsiteData/Default/<hash>/<hash>/LocalStorage` (with its journal
        /// files), IndexedDB, and a salt that names those folders.
        fn leave(&self, id: &str) {
            let site = data_dir(&self.home, id).join("WebsiteData/Default/kJ_hash/kJ_hash");
            fs::create_dir_all(site.join("LocalStorage")).unwrap();
            fs::write(site.join("LocalStorage/localstorage.sqlite3"), b"theme=light").unwrap();
            fs::write(site.join("LocalStorage/localstorage.sqlite3-wal"), b"wal bytes").unwrap();
            fs::write(site.join("LocalStorage/localstorage.sqlite3-shm"), b"shm").unwrap();
            fs::write(site.join("origin"), b"tauri://localhost").unwrap();
            fs::write(data_dir(&self.home, id).join("WebsiteData/Default/salt"), b"salt").unwrap();
            fs::create_dir_all(data_dir(&self.home, id).join("WebsiteData/IndexedDB")).unwrap();
            fs::write(data_dir(&self.home, id).join("WebsiteData/IndexedDB/db"), b"idb").unwrap();
            std::os::unix::fs::symlink("salt", data_dir(&self.home, id).join("WebsiteData/Default/salt-link"))
                .unwrap();
        }

        fn read(&self, id: &str, rel: &str) -> Option<Vec<u8>> {
            fs::read(data_dir(&self.home, id).join(rel)).ok()
        }

        fn carry(&self) -> io::Result<Carried> {
            carry_over(&self.home, &self.crew, OLD_ID, NEW_ID)
        }
    }

    impl Drop for Dirs {
        fn drop(&mut self) {
            // A test may leave a folder it made unreadable.
            if let Ok(entries) = fs::read_dir(&self.root) {
                drop(entries);
            }
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    const STORAGE: &str = "WebsiteData/Default/kJ_hash/kJ_hash/LocalStorage/localstorage.sqlite3";

    #[test]
    fn the_identifiers_are_the_ones_the_app_and_the_installer_use() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"], NEW_ID);
        let script = include_str!("../../../scripts/install-macos.sh");
        assert!(script.contains(&format!("expected_bundle_id=\"{NEW_ID}\"")));
        assert!(script.contains(&format!("legacy_bundle_id=\"{OLD_ID}\"")));
    }

    #[test]
    fn the_old_identifiers_page_data_is_copied_whole_and_left_where_it_was() {
        let d = Dirs::new("copy");
        d.leave(OLD_ID);
        assert_eq!(d.carry().unwrap(), Carried::Copied);
        // The settings, with the journal files a running WebKit keeps beside them.
        for rel in [STORAGE, &format!("{STORAGE}-wal"), &format!("{STORAGE}-shm")] {
            assert_eq!(d.read(NEW_ID, rel), d.read(OLD_ID, rel), "{rel}");
            assert!(d.read(NEW_ID, rel).is_some(), "{rel}");
        }
        assert_eq!(d.read(NEW_ID, "WebsiteData/IndexedDB/db").unwrap(), b"idb");
        // The salt that names the folders is the same, so the names still match.
        assert_eq!(d.read(NEW_ID, "WebsiteData/Default/salt").unwrap(), b"salt");
        assert_eq!(
            fs::read_link(data_dir(&d.home, NEW_ID).join("WebsiteData/Default/salt-link")).unwrap(),
            Path::new("salt")
        );
        // Copied, not moved.
        assert_eq!(d.read(OLD_ID, STORAGE).unwrap(), b"theme=light");
        assert!(!data_dir(&d.home, NEW_ID).with_extension("copying").exists());
        assert!(marker(&d.crew, OLD_ID).exists());
    }

    #[test]
    fn it_happens_once() {
        let d = Dirs::new("once");
        d.leave(OLD_ID);
        assert_eq!(d.carry().unwrap(), Carried::Copied);
        // The user clears the new folder; the old one is still there.
        fs::remove_dir_all(data_dir(&d.home, NEW_ID)).unwrap();
        assert_eq!(d.carry().unwrap(), Carried::Skipped("done before"));
        assert!(!data_dir(&d.home, NEW_ID).exists());
    }

    #[test]
    fn data_the_new_identifier_has_is_not_written_over() {
        let d = Dirs::new("newer");
        d.leave(OLD_ID);
        let newer = data_dir(&d.home, NEW_ID).join("WebsiteData");
        fs::create_dir_all(&newer).unwrap();
        fs::write(newer.join("kept"), b"newer").unwrap();
        assert_eq!(d.carry().unwrap(), Carried::Skipped("the new identifier has data already"));
        assert_eq!(d.read(NEW_ID, "WebsiteData/kept").unwrap(), b"newer");
        assert!(d.read(NEW_ID, STORAGE).is_none(), "nothing of the old was mixed in");
        assert!(marker(&d.crew, OLD_ID).exists(), "and it is not looked at again");
    }

    #[test]
    fn an_empty_folder_in_the_way_is_filled() {
        let d = Dirs::new("empty");
        d.leave(OLD_ID);
        fs::create_dir_all(data_dir(&d.home, NEW_ID)).unwrap();
        assert_eq!(d.carry().unwrap(), Carried::Copied);
        assert_eq!(d.read(NEW_ID, STORAGE).unwrap(), b"theme=light");
    }

    #[test]
    fn a_first_install_has_nothing_to_carry() {
        let d = Dirs::new("fresh");
        assert_eq!(d.carry().unwrap(), Carried::Skipped("the old identifier left nothing"));
        assert!(!data_dir(&d.home, NEW_ID).exists(), "no folder is made for WebKit to trip on");
    }

    /// Every file under `dir` as (path relative to it, size or link target).
    fn listing(dir: &Path) -> Vec<(String, String)> {
        fn walk(base: &Path, dir: &Path, out: &mut Vec<(String, String)>) {
            let mut entries: Vec<_> = fs::read_dir(dir).unwrap().flatten().collect();
            entries.sort_by_key(|e| e.file_name());
            for e in entries {
                let path = e.path();
                let rel = path.strip_prefix(base).unwrap().display().to_string();
                let meta = fs::symlink_metadata(&path).unwrap();
                if meta.is_dir() {
                    out.push((rel, "dir".into()));
                    walk(base, &path, out);
                } else if meta.file_type().is_symlink() {
                    out.push((rel, format!("-> {}", fs::read_link(&path).unwrap().display())));
                } else {
                    out.push((rel, format!("{} bytes", meta.len())));
                }
            }
        }
        let mut out = Vec::new();
        walk(dir, dir, &mut out);
        out
    }

    /// A rehearsal on what this Mac's WebKit really left for the old
    /// identifier, copied into a temporary home first: run it by hand with
    /// `cargo test rehearse_on_this_macs_real_folder -- --ignored`. The real
    /// folder is only read.
    #[test]
    #[ignore = "reads the real ~/Library/WebKit/dev.jthefloor.crew"]
    fn rehearse_on_this_macs_real_folder() {
        let real = data_dir(Path::new(&std::env::var("HOME").unwrap()), OLD_ID);
        if !real.is_dir() {
            eprintln!("no {} here", real.display());
            return;
        }
        let d = Dirs::new("real");
        copy_tree(&real, &data_dir(&d.home, OLD_ID)).unwrap();
        let before = listing(&data_dir(&d.home, OLD_ID));
        assert_eq!(d.carry().unwrap(), Carried::Copied);
        assert_eq!(listing(&data_dir(&d.home, NEW_ID)), before);
        assert_eq!(listing(&data_dir(&d.home, OLD_ID)), before, "the old one is as it was");
        let storage = before.iter().filter(|(p, _)| p.ends_with("localstorage.sqlite3")).count();
        eprintln!("{} entries copied, {storage} localstorage database(s)", before.len());
    }

    #[test]
    fn a_copy_that_fails_leaves_no_half_folder_and_is_tried_again() {
        let d = Dirs::new("fail");
        d.leave(OLD_ID);
        let locked = data_dir(&d.home, OLD_ID).join("WebsiteData/IndexedDB");
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
        let tried = d.carry();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
        // A user that can read anyway (root) cannot show the failure.
        if tried.is_ok() {
            return;
        }
        assert!(!data_dir(&d.home, NEW_ID).exists(), "nothing half-copied is where WebKit looks");
        assert!(!data_dir(&d.home, NEW_ID).with_extension("copying").exists());
        assert!(!marker(&d.crew, OLD_ID).exists(), "so the next start tries again");
        assert_eq!(d.carry().unwrap(), Carried::Copied);
        assert_eq!(d.read(NEW_ID, STORAGE).unwrap(), b"theme=light");
    }
}
