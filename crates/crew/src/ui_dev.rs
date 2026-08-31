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
    if vite_up() {
        return Ok(());
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
        if vite_up() {
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

fn vite_up() -> bool {
    TcpStream::connect_timeout(&DEV_ADDR.parse().unwrap(), Duration::from_millis(200)).is_ok()
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
