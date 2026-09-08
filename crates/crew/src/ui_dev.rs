use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use tauri::Manager;

pub const DEV_URL: &str = "http://127.0.0.1:1420";
const DEV_ADDR: &str = "127.0.0.1:1420";

static VITE: OnceLock<Mutex<Child>> = OnceLock::new();

pub fn ensure_vite() -> anyhow::Result<()> {
    if vite_serving() {
        return Ok(());
    }
    if port_open() {
        anyhow::bail!(
            "{DEV_URL} is occupied but not serving the Crew UI. Stop the leftover Vite/Crew process (often from a deleted worktree) and try again."
        );
    }

    let ui = Path::new(env!("CARGO_MANIFEST_DIR")).join("ui");
    if !ui.join("package.json").exists() {
        anyhow::bail!("React UI missing at {}", ui.display());
    }

    let child = Command::new("npm")
        .args(["run", "dev"])
        .current_dir(&ui)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|err| anyhow::anyhow!("failed to start `npm run dev`: {err}"))?;
    let _ = VITE.set(Mutex::new(child));

    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(20) {
        if vite_serving() {
            return Ok(());
        }
        if vite_exited() {
            anyhow::bail!("Vite exited before binding {DEV_URL}");
        }
        thread::sleep(Duration::from_millis(100));
    }
    anyhow::bail!("Vite did not start on {DEV_URL}")
}

pub fn attach(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let window = app
        .get_webview_window("main")
        .ok_or("main window missing")?;
    window.navigate(DEV_URL.parse()?)?;
    Ok(())
}

fn port_open() -> bool {
    TcpStream::connect_timeout(&DEV_ADDR.parse().unwrap(), Duration::from_millis(200)).is_ok()
}

fn vite_serving() -> bool {
    let Ok(mut stream) =
        TcpStream::connect_timeout(&DEV_ADDR.parse().unwrap(), Duration::from_millis(200))
    else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(400)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(400)));
    if stream
        .write_all(b"GET / HTTP/1.1\r\nHost: 127.0.0.1:1420\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut buf = [0u8; 24];
    let Ok(n) = stream.read(&mut buf) else {
        return false;
    };
    http_ok(&buf[..n])
}

fn http_ok(head: &[u8]) -> bool {
    head.starts_with(b"HTTP/1.1 200") || head.starts_with(b"HTTP/1.0 200")
}

#[cfg(test)]
mod tests {
    use super::http_ok;

    #[test]
    fn accepts_http_200() {
        assert!(http_ok(b"HTTP/1.1 200 OK\r\n"));
        assert!(http_ok(b"HTTP/1.0 200 OK\r\n"));
        assert!(!http_ok(b"HTTP/1.1 404 Not Found\r\n"));
        assert!(!http_ok(b""));
    }
}

fn vite_exited() -> bool {
    let Some(child) = VITE.get() else {
        return false;
    };
    let Ok(mut child) = child.lock() else {
        return false;
    };
    matches!(child.try_wait(), Ok(Some(_)))
}
