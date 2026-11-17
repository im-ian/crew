//! One line in `crew.log`, with a time, written in a single `write`.
//!
//! The daemon's stdout and stderr are the log file, and the window appends
//! to that same file. Two processes writing a line in pieces interleave.
//! `install` sends this process's stdout and stderr through a pipe so each
//! line is stamped and written whole. `append` is the same write for a
//! process that does not own the pipe.

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::io::FromRawFd;
use std::sync::Mutex;
use std::thread;

use crate::paths;

const MAX_LOG: u64 = 1024 * 1024;

static INSTALL: Mutex<bool> = Mutex::new(false);

/// Send stdout and stderr through the stamper. Later calls do nothing.
pub fn install() {
    let mut installed = INSTALL.lock().unwrap_or_else(|err| err.into_inner());
    if *installed {
        return;
    }
    let mut pipe = [0; 2];
    if unsafe { libc::pipe(pipe.as_mut_ptr()) } != 0 {
        return;
    }
    let read_fd = pipe[0];
    let write_fd = pipe[1];
    unsafe {
        let _ = libc::fcntl(read_fd, libc::F_SETFD, libc::FD_CLOEXEC);
        if libc::dup2(write_fd, libc::STDOUT_FILENO) < 0
            || libc::dup2(write_fd, libc::STDERR_FILENO) < 0
        {
            libc::close(read_fd);
            libc::close(write_fd);
            return;
        }
        libc::close(write_fd);
    }
    thread::Builder::new()
        .name("crew-log".into())
        .spawn(move || stamp_loop(read_fd))
        .ok();
    *installed = true;
}

/// One stamped line, for a process that is not the daemon.
pub fn append(line: &str) {
    let mut file = open_log();
    emit(&mut file, line, MAX_LOG);
}

fn stamp_loop(fd: libc::c_int) {
    let file = unsafe { File::from_raw_fd(fd) };
    let mut reader = BufReader::new(file);
    let mut buf = String::new();
    let mut out = open_log();
    loop {
        buf.clear();
        match reader.read_line(&mut buf) {
            Ok(0) => break,
            Ok(_) => {
                if buf.ends_with('\n') {
                    buf.pop();
                    if buf.ends_with('\r') {
                        buf.pop();
                    }
                }
                emit(&mut out, &buf, MAX_LOG);
            }
            Err(_) => break,
        }
    }
}

fn open_log() -> Option<File> {
    let _ = paths::ensure_home();
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(paths::log_path())
        .ok()
}

fn emit(file: &mut Option<File>, line: &str, limit: u64) {
    let Some(out) = file.as_mut() else {
        return;
    };
    if line.is_empty() {
        return;
    }
    let text = format!("{} {line}\n", stamp());
    let _ = out.write_all(text.as_bytes());
    let big = out.metadata().map(|meta| meta.len() >= limit).unwrap_or(false);
    if !big {
        return;
    }
    *file = None;
    rotate();
    *file = open_log();
}

fn rotate() {
    let path = paths::log_path();
    let old = path.with_extension("log.1");
    let _ = fs::remove_file(&old);
    let _ = fs::rename(&path, &old);
}

fn stamp() -> String {
    let now = unsafe { libc::time(std::ptr::null_mut()) };
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe {
        libc::localtime_r(&now, &mut tm);
    }
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        tm.tm_year + 1900,
        tm.tm_mon + 1,
        tm.tm_mday,
        tm.tm_hour,
        tm.tm_min,
        tm.tm_sec
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_log_line_carries_the_time_and_rotates() {
        paths::testing::with_home("log-line", || {
            append("daemon did not start");
            let text = fs::read_to_string(paths::log_path()).unwrap();
            let line = text.lines().next().expect("line");
            assert!(line.contains("daemon did not start"), "{line}");
            assert!(
                line.as_bytes().get(4) == Some(&b'-') && line.as_bytes().get(7) == Some(&b'-'),
                "{line}"
            );
            assert!(!text.contains('\n') || text.lines().count() == 1, "{text}");

            let mut file = open_log();
            emit(&mut file, &"x".repeat(40), 80);
            emit(&mut file, "after", 80);
            assert!(
                paths::log_path().with_extension("log.1").exists(),
                "a full log is kept once"
            );
            let now = fs::read_to_string(paths::log_path()).unwrap();
            assert!(now.contains("after"), "{now}");
            assert!(!now.contains(&"x".repeat(40)), "{now}");
        });
    }
}
