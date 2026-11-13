//! A text or code file a bot shows the user: where `crew show` points, and
//! what the window reads to draw it beside the chat.

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// The most of a file the window reads. A longer one is cut at a line.
pub const MAX_READ: u64 = 1024 * 1024;

/// How much of the start a NUL byte is looked for in, to tell a binary file.
const SNIFF: usize = 8 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TextFile {
    /// Absolute, with `~` expanded.
    pub path: String,
    pub text: String,
    /// The whole file's size in bytes, not only what was read.
    pub size: u64,
    /// Only the first `MAX_READ` bytes are in `text`, up to the last full line.
    pub truncated: bool,
}

/// `path` as `crew show` takes it: `~` expanded and a relative path read from
/// `cwd`, canonicalized. A trailing `:<line>` (or `:<line>:<col>`) is the line
/// to open at, but only when the path without it is the file, so a name that
/// really ends in `:12` is still that file. The line is 1-based.
pub fn resolve_show(raw: &str, cwd: &Path) -> Result<(PathBuf, Option<u32>), String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("show needs a file path".into());
    }
    let whole = absolute(raw, cwd);
    if whole.exists() {
        return file_only(&whole).map(|p| (p, None));
    }
    if let Some((base, line)) = split_line(raw) {
        let path = absolute(base, cwd);
        if path.exists() {
            return file_only(&path).map(|p| (p, Some(line)));
        }
    }
    Err(format!("not found: {}", whole.display()))
}

/// What a file row says: the path, and `:<line>` when there is one.
pub fn row_text(path: &Path, line: Option<u32>) -> String {
    match line {
        Some(line) => format!("{}:{line}", path.display()),
        None => path.display().to_string(),
    }
}

fn absolute(raw: &str, cwd: &Path) -> PathBuf {
    let path = crate::paths::expand_tilde(raw);
    if path.is_absolute() {
        path
    } else {
        cwd.join(path)
    }
}

fn file_only(path: &Path) -> Result<PathBuf, String> {
    if path.is_dir() {
        return Err(format!("folder: {}", path.display()));
    }
    path.canonicalize()
        .map_err(|err| format!("not found: {}: {err}", path.display()))
}

/// `base:12` or `base:12:4` as the base and line 12. Line 0 is no line.
fn split_line(raw: &str) -> Option<(&str, u32)> {
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let (head, last) = raw.rsplit_once(':')?;
    if !digits(last) {
        return None;
    }
    let (base, line) = match head.rsplit_once(':') {
        Some((base, line)) if digits(line) => (base, line),
        _ => (head, last),
    };
    let line: u32 = line.parse().ok().filter(|n| *n > 0)?;
    (!base.is_empty()).then_some((base, line))
}

/// Up to `MAX_READ` bytes of a text file. Errors start with `not found: `,
/// `folder: `, or `binary: `, so the window can say which.
pub fn read_text(raw: &str) -> Result<TextFile, String> {
    read_text_capped(raw, MAX_READ)
}

/// `read_text`, and when the file is not at `path`, the first file under
/// `base` whose path ends in `rel`. A bot writes a path from the folder its
/// shell is in, which can be below the one Crew knows: `watch-preview.html`
/// made in `crates/crew/ui` is found from the worktree's root.
pub fn read_text_near(path: &str, base: Option<&str>, rel: Option<&str>) -> Result<TextFile, String> {
    let first = read_text(path);
    let (Err(err), Some(base), Some(rel)) = (&first, base, rel) else {
        return first;
    };
    if !err.starts_with("not found") {
        return first;
    }
    match find_under(&crate::paths::expand_tilde(base), Path::new(rel)) {
        Some(found) => read_text(&found.display().to_string()),
        None => first,
    }
}

/// Folders a search for a bot's file does not go into: build output,
/// dependencies, and anything hidden.
const SKIP_DIRS: &[&str] = &["node_modules", "target", "dist", "build"];
/// How deep, and how many entries, a search looks at before it gives up.
const FIND_DEPTH: usize = 6;
const FIND_ENTRIES: usize = 20_000;

/// The shallowest file under `base` whose path ends in `rel`, by whole parts.
fn find_under(base: &Path, rel: &Path) -> Option<PathBuf> {
    if rel.is_absolute() || rel.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return None;
    }
    let rel: PathBuf = rel.components().filter(|c| !matches!(c, std::path::Component::CurDir)).collect();
    if rel.as_os_str().is_empty() {
        return None;
    }
    let mut level = vec![base.to_path_buf()];
    let mut seen = 0usize;
    for _ in 0..=FIND_DEPTH {
        let mut next = Vec::new();
        for dir in level {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                seen += 1;
                if seen > FIND_ENTRIES {
                    return None;
                }
                let path = entry.path();
                let Ok(kind) = entry.file_type() else {
                    continue;
                };
                if kind.is_dir() {
                    let name = entry.file_name();
                    let name = name.to_string_lossy();
                    if !name.starts_with('.') && !SKIP_DIRS.contains(&name.as_ref()) {
                        next.push(path);
                    }
                } else if path.ends_with(&rel) {
                    return Some(path);
                }
            }
        }
        if next.is_empty() {
            break;
        }
        level = next;
    }
    None
}

fn read_text_capped(raw: &str, cap: u64) -> Result<TextFile, String> {
    let path = crate::paths::expand_tilde(raw.trim());
    let shown = path.display().to_string();
    let meta = std::fs::metadata(&path).map_err(|err| format!("not found: {shown}: {err}"))?;
    if meta.is_dir() {
        return Err(format!("folder: {shown}"));
    }
    let size = meta.len();
    let mut bytes = Vec::with_capacity(size.min(cap) as usize);
    File::open(&path)
        .and_then(|f| f.take(cap).read_to_end(&mut bytes))
        .map_err(|err| format!("not found: {shown}: {err}"))?;
    if bytes[..bytes.len().min(SNIFF)].contains(&0) {
        return Err(format!("binary: {shown}"));
    }
    let truncated = size > bytes.len() as u64;
    if truncated {
        // Cut back to the last full line, which also drops a character the
        // cap split in two.
        match bytes.iter().rposition(|b| *b == b'\n') {
            Some(nl) => bytes.truncate(nl + 1),
            None => {
                let ok = match std::str::from_utf8(&bytes) {
                    Ok(_) => bytes.len(),
                    Err(err) => err.valid_up_to(),
                };
                bytes.truncate(ok);
            }
        }
    }
    let text = String::from_utf8(bytes).map_err(|_| format!("binary: {shown}"))?;
    Ok(TextFile {
        path: shown,
        text,
        size,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "crew-files-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&d).unwrap();
        d.canonicalize().unwrap()
    }

    #[test]
    fn a_trailing_line_is_read_only_when_the_rest_is_the_file() {
        let d = dir();
        std::fs::create_dir_all(d.join("src")).unwrap();
        std::fs::write(d.join("src/main.rs"), "fn main() {}\n").unwrap();
        std::fs::write(d.join("odd:12"), "x").unwrap();
        let main = d.join("src/main.rs");

        assert_eq!(resolve_show("src/main.rs", &d), Ok((main.clone(), None)));
        assert_eq!(resolve_show("src/main.rs:53", &d), Ok((main.clone(), Some(53))));
        assert_eq!(resolve_show("./src/main.rs:53:7", &d), Ok((main.clone(), Some(53))));
        assert_eq!(
            resolve_show(main.to_str().unwrap(), Path::new("/")),
            Ok((main.clone(), None))
        );
        // The file's own name ends in `:12`.
        assert_eq!(resolve_show("odd:12", &d), Ok((d.join("odd:12"), None)));
        assert_eq!(resolve_show("src/main.rs:0", &d).unwrap_err().split(':').next(), Some("not found"));
        assert!(resolve_show("src/nope.rs:3", &d).unwrap_err().starts_with("not found: "));
        assert!(resolve_show("src", &d).unwrap_err().starts_with("folder: "));
        assert!(resolve_show("  ", &d).is_err());
        assert_eq!(row_text(&main, Some(53)), format!("{}:53", main.display()));
        assert_eq!(row_text(&main, None), main.display().to_string());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn reads_text_and_turns_away_a_folder_or_binary() {
        let d = dir();
        let text = d.join("a.txt");
        std::fs::write(&text, "하나\n둘\n").unwrap();
        let read = read_text(text.to_str().unwrap()).unwrap();
        assert_eq!(read.text, "하나\n둘\n");
        assert_eq!(read.size, "하나\n둘\n".len() as u64);
        assert!(!read.truncated);

        let bin = d.join("a.bin");
        std::fs::write(&bin, [b'a', 0, b'b']).unwrap();
        assert!(read_text(bin.to_str().unwrap()).unwrap_err().starts_with("binary: "));
        let latin = d.join("latin.txt");
        std::fs::write(&latin, [b'c', 0xe9, b'\n']).unwrap();
        assert!(read_text(latin.to_str().unwrap()).unwrap_err().starts_with("binary: "));
        assert!(read_text(d.to_str().unwrap()).unwrap_err().starts_with("folder: "));
        assert!(read_text(d.join("gone").to_str().unwrap())
            .unwrap_err()
            .starts_with("not found: "));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_long_file_is_cut_at_a_full_line() {
        let d = dir();
        let long = d.join("long.txt");
        std::fs::write(&long, "abc\ndef\nghi\n").unwrap();
        let read = read_text_capped(long.to_str().unwrap(), 6).unwrap();
        assert_eq!(read.text, "abc\n");
        assert_eq!(read.size, 12);
        assert!(read.truncated);

        // One long line: the cut lands inside `한` and backs off to `ab`.
        let one = d.join("one.txt");
        std::fs::write(&one, "ab한글").unwrap();
        let read = read_text_capped(one.to_str().unwrap(), 4).unwrap();
        assert_eq!(read.text, "ab");
        assert!(read.truncated);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// A path a bot wrote from a folder below its worktree's root is found
    /// from the root; one that is nowhere stays not found.
    #[test]
    fn a_relative_path_is_looked_for_under_the_work_dir() {
        let root = dir();
        std::fs::create_dir_all(root.join("crates/crew/ui")).unwrap();
        std::fs::create_dir_all(root.join("node_modules/x")).unwrap();
        std::fs::write(root.join("node_modules/x/watch-preview.html"), "dep").unwrap();
        std::fs::write(root.join("crates/crew/ui/watch-preview.html"), "<html>").unwrap();
        let base = root.display().to_string();
        let guessed = root.join("watch-preview.html").display().to_string();
        let file = read_text_near(&guessed, Some(&base), Some("watch-preview.html")).unwrap();
        assert!(file.path.ends_with("crates/crew/ui/watch-preview.html"), "{}", file.path);
        assert_eq!(file.text, "<html>");
        let file = read_text_near(&guessed, Some(&base), Some("ui/watch-preview.html")).unwrap();
        assert_eq!(file.text, "<html>");
        let none = read_text_near(&root.join("gone.rs").display().to_string(), Some(&base), Some("gone.rs"));
        assert!(none.unwrap_err().starts_with("not found"));
        assert!(read_text_near(&guessed, Some(&base), Some("../watch-preview.html")).is_err());
    }
}
