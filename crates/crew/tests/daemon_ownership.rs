//! The single-daemon guarantee, tested the only way it can be: across
//! processes. The lock is a POSIX record lock, and a second lock inside the
//! owning process is allowed to take it, so an in-process test would pass
//! while the real invariant was broken.

use std::io::Write;
use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const CREW: &str = env!("CARGO_BIN_EXE_crew");

/// Stops whatever runs in the home and removes it even if an assertion
/// panicked first. A leaked daemon holds its lock for the rest of the job and
/// makes the next run of the same test fail for the wrong reason.
struct Home(PathBuf);

impl Deref for Home {
    type Target = Path;
    fn deref(&self) -> &Path {
        &self.0
    }
}

impl Drop for Home {
    fn drop(&mut self) {
        let _ = Command::new(CREW)
            .arg("stop")
            .env("CREW_HOME", &self.0)
            .output();
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Tag plus pid is unique enough across a run, and nothing time-based: the
/// socket bound in here has to fit a 104-byte path with the temp dir in front.
fn home(tag: &str) -> Home {
    let dir = std::env::temp_dir().join(format!("cw-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp home");
    let mut cfg = std::fs::File::create(dir.join("agents.json")).expect("config");
    cfg.write_all(br#"{"agents":[],"channels":[]}"#)
        .expect("config");
    Home(dir)
}

fn crew(home: &Path, args: &[&str]) -> String {
    let out = Command::new(CREW)
        .args(args)
        .env("CREW_HOME", home)
        // These homes hold no bots, so nothing here needs the default
        // roster-open budget — and the override is worth exercising.
        .env("CREW_READY_TIMEOUT", "3")
        .output()
        .expect("run crew");
    String::from_utf8_lossy(&out.stderr).to_string()
}

fn spawn_daemon(home: &Path) -> std::process::Child {
    Command::new(CREW)
        .arg("daemon")
        .env("CREW_HOME", home)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn daemon")
}

fn answering(home: &Path) -> bool {
    std::os::unix::net::UnixStream::connect(home.join("crew.sock")).is_ok()
}

fn wait_answering(home: &Path) -> bool {
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if answering(home) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

/// Starting one has to leave one running. The spawn side reaps its child so a
/// long-lived desktop process does not collect zombies, and reaping by killing
/// would take down the daemon the call had just started — which surfaces as a
/// connection error several calls away from the cause.
#[test]
fn starting_a_daemon_leaves_one_answering() {
    let home = home("start");
    let said = crew(&home, &["send", "nobody", "hi"]);
    assert!(
        said.contains("unknown agent"),
        "the daemon should have answered, said: {said}"
    );
    assert!(
        answering(&home),
        "the daemon must still be listening after the call that started it"
    );
}

#[test]
fn a_second_daemon_is_refused_and_the_first_keeps_serving() {
    let home = home("own");
    let mut first = spawn_daemon(&home);
    assert!(
        wait_answering(&home),
        "the first daemon should be listening"
    );

    let said = crew(&home, &["daemon"]);
    assert!(
        said.contains("already running"),
        "the second daemon must be refused, said: {said}"
    );
    assert!(
        said.contains("pid"),
        "the refusal should name the holder, said: {said}"
    );
    assert!(answering(&home), "the first daemon must still be reachable");

    crew(&home, &["stop"]);
    let _ = first.wait();
    assert!(
        !home.join("crew.sock").exists() && !home.join("crew.pid").exists(),
        "a stopped daemon leaves nothing behind"
    );
}

/// A daemon that will not stop on its own still has to let go, or its lock
/// keeps every future daemon out of the home for good.
#[test]
fn a_wedged_daemon_is_taken_over() {
    let home = home("wedge");
    let mut stuck = spawn_daemon(&home);
    assert!(wait_answering(&home), "the daemon should be listening");

    // Owns the home, answers nothing.
    unsafe { libc::kill(stuck.id() as i32, libc::SIGSTOP) };
    let _ = std::fs::remove_file(home.join("crew.sock"));

    let said = crew(&home, &["send", "nobody", "hi"]);
    assert!(
        said.contains("unknown agent"),
        "a new daemon must take the home over and answer, said: {said}"
    );
    let _ = stuck.wait();
}
