//! Crew on the phone. The daemon serves the window's own UI and answers its
//! commands over HTTP, so a phone browser runs the same screens. It is off
//! until the user turns it on in Settings, and then it listens on this Mac's
//! loopback and Tailscale addresses only, never on every interface.
//!
//! A phone pairs once with a short-lived code from Settings and keeps a
//! device token in a cookie. Only the token's hash is kept here. Over
//! Tailscale a request must also come from the same Tailscale user as this
//! Mac: the tailnet may hold other people's machines.
//!
//! HTTP contract (the web layer in the UI is written against it):
//! - `GET /…` the built UI; unknown paths fall back to `index.html`, which
//!   loads `/crew-web.js` first (`window.__CREW_WEB__ = true`).
//! - `GET /api/session` 200 `{ device }` when paired, else 401.
//! - `POST /api/pair { code, name? }` sets the device cookie.
//! - `POST /api/invoke/<command>` the `invoke` args object as JSON; 200 with
//!   the return value as JSON, or 4xx/5xx `{ error }`. 401 without a device.
//! - `GET /api/file?path=<absolute>` a file to show (Range works), from the
//!   allowed places only.
//! - `POST /api/upload?name=<file name>` the raw bytes as the body; 200
//!   `{ path }`, the path a desktop attachment would have.

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

/// The port Crew listens on unless the settings name another.
pub const DEFAULT_PORT: u16 = 47823;
/// A pairing code is good this long.
const PAIR_TTL: Duration = Duration::from_secs(5 * 60);
/// Wrong codes before a code is thrown away.
const PAIR_TRIES: u32 = 5;
/// Wrong codes from everywhere, in `FAIL_WINDOW`, before pairing stops until
/// a new code is made.
const FAIL_LIMIT: u32 = 20;
const FAIL_WINDOW: Duration = Duration::from_secs(10 * 60);
/// The largest upload. The window sends attachments of any size; a phone's
/// videos stay well under this.
pub const UPLOAD_LIMIT: u64 = 100 * 1024 * 1024;
const COOKIE: &str = "crew_device";
const WORKERS: usize = 4;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub enabled: bool,
    pub port: Option<u16>,
    /// Listen on 127.0.0.1 alone, never on the Tailscale address: the phone
    /// E2E's throwaway daemon, which no other device should reach.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub loopback: bool,
}

impl Settings {
    fn port(&self) -> u16 {
        self.port.unwrap_or(DEFAULT_PORT)
    }
}

/// A phone that paired. `hash` is the SHA-256 of its token.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub hash: String,
    pub created: u64,
    #[serde(default)]
    pub last_seen: u64,
}

fn settings_path() -> PathBuf {
    crate::paths::home_dir().join("mobile.json")
}

fn devices_path() -> PathBuf {
    crate::paths::home_dir().join("mobile-devices.json")
}

pub fn load_settings() -> Settings {
    fs::read(settings_path())
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn save_settings(s: &Settings) -> anyhow::Result<()> {
    crate::paths::ensure_home()?;
    crate::paths::write_atomic(&settings_path(), &serde_json::to_vec_pretty(s)?)?;
    Ok(())
}

/// The paired devices as a file holds them: none yet, a list, or a file that
/// cannot be read or parsed (which is not the same as an empty list).
enum Stored {
    Missing,
    List(Vec<Device>),
    Broken,
}

fn read_devices_file(path: &Path) -> Stored {
    match fs::read(path) {
        Ok(bytes) => match serde_json::from_slice::<Vec<Device>>(&bytes) {
            Ok(list) => Stored::List(list),
            Err(_) => Stored::Broken,
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Stored::Missing,
        Err(_) => Stored::Broken,
    }
}

/// The copy kept of the last list written, for when the file cannot be read.
fn devices_backup_path() -> PathBuf {
    crate::paths::home_dir().join("mobile-devices.json.bak")
}

/// The paired devices. A file that cannot be read once is read again, then the
/// copy of the last good list stands in: a phone must not be turned away as
/// unknown because the list could not be read this time.
fn load_devices() -> Vec<Device> {
    for attempt in 0..3 {
        match read_devices_file(&devices_path()) {
            Stored::List(list) => return list,
            Stored::Missing => return Vec::new(),
            Stored::Broken if attempt < 2 => std::thread::sleep(Duration::from_millis(30)),
            Stored::Broken => {}
        }
    }
    match read_devices_file(&devices_backup_path()) {
        Stored::List(list) => list,
        _ => Vec::new(),
    }
}

/// The list to change and write back, or None when neither it nor its copy can
/// be read: writing then would drop every paired device but the one added.
fn devices_to_change() -> Option<Vec<Device>> {
    match read_devices_file(&devices_path()) {
        Stored::List(list) => Some(list),
        Stored::Missing => Some(Vec::new()),
        Stored::Broken => match read_devices_file(&devices_backup_path()) {
            Stored::List(list) => Some(list),
            _ => None,
        },
    }
}

fn save_devices(list: &[Device]) -> anyhow::Result<()> {
    crate::paths::ensure_home()?;
    let bytes = serde_json::to_vec_pretty(list)?;
    crate::paths::write_atomic(&devices_path(), &bytes)?;
    // The copy follows each write, so it is the latest good list.
    let _ = crate::paths::write_atomic(&devices_backup_path(), &bytes);
    Ok(())
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn random_bytes(n: usize) -> Vec<u8> {
    let mut buf = vec![0u8; n];
    if let Ok(mut f) = fs::File::open("/dev/urandom") {
        if f.read_exact(&mut buf).is_ok() {
            return buf;
        }
    }
    // Not reached on macOS. Still not a constant.
    let seed = format!("{:?}{}", Instant::now(), std::process::id());
    Sha256::digest(seed.as_bytes())
        .iter()
        .cycle()
        .take(n)
        .copied()
        .collect()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn hash_token(token: &str) -> String {
    hex(&Sha256::digest(token.as_bytes()))
}

struct PairCode {
    code: String,
    expires: Instant,
    tries: u32,
}

/// A server listening on one address, and the flag that sends its workers
/// home. The last of them to let go closes the port.
struct Listener {
    server: Arc<Server>,
    stop: Arc<std::sync::atomic::AtomicBool>,
}

#[derive(Default)]
struct State {
    servers: Vec<Listener>,
    bound: Vec<SocketAddr>,
    code: Option<PairCode>,
    fails: Vec<Instant>,
    whois: HashMap<IpAddr, (bool, Instant)>,
    tailnet: Option<(Tailnet, Instant)>,
    /// Tailscale did not answer at this time: not asked again at once.
    tailnet_missed: Option<Instant>,
    /// What was last known of this Mac on its tailnet (`mobile-net.json`).
    kept: Option<Option<KeptNet>>,
    /// When a rejected phone was last written to the log, by who and why.
    unauthorized: HashMap<String, Instant>,
    error: Option<String>,
}

fn state() -> &'static Mutex<State> {
    static STATE: OnceLock<Mutex<State>> = OnceLock::new();
    STATE.get_or_init(Default::default)
}

// ---------------------------------------------------------------- Tailscale

/// This Mac on its tailnet.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tailnet {
    pub ips: Vec<IpAddr>,
    /// The MagicDNS name, without the trailing dot.
    pub dns: Option<String>,
    /// The Tailscale login that owns this Mac.
    pub owner: Option<String>,
}

fn tailscale_cli() -> Option<PathBuf> {
    let found = crate::paths::resolve_program("tailscale");
    if found.is_file() {
        return Some(found);
    }
    [
        "/usr/local/bin/tailscale",
        "/opt/homebrew/bin/tailscale",
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    ]
    .into_iter()
    .map(PathBuf::from)
    .find(|p| p.is_file())
}

fn tailscale_json(args: &[&str]) -> Option<Value> {
    let cli = tailscale_cli()?;
    let out = std::process::Command::new(cli)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    serde_json::from_slice(&out.stdout).ok()
}

fn parse_status(v: &Value) -> Tailnet {
    let me = &v["Self"];
    let ips = me["TailscaleIPs"]
        .as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str()?.parse().ok()).collect())
        .unwrap_or_default();
    let dns = me["DNSName"]
        .as_str()
        .map(|s| s.trim_end_matches('.').to_string())
        .filter(|s| !s.is_empty());
    let owner = me["UserID"]
        .as_u64()
        .map(|id| id.to_string())
        .and_then(|id| v["User"][&id]["LoginName"].as_str().map(str::to_string));
    Tailnet { ips, dns, owner }
}

/// What was last seen of this Mac on its tailnet. Tailscale can be slow to
/// answer for a while after an update restarts Crew, and the address the phone
/// was paired on (and the Tailscale user that owns this Mac) must not change
/// with it: a browser keeps its device cookie per host name, so a pairing link
/// that says `100.x.y.z` one time and the MagicDNS name the next is two
/// sites, and the phone is asked to connect again.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
struct KeptNet {
    #[serde(default)]
    dns: Option<String>,
    #[serde(default)]
    owner: Option<String>,
    #[serde(default)]
    ips: Vec<IpAddr>,
}

fn kept_path() -> PathBuf {
    crate::paths::home_dir().join("mobile-net.json")
}

fn kept_net() -> Option<KeptNet> {
    if let Ok(st) = state().lock() {
        if let Some(cached) = &st.kept {
            return cached.clone();
        }
    }
    let read = fs::read(kept_path())
        .ok()
        .and_then(|b| serde_json::from_slice::<KeptNet>(&b).ok());
    if let Ok(mut st) = state().lock() {
        st.kept = Some(read.clone());
    }
    read
}

/// Remember `t` when it says something different from what is kept. A part
/// Tailscale did not give this time keeps its earlier value.
fn keep_net(t: &Tailnet) {
    let old = kept_net().unwrap_or_default();
    let next = KeptNet {
        dns: t.dns.clone().or(old.dns.clone()),
        owner: t.owner.clone().or(old.owner.clone()),
        ips: if t.ips.is_empty() { old.ips.clone() } else { t.ips.clone() },
    };
    if next == old {
        return;
    }
    if let Ok(mut st) = state().lock() {
        st.kept = Some(Some(next.clone()));
    }
    if let (Ok(bytes), Ok(_)) = (serde_json::to_vec_pretty(&next), crate::paths::ensure_home()) {
        let _ = crate::paths::write_atomic(&kept_path(), &bytes);
    }
}

/// This Mac's tailnet as Tailscale says now: read at most every half minute,
/// and not asked again for five seconds after it did not answer. None without
/// Tailscale, or while it is not connected.
fn tailnet() -> Option<Tailnet> {
    // Tests listen on loopback only, never on this Mac's tailnet.
    if cfg!(test) {
        return None;
    }
    if let Ok(st) = state().lock() {
        if let Some((t, at)) = &st.tailnet {
            if at.elapsed() < Duration::from_secs(30) {
                return Some(t.clone());
            }
        }
        if st.tailnet_missed.is_some_and(|at| at.elapsed() < Duration::from_secs(5)) {
            return None;
        }
    }
    let t = tailscale_json(&["status", "--json"])
        .map(|v| parse_status(&v))
        .filter(|t| !t.ips.is_empty());
    let Some(t) = t else {
        if let Ok(mut st) = state().lock() {
            st.tailnet_missed = Some(Instant::now());
        }
        return None;
    };
    keep_net(&t);
    if let Ok(mut st) = state().lock() {
        st.tailnet = Some((t.clone(), Instant::now()));
        st.tailnet_missed = None;
    }
    Some(t)
}

/// The tailnet as now, or as last seen when Tailscale does not answer.
fn known_tailnet() -> Option<Tailnet> {
    tailnet().or_else(|| {
        kept_net().map(|k| Tailnet {
            ips: k.ips,
            dns: k.dns,
            owner: k.owner,
        })
    })
}

fn is_tailnet_ip(ip: &IpAddr) -> bool {
    match ip {
        // 100.64.0.0/10
        IpAddr::V4(v4) => {
            let o = v4.octets();
            o[0] == 100 && (o[1] & 0xc0) == 64
        }
        // fd7a:115c:a1e0::/48
        IpAddr::V6(v6) => {
            let s = v6.segments();
            s[0] == 0xfd7a && s[1] == 0x115c && s[2] == 0xa1e0
        }
    }
}

/// Whether a peer is this Mac's own Tailscale user: yes, no, or not known
/// because Tailscale did not answer the question this time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PeerCheck {
    Yes,
    No,
    Unknown,
}

/// What `owner` (the Tailscale login of this Mac) and `login` (the peer's, as
/// `whois` says) come to. A login that cannot be read is no answer, not a
/// stranger.
fn owner_verdict(owner: Option<&str>, login: Option<&str>) -> PeerCheck {
    match (owner, login) {
        (Some(owner), Some(login)) if owner == login => PeerCheck::Yes,
        (Some(_), Some(_)) => PeerCheck::No,
        _ => PeerCheck::Unknown,
    }
}

/// Whether a request may be answered at all, given the peer check. A peer
/// known not to be this Mac's user gets nothing. One Tailscale could not
/// vouch for this time (it was slow after an update, say) gets the app's own
/// files and, with a paired device's cookie, the API; it never gets to pair.
/// The device token is what guards the API either way.
fn admitted(check: PeerCheck, is_api: bool, is_pair: bool, paired: bool) -> bool {
    match check {
        PeerCheck::Yes => true,
        PeerCheck::No => false,
        PeerCheck::Unknown => !is_pair && (!is_api || paired),
    }
}

/// A tailnet peer may come in when it is this Mac's own Tailscale user. With
/// no CLI to ask, the device token alone decides.
fn tailnet_peer_check(ip: IpAddr) -> PeerCheck {
    if let Ok(st) = state().lock() {
        if let Some((ok, at)) = st.whois.get(&ip) {
            if at.elapsed() < Duration::from_secs(5 * 60) {
                return if *ok { PeerCheck::Yes } else { PeerCheck::No };
            }
        }
    }
    let Some(owner) = known_tailnet().and_then(|t| t.owner) else {
        return if tailscale_cli().is_none() { PeerCheck::Yes } else { PeerCheck::Unknown };
    };
    let login = tailscale_json(&["whois", "--json", &ip.to_string()])
        .and_then(|v| v["UserProfile"]["LoginName"].as_str().map(str::to_string));
    let verdict = owner_verdict(Some(&owner), login.as_deref());
    // Only an answer is kept; a question that failed is asked again.
    if verdict != PeerCheck::Unknown {
        if let Ok(mut st) = state().lock() {
            st.whois.insert(ip, (verdict == PeerCheck::Yes, Instant::now()));
        }
    }
    verdict
}

// ------------------------------------------------------------ start and stop

/// At daemon start: listen when the user left it on.
pub fn start_if_enabled() {
    if load_settings().enabled {
        if let Err(err) = bind_all() {
            eprintln!("[crew] mobile: {err:#}");
        }
    }
    retry_binding();
}

/// Tailscale can connect after Crew starts, as it does after an update restarts
/// the app. The Tailscale address is listened on as soon as it is there,
/// without waiting for Settings to be opened on the Mac.
fn retry_binding() {
    static STARTED: OnceLock<()> = OnceLock::new();
    if STARTED.set(()).is_err() {
        return;
    }
    std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_secs(30));
        if load_settings().enabled {
            let _ = bind_all();
        }
    });
}

/// Turn mobile access on or off, and say where it stands.
pub fn set_enabled(on: bool) -> anyhow::Result<Value> {
    let mut s = load_settings();
    s.enabled = on;
    save_settings(&s)?;
    if on {
        bind_all()?;
    } else {
        stop_all();
    }
    Ok(status())
}

fn stop_all() {
    let servers = state()
        .lock()
        .map(|mut st| {
            st.bound.clear();
            st.code = None;
            std::mem::take(&mut st.servers)
        })
        .unwrap_or_default();
    for l in servers {
        l.stop.store(true, std::sync::atomic::Ordering::SeqCst);
        // `unblock` wakes one waiting worker at a time.
        for _ in 0..WORKERS {
            l.server.unblock();
        }
    }
}

/// The addresses to listen on: loopback, and this Mac's Tailscale IPv4
/// address. Its IPv6 one is left out: the phone reaches the Mac over IPv4
/// all the same, and a server there could not be shut down (it unblocks
/// itself by connecting to its own address, which macOS does not route).
fn wanted(s: &Settings) -> Vec<SocketAddr> {
    // A loopback-only daemon does not even ask Tailscale where it is.
    let tailnet_ips = if s.loopback {
        Vec::new()
    } else {
        known_tailnet().map(|t| t.ips).unwrap_or_default()
    };
    listen_addrs(s.port(), &tailnet_ips)
}

fn listen_addrs(port: u16, tailnet_ips: &[IpAddr]) -> Vec<SocketAddr> {
    let mut out = vec![SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port)];
    out.extend(
        tailnet_ips
            .iter()
            .filter(|ip| ip.is_ipv4())
            .map(|ip| SocketAddr::new(*ip, port)),
    );
    out
}

/// Listen on each wanted address not listened on yet. Tailscale may connect
/// after Crew starts; `status` calls this again.
fn bind_all() -> anyhow::Result<()> {
    let settings = load_settings();
    let mut failed = Vec::new();
    for addr in wanted(&settings) {
        let have = state()
            .lock()
            .map(|st| st.bound.contains(&addr))
            .unwrap_or(false);
        if have {
            continue;
        }
        match Server::http(addr) {
            Ok(server) => {
                let server = Arc::new(server);
                let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
                for _ in 0..WORKERS {
                    let (server, stop) = (server.clone(), stop.clone());
                    std::thread::spawn(move || serve(server, stop));
                }
                if let Ok(mut st) = state().lock() {
                    st.servers.push(Listener { server, stop });
                    st.bound.push(addr);
                }
                eprintln!("[crew] mobile: listening on http://{addr}");
            }
            Err(err) => failed.push(format!("{addr}: {err}")),
        }
    }
    let error = (!failed.is_empty()).then(|| failed.join("; "));
    let none = state().lock().map(|st| st.bound.is_empty()).unwrap_or(true);
    if let Ok(mut st) = state().lock() {
        st.error = error.clone();
    }
    if none {
        anyhow::bail!("could not listen: {}", error.unwrap_or_default());
    }
    Ok(())
}

fn serve(server: Arc<Server>, stop: Arc<std::sync::atomic::AtomicBool>) {
    loop {
        let next = server.recv();
        if stop.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        match next {
            // One bad request must not take a worker down.
            Ok(req) => {
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| handle(req)));
            }
            // A connection that failed; the server goes on.
            Err(_) => continue,
        }
    }
}

// ----------------------------------------------------- status and pairing

fn urls(port: u16) -> Vec<String> {
    let bound = state()
        .lock()
        .map(|st| st.bound.clone())
        .unwrap_or_default();
    let mut out = Vec::new();
    if let Some(dns) = known_tailnet().and_then(|t| t.dns) {
        if bound.iter().any(|a| is_tailnet_ip(&a.ip())) {
            out.push(format!("http://{dns}:{port}"));
        }
    }
    for a in &bound {
        match a.ip() {
            IpAddr::V6(v6) => out.push(format!("http://[{v6}]:{port}")),
            IpAddr::V4(v4) => out.push(format!("http://{v4}:{port}")),
        }
    }
    out
}

/// Where mobile access stands, for Settings.
pub fn status() -> Value {
    let s = load_settings();
    if s.enabled {
        let _ = bind_all();
    }
    let devices: Vec<Value> = load_devices()
        .into_iter()
        .map(|d| json!({ "id": d.id, "name": d.name, "created": d.created, "lastSeen": d.last_seen }))
        .collect();
    let error = state().lock().ok().and_then(|st| st.error.clone());
    json!({
        "enabled": s.enabled,
        "port": s.port(),
        "urls": if s.enabled { urls(s.port()) } else { Vec::new() },
        "tailnet": tailnet(),
        "tailscale": tailscale_cli().is_some(),
        "devices": devices,
        "error": error,
    })
}

/// A new pairing code, good for a few minutes, with the address and a QR
/// code of it that opens Crew on the phone and pairs it.
pub fn new_pair_code() -> anyhow::Result<Value> {
    let s = load_settings();
    if !s.enabled {
        anyhow::bail!("mobile access is off");
    }
    let n = u32::from_le_bytes(random_bytes(4).try_into().unwrap_or([0; 4])) % 1_000_000;
    let code = format!("{n:06}");
    if let Ok(mut st) = state().lock() {
        st.code = Some(PairCode {
            code: code.clone(),
            expires: Instant::now() + PAIR_TTL,
            tries: 0,
        });
        st.fails.clear();
    }
    let base = urls(s.port()).into_iter().next().unwrap_or_default();
    let link = format!("{base}/?pair={code}");
    let svg = qrcode::QrCode::new(link.as_bytes())
        .map(|q| {
            q.render::<qrcode::render::svg::Color>()
                .min_dimensions(200, 200)
                .quiet_zone(true)
                .build()
        })
        .unwrap_or_default();
    Ok(json!({
        "code": code,
        "expiresIn": PAIR_TTL.as_secs(),
        "url": link,
        "qrSvg": svg,
    }))
}

pub fn revoke(id: &str) -> anyhow::Result<Value> {
    let Some(mut list) = devices_to_change() else {
        anyhow::bail!("the list of connected devices could not be read; nothing was changed");
    };
    list.retain(|d| d.id != id);
    save_devices(&list)?;
    Ok(status())
}

#[derive(Debug, PartialEq)]
enum PairError {
    Locked,
    Wrong,
    /// The list of devices cannot be read. Adding one would write it over.
    Unreadable,
}

/// Trade a code for a device token. A code is used once.
fn pair(code: &str, name: &str) -> Result<String, PairError> {
    pair_replacing(code, name, None)
}

/// `pair`, for a browser that still holds a device's token and connects again
/// (a new address, an expired pairing): that device's entry gets the new token
/// instead of a second one beside it, so Settings does not fill up with the
/// same phone.
fn pair_replacing(code: &str, name: &str, old_token: Option<&str>) -> Result<String, PairError> {
    let mut st = state().lock().map_err(|_| PairError::Locked)?;
    st.fails.retain(|t| t.elapsed() < FAIL_WINDOW);
    if st.fails.len() as u32 >= FAIL_LIMIT {
        return Err(PairError::Locked);
    }
    let good = st
        .code
        .as_ref()
        .is_some_and(|c| c.expires > Instant::now() && c.code == code.trim());
    if !good {
        st.fails.push(Instant::now());
        if let Some(c) = st.code.as_mut() {
            c.tries += 1;
            if c.tries >= PAIR_TRIES || c.expires <= Instant::now() {
                st.code = None;
            }
        }
        return Err(PairError::Wrong);
    }
    st.code = None;
    drop(st);
    let token = hex(&random_bytes(32));
    let Some(mut list) = devices_to_change() else {
        return Err(PairError::Unreadable);
    };
    let now = now_secs();
    let old = old_token.map(hash_token);
    match old.and_then(|h| list.iter_mut().find(|d| d.hash == h)) {
        Some(device) => {
            device.hash = hash_token(&token);
            device.name = name.to_string();
            device.last_seen = now;
        }
        None => list.push(Device {
            id: hex(&random_bytes(6)),
            name: name.to_string(),
            hash: hash_token(&token),
            created: now,
            last_seen: now,
        }),
    }
    save_devices(&list).map_err(|_| PairError::Locked)?;
    Ok(token)
}

/// The paired device this token belongs to.
fn device_for(token: &str) -> Option<Device> {
    let hash = hash_token(token);
    let mut list = load_devices();
    let found = list.iter_mut().find(|d| d.hash == hash)?;
    let now = now_secs();
    // Written at most hourly, so a busy phone does not rewrite the file.
    if now.saturating_sub(found.last_seen) > 3600 {
        found.last_seen = now;
        let d = found.clone();
        let _ = save_devices(&list);
        return Some(d);
    }
    Some(found.clone())
}

fn device_name(user_agent: &str) -> String {
    let ua = user_agent.to_ascii_lowercase();
    let kind = if ua.contains("iphone") {
        "iPhone"
    } else if ua.contains("ipad") {
        "iPad"
    } else if ua.contains("android") {
        "Android"
    } else {
        "Browser"
    };
    kind.to_string()
}

// ------------------------------------------------------------------ files

/// The places a file may be shown from: the Crew home, the user's home and
/// the temp folders.
fn file_roots() -> Vec<PathBuf> {
    let mut roots = vec![
        crate::paths::home_dir(),
        PathBuf::from("/tmp"),
        PathBuf::from("/private/tmp"),
        PathBuf::from("/private/var/folders"),
        // How the temp folder is written before the system's link is followed.
        PathBuf::from("/var/folders"),
    ];
    if let Ok(home) = std::env::var("HOME") {
        roots.push(PathBuf::from(home));
    }
    roots
}

/// The part of `path` under the deepest of `roots` that holds it, or None when
/// no root does. Nothing hidden is under it (`.ssh`, `.aws`, `.git` …).
fn shown_under<'a>(path: &'a Path, roots: &[PathBuf]) -> Option<&'a Path> {
    let root = roots
        .iter()
        .filter(|r| path.starts_with(r))
        .max_by_key(|r| r.components().count())?;
    path.strip_prefix(root).ok()
}

fn is_hidden(rest: &Path) -> bool {
    rest.components()
        .any(|c| c.as_os_str().to_string_lossy().starts_with('.'))
}

/// Where `/api/file` may read: the Crew home, the user's home and the temp
/// folders, and inside them nothing hidden (`.ssh`, `.aws`, `.git` …).
pub(crate) fn file_allowed(path: &Path) -> Option<PathBuf> {
    let real = path.canonicalize().ok()?;
    if !real.is_file() {
        return None;
    }
    let roots: Vec<PathBuf> = file_roots()
        .iter()
        .filter_map(|r| r.canonicalize().ok())
        .collect();
    let rest = shown_under(&real, &roots)?;
    (!is_hidden(rest)).then_some(real)
}

/// What the archive learns of a file it lists.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum FileState {
    /// A file `/api/file` shows.
    Exists,
    /// Not there, or not a file.
    Missing,
    /// Where files are not shown: a hidden folder, or outside the Crew home,
    /// the user's home and the temp folders. Whether it exists is not looked
    /// at, so the answer says nothing of it.
    Blocked,
}

/// `path` as `/api/file` would take it, said three ways. A path that is
/// blocked by where it is written never touches the disk; only a link that
/// leads out of the allowed places is found by looking.
pub(crate) fn file_state(path: &Path) -> FileState {
    use std::path::Component;
    if !path.is_absolute() {
        return FileState::Missing;
    }
    // `..` and `.` read as they are written, with no help from the disk.
    let mut written = PathBuf::new();
    for part in path.components() {
        match part {
            Component::ParentDir => {
                written.pop();
            }
            Component::CurDir => {}
            other => written.push(other.as_os_str()),
        }
    }
    let mut roots = file_roots();
    roots.extend(roots.clone().iter().filter_map(|r| r.canonicalize().ok()));
    match shown_under(&written, &roots) {
        Some(rest) if !is_hidden(rest) => {}
        _ => return FileState::Blocked,
    }
    let Ok(real) = path.canonicalize() else {
        return FileState::Missing;
    };
    let canon: Vec<PathBuf> = file_roots()
        .iter()
        .filter_map(|r| r.canonicalize().ok())
        .collect();
    match shown_under(&real, &canon) {
        Some(rest) if !is_hidden(rest) => {}
        _ => return FileState::Blocked,
    }
    if real.is_file() {
        FileState::Exists
    } else {
        FileState::Missing
    }
}

fn content_type(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "webmanifest" => "application/manifest+json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "heic" => "image/heic",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "wav" => "audio/wav",
        "pdf" => "application/pdf",
        "txt" | "md" | "log" | "csv" | "rs" | "ts" | "tsx" | "py" | "sh" | "toml" | "yaml"
        | "yml" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// `bytes=a-b` against a file of `len` bytes: the inclusive range to send.
fn parse_range(header: &str, len: u64) -> Option<(u64, u64)> {
    let spec = header.trim().strip_prefix("bytes=")?;
    let (a, b) = spec.split(',').next()?.split_once('-')?;
    if len == 0 {
        return None;
    }
    let (start, end) = match (a.trim(), b.trim()) {
        ("", n) => {
            let n: u64 = n.parse().ok()?;
            (len.saturating_sub(n), len - 1)
        }
        (s, "") => (s.parse().ok()?, len - 1),
        (s, e) => (s.parse().ok()?, e.parse::<u64>().ok()?.min(len - 1)),
    };
    (start <= end && start < len).then_some((start, end))
}

// ------------------------------------------------------------ static UI

struct NoAssets;

impl tauri::Assets<tauri::Wry> for NoAssets {
    fn get(&self, _key: &tauri::utils::assets::AssetKey) -> Option<std::borrow::Cow<'_, [u8]>> {
        None
    }
    fn iter(&self) -> Box<tauri::utils::assets::AssetsIter<'_>> {
        Box::new(std::iter::empty())
    }
    fn csp_hashes(
        &self,
        _html_path: &tauri::utils::assets::AssetKey,
    ) -> Box<dyn Iterator<Item = tauri::utils::assets::CspHash<'_>> + '_> {
        Box::new(std::iter::empty())
    }
}

/// The UI built into this binary. A dev build may have none; then
/// `CREW_WEB_DIST` names a built `ui/dist` to serve instead.
fn embedded() -> &'static Option<Box<dyn tauri::Assets<tauri::Wry>>> {
    static ASSETS: OnceLock<Option<Box<dyn tauri::Assets<tauri::Wry>>>> = OnceLock::new();
    ASSETS.get_or_init(|| {
        let mut ctx = crate::desktop::context();
        let assets = ctx.set_assets(Box::new(NoAssets));
        let key = tauri::utils::assets::AssetKey::from("/index.html");
        assets.get(&key).is_some().then_some(assets)
    })
}

fn asset(path: &str) -> Option<Vec<u8>> {
    if let Ok(dir) = std::env::var("CREW_WEB_DIST") {
        let dir = PathBuf::from(dir);
        let file = dir.join(path.trim_start_matches('/'));
        let real = file.canonicalize().ok()?;
        if real.starts_with(dir.canonicalize().ok()?) && real.is_file() {
            return fs::read(real).ok();
        }
        return None;
    }
    let assets = embedded().as_ref()?;
    assets
        .get(&tauri::utils::assets::AssetKey::from(path))
        .map(|c| c.into_owned())
}

/// `index.html` with the web flag loaded before the app's own scripts.
fn index_html() -> Option<Vec<u8>> {
    let html = String::from_utf8(asset("/index.html")?).ok()?;
    let tag = r#"<script src="/crew-web.js"></script>"#;
    let out = match html.find("<script") {
        Some(at) => format!("{}{tag}{}", &html[..at], &html[at..]),
        None => html.replacen("</head>", &format!("{tag}</head>"), 1),
    };
    Some(out.into_bytes())
}

// ---------------------------------------------------------------- requests

type Reply = Response<std::io::Cursor<Vec<u8>>>;

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("valid header")
}

fn json_reply(code: u16, v: &Value) -> Reply {
    Response::from_data(serde_json::to_vec(v).unwrap_or_default())
        .with_status_code(code)
        .with_header(header("Content-Type", "application/json"))
        .with_header(header("Cache-Control", "no-store"))
}

fn error(code: u16, msg: &str) -> Reply {
    json_reply(code, &json!({ "error": msg }))
}

fn request_header<'a>(req: &'a Request, name: &str) -> Option<&'a str> {
    req.headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|h| h.value.as_str())
}

fn cookie_token(req: &Request) -> Option<String> {
    let raw = request_header(req, "Cookie")?;
    raw.split(';').find_map(|part| {
        let (k, v) = part.trim().split_once('=')?;
        (k == COOKIE).then(|| v.to_string())
    })
}

fn query(url: &str, key: &str) -> Option<String> {
    let q = url.split_once('?')?.1;
    q.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        (k == key).then(|| percent_decode(v))
    })
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => match u8::from_str_radix(&s[i + 1..i + 3], 16) {
                Ok(b) => {
                    out.push(b);
                    i += 2;
                }
                Err(_) => out.push(b'%'),
            },
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A request for this server by a name it answers to. Anything else is a
/// page elsewhere pointing a browser at it (DNS rebinding).
fn host_allowed(host: Option<&str>) -> bool {
    let Some(host) = host else {
        return false;
    };
    let name = if let Some(rest) = host.strip_prefix('[') {
        rest.split(']').next().unwrap_or("")
    } else {
        host.rsplit_once(':').map_or(host, |(h, _)| h)
    };
    if matches!(name, "localhost" | "127.0.0.1" | "::1") {
        return true;
    }
    if let Ok(ip) = name.parse::<IpAddr>() {
        return state()
            .lock()
            .map(|st| st.bound.iter().any(|a| a.ip() == ip))
            .unwrap_or(false);
    }
    known_tailnet()
        .and_then(|t| t.dns)
        .is_some_and(|dns| dns.eq_ignore_ascii_case(name))
}

fn peer_check(addr: Option<&SocketAddr>) -> PeerCheck {
    let Some(addr) = addr else {
        return PeerCheck::No;
    };
    let ip = match addr.ip() {
        IpAddr::V6(v6) => v6
            .to_ipv4_mapped()
            .map(IpAddr::V4)
            .unwrap_or(IpAddr::V6(v6)),
        ip => ip,
    };
    if ip.is_loopback() {
        return PeerCheck::Yes;
    }
    if is_tailnet_ip(&ip) {
        tailnet_peer_check(ip)
    } else {
        PeerCheck::No
    }
}

/// The device cookie as the server sets it. Sent again when a paired phone
/// opens the app, so a year runs from the last visit, not from pairing.
fn device_cookie(token: &str) -> String {
    format!("{COOKIE}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000")
}

/// Whether a rejected request is worth a line in the log now: once in ten
/// minutes for each peer and reason, so a phone that retries does not fill it.
fn should_log_unauthorized(
    seen: &mut HashMap<String, Instant>,
    key: &str,
    now: Instant,
) -> bool {
    seen.retain(|_, at| now.duration_since(*at) < Duration::from_secs(600));
    if seen.contains_key(key) {
        return false;
    }
    seen.insert(key.to_string(), now);
    true
}

/// Why a phone was told to connect again, for the log: it sent no device
/// cookie (a new browser or home screen app, or another address, which keeps
/// its own cookies), or one this Mac does not know.
fn note_unauthorized(req: &Request, token: Option<&str>) {
    let reason = if token.is_none() { "no device cookie" } else { "unknown device token" };
    let from = req
        .remote_addr()
        .map(|a| a.ip().to_string())
        .unwrap_or_else(|| "?".into());
    let host = request_header(req, "Host").unwrap_or("?").to_string();
    let key = format!("{from}|{reason}|{host}");
    let log = state()
        .lock()
        .map(|mut st| should_log_unauthorized(&mut st.unauthorized, &key, Instant::now()))
        .unwrap_or(false);
    if log {
        eprintln!(
            "[crew] mobile: asked {from} to connect again ({reason}; host {host}; {} devices known)",
            load_devices().len()
        );
    }
}

fn handle(mut req: Request) {
    let url = req.url().to_string();
    let path = url.split('?').next().unwrap_or("/").to_string();
    let method = req.method().clone();
    let check = peer_check(req.remote_addr());
    if check == PeerCheck::No {
        let _ = req.respond(error(403, "not this Mac's Tailscale user"));
        return;
    }
    if check == PeerCheck::Unknown {
        let is_pair = path == "/api/pair";
        let is_api = path.starts_with("/api/");
        let paired = is_api
            && !is_pair
            && cookie_token(&req).and_then(|t| device_for(&t)).is_some();
        if !admitted(check, is_api, is_pair, paired) {
            let _ = req.respond(error(403, "Tailscale did not say whose device this is; try again in a moment"));
            return;
        }
    }
    if !host_allowed(request_header(&req, "Host")) {
        let _ = req.respond(error(421, "unknown host"));
        return;
    }
    if path == "/api/pair" && method == Method::Post {
        let reply = pair_request(&mut req);
        let _ = req.respond(reply);
        return;
    }
    if path.starts_with("/api/") {
        let token = cookie_token(&req);
        let device = token.as_deref().and_then(device_for);
        let Some(device) = device else {
            note_unauthorized(&req, token.as_deref());
            let _ = req.respond(error(401, "connect this device first"));
            return;
        };
        if path == "/api/session" {
            let mut reply = json_reply(200, &json!({ "device": device.name }));
            if let Some(token) = token.as_deref() {
                reply = reply.with_header(header("Set-Cookie", &device_cookie(token)));
            }
            let _ = req.respond(reply);
            return;
        }
        if let Some(cmd) = path.strip_prefix("/api/invoke/") {
            if method != Method::Post {
                let _ = req.respond(error(405, "POST"));
                return;
            }
            let reply = invoke_request(&mut req, cmd);
            let _ = req.respond(reply);
            return;
        }
        if path == "/api/upload" && method == Method::Post {
            let reply = upload_request(&mut req, &url);
            let _ = req.respond(reply);
            return;
        }
        if path == "/api/file" && method == Method::Get {
            file_request(req, &url);
            return;
        }
        let _ = req.respond(error(404, "no such endpoint"));
        return;
    }
    if method != Method::Get && method != Method::Head {
        let _ = req.respond(error(405, "GET"));
        return;
    }
    let _ = req.respond(static_reply(&path));
}

fn static_reply(path: &str) -> Reply {
    if path == "/crew-web.js" {
        return Response::from_data(b"window.__CREW_WEB__ = true;\n".to_vec())
            .with_header(header("Content-Type", "text/javascript; charset=utf-8"))
            .with_header(header("Cache-Control", "no-store"));
    }
    let clean = path.split('#').next().unwrap_or("/");
    let is_index = clean == "/" || clean == "/index.html";
    let found = if is_index { None } else { asset(clean) };
    // Unknown paths without an extension are the app's own; they get the app.
    let (body, ctype, cache) = match found {
        Some(b) => (b, content_type(Path::new(clean)), "public, max-age=3600"),
        None if is_index || !clean.rsplit('/').next().unwrap_or("").contains('.') => {
            match index_html() {
                Some(b) => (b, "text/html; charset=utf-8", "no-store"),
                None => return error(503, "this build has no web UI"),
            }
        }
        None => return error(404, "not found"),
    };
    Response::from_data(body)
        .with_header(header("Content-Type", ctype))
        .with_header(header("Cache-Control", cache))
        .with_header(header("X-Content-Type-Options", "nosniff"))
}

fn read_body(req: &mut Request, limit: u64) -> Result<Vec<u8>, Reply> {
    if req.body_length().is_some_and(|n| n as u64 > limit) {
        return Err(error(413, "too large"));
    }
    let mut buf = Vec::new();
    let mut reader = req.as_reader().take(limit + 1);
    if reader.read_to_end(&mut buf).is_err() {
        return Err(error(400, "could not read the body"));
    }
    if buf.len() as u64 > limit {
        return Err(error(413, "too large"));
    }
    Ok(buf)
}

fn pair_request(req: &mut Request) -> Reply {
    let body = match read_body(req, 4096) {
        Ok(b) => b,
        Err(r) => return r,
    };
    let v: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let code = v["code"].as_str().unwrap_or("");
    let ua = request_header(req, "User-Agent").unwrap_or("");
    let name = v["name"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(40).collect())
        .unwrap_or_else(|| device_name(ua));
    let old = cookie_token(req);
    match pair_replacing(code, &name, old.as_deref()) {
        Ok(token) => json_reply(200, &json!({ "device": name }))
            .with_header(header("Set-Cookie", &device_cookie(&token))),
        Err(PairError::Wrong) => error(403, "wrong or expired code"),
        Err(PairError::Locked) => error(429, "too many wrong codes; make a new one on the Mac"),
        Err(PairError::Unreadable) => error(
            500,
            "the list of connected devices could not be read; nothing was changed",
        ),
    }
}

fn invoke_request(req: &mut Request, cmd: &str) -> Reply {
    let body = match read_body(req, UPLOAD_LIMIT * 2) {
        Ok(b) => b,
        Err(r) => return r,
    };
    let args: Value = if body.is_empty() {
        json!({})
    } else {
        match serde_json::from_slice(&body) {
            Ok(v) => v,
            Err(err) => return error(400, &format!("arguments are not JSON: {err}")),
        }
    };
    match run_command(cmd, args) {
        Some(Ok(v)) => json_reply(200, &v),
        Some(Err(msg)) => error(500, &msg),
        None => error(404, &format!("unknown command {cmd}")),
    }
}

/// A window command, run for the phone. The ones that need the window, or
/// that would open something on the Mac, answer for the web instead.
pub fn run_command(cmd: &str, args: Value) -> Option<Result<Value, String>> {
    match cmd {
        // The phone has no dock or menu bar of this Mac's to change.
        "set_dock_badge" | "set_escape_layer" => Some(Ok(Value::Null)),
        "set_locale" => {
            let locale = args["locale"].as_str().unwrap_or("ko");
            crate::paths::write_locale(locale);
            Some(Ok(Value::Null))
        }
        "pick_folder" | "open_path" | "open_url" => Some(Err(format!(
            "{cmd} opens something on the Mac and is not available from the phone"
        ))),
        _ => crate::web_dispatch::dispatch(cmd, args),
    }
}

/// An upload as the raw bytes with `?name=`, or as `multipart/form-data`
/// with the file in its first file part (a browser `FormData`).
fn upload_request(req: &mut Request, url: &str) -> Reply {
    let ctype = request_header(req, "Content-Type")
        .unwrap_or("")
        .to_string();
    let body = match read_body(req, UPLOAD_LIMIT + 64 * 1024) {
        Ok(b) => b,
        Err(r) => return r,
    };
    let (name, bytes) = if ctype
        .to_ascii_lowercase()
        .starts_with("multipart/form-data")
    {
        match multipart_file(&ctype, &body) {
            Some((name, bytes)) => (name, bytes.to_vec()),
            None => return error(400, "no file in the form"),
        }
    } else {
        (query(url, "name").unwrap_or_else(|| "upload".into()), body)
    };
    if bytes.len() as u64 > UPLOAD_LIMIT {
        return error(413, "too large");
    }
    let name = query(url, "name").unwrap_or(name);
    match save_bytes(&name, &bytes) {
        Ok(path) => json_reply(200, &json!({ "path": path })),
        Err(err) => error(500, &err.to_string()),
    }
}

/// The first part of a `multipart/form-data` body that carries a file: its
/// file name and its bytes.
fn multipart_file<'a>(ctype: &str, body: &'a [u8]) -> Option<(String, &'a [u8])> {
    let boundary = ctype
        .split(';')
        .map(str::trim)
        .find_map(|p| p.strip_prefix("boundary="))?
        .trim_matches('"');
    let delim = format!("--{boundary}");
    let delim = delim.as_bytes();
    let find = |hay: &[u8], needle: &[u8], from: usize| -> Option<usize> {
        hay.get(from..)?
            .windows(needle.len())
            .position(|w| w == needle)
            .map(|i| i + from)
    };
    let mut at = find(body, delim, 0)?;
    loop {
        let start = at + delim.len();
        if body.get(start..start + 2) == Some(b"--") {
            return None;
        }
        let head_end = find(body, b"\r\n\r\n", start)?;
        let head = String::from_utf8_lossy(&body[start..head_end]).to_string();
        let data_start = head_end + 4;
        let next = find(body, delim, data_start)?;
        // The part ends with CRLF before the next delimiter.
        let data_end = next.saturating_sub(2).max(data_start);
        let disposition = head
            .lines()
            .find(|l| l.to_ascii_lowercase().starts_with("content-disposition"))
            .unwrap_or("");
        if let Some(name) = disposition
            .split(';')
            .map(str::trim)
            .find_map(|p| p.strip_prefix("filename="))
        {
            let name = name.trim_matches('"').to_string();
            return Some((
                if name.is_empty() {
                    "upload".into()
                } else {
                    name
                },
                &body[data_start..data_end],
            ));
        }
        at = next;
    }
}

/// Like the window's `save_upload`, from raw bytes.
pub fn save_bytes(name: &str, bytes: &[u8]) -> anyhow::Result<String> {
    let dir = crate::paths::home_dir().join("uploads");
    fs::create_dir_all(&dir)?;
    let stamp = crate::paths::utc_timestamp();
    let safe = crate::paths::safe_agent_id(name);
    let path = crate::paths::write_new_file(&dir, &stamp, &safe, bytes)?;
    Ok(path.to_string_lossy().into_owned())
}

fn file_request(req: Request, url: &str) {
    let Some(raw) = query(url, "path") else {
        let _ = req.respond(error(400, "path is required"));
        return;
    };
    // The window sends a path as a bot wrote it, `~/…` included.
    let Some(real) = file_allowed(&crate::paths::expand_tilde(&raw)) else {
        let _ = req.respond(error(404, "not found"));
        return;
    };
    let Ok(mut file) = fs::File::open(&real) else {
        let _ = req.respond(error(404, "not found"));
        return;
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let range = request_header(&req, "Range").and_then(|h| parse_range(h, len));
    let (status, start, count) = match range {
        Some((a, b)) => (206, a, b - a + 1),
        None => (200, 0, len),
    };
    if start > 0 && file.seek(SeekFrom::Start(start)).is_err() {
        let _ = req.respond(error(500, "seek failed"));
        return;
    }
    let mut headers = vec![
        header("Content-Type", content_type(&real)),
        header("Accept-Ranges", "bytes"),
        header("Cache-Control", "private, max-age=300"),
        header("X-Content-Type-Options", "nosniff"),
        // A file shown from here never runs script, whatever it holds.
        header("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox"),
    ];
    if status == 206 {
        headers.push(header(
            "Content-Range",
            &format!("bytes {start}-{}/{len}", start + count - 1),
        ));
    }
    let reply = Response::new(
        StatusCode(status),
        headers,
        file.take(count),
        Some(count as usize),
        None,
    );
    let _ = req.respond(reply);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths;

    /// The phone E2E's daemon is reached from this Mac alone. Mobile access
    /// as the user turns it on also listens on the Tailscale IPv4 address.
    #[test]
    fn loopback_only_listens_on_127_0_0_1_alone() {
        let ts: Vec<IpAddr> = vec!["100.111.145.71".parse().unwrap(), "fd7a::1".parse().unwrap()];
        let lo = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 47899);
        assert_eq!(listen_addrs(47899, &[]), [lo]);
        assert_eq!(
            listen_addrs(47899, &ts),
            [lo, "100.111.145.71:47899".parse().unwrap()]
        );
        let on = Settings {
            enabled: true,
            port: Some(47899),
            loopback: true,
        };
        assert_eq!(wanted(&on), [lo]);
    }

    #[test]
    fn loopback_is_read_from_mobile_json_and_left_out_when_off() {
        paths::testing::with_home("web-loopback", || {
            fs::write(settings_path(), br#"{"enabled":true,"port":47899,"loopback":true}"#).unwrap();
            assert!(load_settings().loopback);
            save_settings(&Settings {
                enabled: true,
                port: None,
                loopback: false,
            })
            .unwrap();
            let raw = fs::read_to_string(settings_path()).unwrap();
            assert!(!raw.contains("loopback"), "{raw}");
        });
    }

    #[test]
    fn a_code_pairs_once_and_wrong_codes_run_out() {
        paths::testing::with_home("web-pair", || {
            save_settings(&Settings {
                enabled: true,
                port: Some(0),
                loopback: true,
            })
            .unwrap();
            let made = new_pair_code().unwrap();
            let code = made["code"].as_str().unwrap().to_string();
            assert_eq!(code.len(), 6);
            assert!(made["qrSvg"].as_str().unwrap().contains("<svg"));
            assert_eq!(pair("000000x", "iPhone"), Err(PairError::Wrong));
            let token = pair(&code, "iPhone").unwrap();
            assert_eq!(device_for(&token).unwrap().name, "iPhone");
            assert!(device_for("nope").is_none());
            assert_eq!(
                pair(&code, "again"),
                Err(PairError::Wrong),
                "a code is used once"
            );
            let stored = fs::read_to_string(devices_path()).unwrap();
            assert!(!stored.contains(&token), "only the hash is kept");

            let code = new_pair_code().unwrap()["code"]
                .as_str()
                .unwrap()
                .to_string();
            for _ in 0..PAIR_TRIES {
                let _ = pair("999999x", "x");
            }
            assert_eq!(
                pair(&code, "late"),
                Err(PairError::Wrong),
                "the code ran out of tries"
            );

            let id = load_devices()[0].id.clone();
            revoke(&id).unwrap();
            assert!(device_for(&token).is_none(), "a removed device is out");
            stop_all();
        });
    }

    #[test]
    fn only_allowed_files_are_served() {
        paths::testing::with_home("web-file", || {
            let home = paths::home_dir();
            let ok = home.join("uploads/pic.png");
            fs::create_dir_all(ok.parent().unwrap()).unwrap();
            fs::write(&ok, b"x").unwrap();
            assert!(file_allowed(&ok).is_some());
            let hidden = home.join(".secret/key");
            fs::create_dir_all(hidden.parent().unwrap()).unwrap();
            fs::write(&hidden, b"x").unwrap();
            assert!(file_allowed(&hidden).is_none(), "a hidden folder");
            let escape = home.join("uploads/../.secret/key");
            assert!(file_allowed(&escape).is_none(), "a path that climbs out");
            assert!(
                file_allowed(Path::new("/etc/hosts")).is_none(),
                "outside the roots"
            );
            assert!(file_allowed(&home.join("uploads")).is_none(), "a folder");
            assert_eq!(
                content_type(Path::new("/manifest.webmanifest")),
                "application/manifest+json"
            );
        });
    }

    #[test]
    fn a_form_upload_gives_its_file() {
        let body = b"--XyZ\r\nContent-Disposition: form-data; name=\"note\"\r\n\r\nhi\r\n--XyZ\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a b.png\"\r\nContent-Type: image/png\r\n\r\n\x89PNG\r\nrest\r\n--XyZ--\r\n";
        let (name, bytes) = multipart_file("multipart/form-data; boundary=XyZ", body).unwrap();
        assert_eq!(name, "a b.png");
        assert_eq!(bytes, b"\x89PNG\r\nrest");
        assert!(multipart_file("multipart/form-data; boundary=XyZ", b"--XyZ--\r\n").is_none());
    }

    #[test]
    fn ranges_and_names() {
        assert_eq!(parse_range("bytes=0-9", 100), Some((0, 9)));
        assert_eq!(parse_range("bytes=90-", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=-10", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=50-500", 100), Some((50, 99)));
        assert_eq!(parse_range("bytes=200-", 100), None);
        assert_eq!(percent_decode("%2Ftmp%2Fa%20b.png"), "/tmp/a b.png");
        assert_eq!(
            query("/api/file?path=%2Ftmp%2Fx&y=1", "path").as_deref(),
            Some("/tmp/x")
        );
        assert!(is_tailnet_ip(&"100.111.145.71".parse().unwrap()));
        assert!(!is_tailnet_ip(&"100.200.0.1".parse().unwrap()));
        assert!(is_tailnet_ip(&"fd7a:115c:a1e0::a935:9148".parse().unwrap()));
        assert!(host_allowed(Some("localhost:47823")));
        assert!(host_allowed(Some("127.0.0.1:47823")));
        assert!(!host_allowed(Some("evil.example:47823")));
        assert!(!host_allowed(None));
    }

    #[test]
    fn tailscale_status_names_the_owner() {
        let v: Value = serde_json::from_str(
            r#"{"Self":{"DNSName":"mac.tail1.ts.net.","TailscaleIPs":["100.111.145.71","fd7a:115c:a1e0::1"],"UserID":7},
                "User":{"7":{"LoginName":"ada@example.com"}}}"#,
        )
        .unwrap();
        let t = parse_status(&v);
        assert_eq!(t.dns.as_deref(), Some("mac.tail1.ts.net"));
        assert_eq!(t.owner.as_deref(), Some("ada@example.com"));
        assert_eq!(t.ips.len(), 2);
    }

    #[test]
    fn the_phone_runs_window_commands_and_not_the_macs_dialogs() {
        paths::testing::with_home("web-dispatch", || {
            assert!(run_command("list_templates", json!({})).unwrap().is_ok());
            assert!(run_command("pick_folder", json!({})).unwrap().is_err());
            assert!(run_command("open_url", json!({"url": "https://x"}))
                .unwrap()
                .is_err());
            assert_eq!(
                run_command("set_dock_badge", json!({"count": 3})),
                Some(Ok(Value::Null))
            );
            assert!(run_command("no_such_command", json!({})).is_none());
            let err = run_command("remove_template", json!({}))
                .unwrap()
                .unwrap_err();
            assert!(err.contains("argument id"), "{err}");
        });
    }

    /// `(status, headers, body)` for one request to `addr`.
    fn http(addr: SocketAddr, raw: &[u8]) -> (u16, String, Vec<u8>) {
        use std::io::Write;
        let mut conn = std::net::TcpStream::connect(addr).unwrap();
        conn.set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        conn.write_all(raw).unwrap();
        let mut out = Vec::new();
        conn.read_to_end(&mut out).unwrap();
        let split = out.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        let head = String::from_utf8_lossy(&out[..split]).to_string();
        let status = head.split(' ').nth(1).unwrap().parse().unwrap();
        (status, head, out[split + 4..].to_vec())
    }

    fn get(addr: SocketAddr, path: &str, extra: &str) -> (u16, String, Vec<u8>) {
        http(
            addr,
            format!("GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n{extra}\r\n")
                .as_bytes(),
        )
    }

    fn post(addr: SocketAddr, path: &str, extra: &str, body: &[u8]) -> (u16, String, Vec<u8>) {
        let mut raw = format!(
            "POST {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Length: {}\r\n{extra}\r\n",
            body.len()
        )
        .into_bytes();
        raw.extend_from_slice(body);
        http(addr, &raw)
    }

    /// A phone's whole first visit, over a real socket: the app, pairing,
    /// a command, a file, an upload.
    #[test]
    fn a_phone_pairs_and_runs_the_app() {
        paths::testing::with_home("web-e2e", || {
            let dist = paths::home_dir().join("dist");
            fs::create_dir_all(dist.join("assets")).unwrap();
            fs::write(
                dist.join("index.html"),
                "<html><head><script src=\"/assets/app.js\"></script></head></html>",
            )
            .unwrap();
            fs::write(dist.join("assets/app.js"), "console.log(1)").unwrap();
            std::env::set_var("CREW_WEB_DIST", &dist);
            save_settings(&Settings {
                enabled: true,
                port: Some(0),
                loopback: true,
            })
            .unwrap();
            bind_all().unwrap();
            let addr = state().lock().unwrap().servers[0]
                .server
                .server_addr()
                .to_ip()
                .unwrap();

            let (code, _, body) = get(addr, "/", "");
            assert_eq!(code, 200);
            let html = String::from_utf8(body).unwrap();
            assert!(
                html.find("/crew-web.js").unwrap() < html.find("/assets/app.js").unwrap(),
                "{html}"
            );
            let (code, _, body) = get(addr, "/crew-web.js", "");
            assert_eq!(
                (
                    code,
                    String::from_utf8(body).unwrap().contains("__CREW_WEB__")
                ),
                (200, true)
            );
            assert_eq!(get(addr, "/assets/app.js", "").0, 200);
            assert_eq!(
                get(addr, "/settings", "").0,
                200,
                "an app path gets the app"
            );

            assert_eq!(get(addr, "/api/session", "").0, 401);
            assert_eq!(post(addr, "/api/invoke/list_templates", "", b"{}").0, 401);
            let rebind = http(
                addr,
                b"GET / HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n",
            );
            assert_eq!(rebind.0, 421, "a page elsewhere pointing at this server");

            let pin = new_pair_code().unwrap()["code"]
                .as_str()
                .unwrap()
                .to_string();
            assert_eq!(post(addr, "/api/pair", "", br#"{"code":"123"}"#).0, 403);
            let (code, head, _) = post(
                addr,
                "/api/pair",
                "User-Agent: Mozilla (iPhone)\r\n",
                format!(r#"{{"code":"{pin}"}}"#).as_bytes(),
            );
            assert_eq!(code, 200);
            let cookie_line = head
                .lines()
                .find(|l| l.to_ascii_lowercase().starts_with("set-cookie"))
                .unwrap();
            assert!(
                cookie_line.contains("HttpOnly") && cookie_line.contains("SameSite=Strict"),
                "{cookie_line}"
            );
            let token = cookie_line
                .split("crew_device=")
                .nth(1)
                .unwrap()
                .split(';')
                .next()
                .unwrap();
            let auth = format!("Cookie: crew_device={token}\r\n");

            let (code, _, body) = get(addr, "/api/session", &auth);
            assert_eq!(code, 200);
            assert!(String::from_utf8(body).unwrap().contains("iPhone"));
            let (code, _, body) = post(addr, "/api/invoke/list_templates", &auth, b"{}");
            assert_eq!(code, 200);
            let v: Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(v.as_array().unwrap().len(), 4, "Crew's templates");
            let (code, _, body) = post(addr, "/api/invoke/pick_folder", &auth, b"{}");
            assert_eq!(code, 500);
            assert!(String::from_utf8(body).unwrap().contains("\"error\""));
            assert_eq!(post(addr, "/api/invoke/nope", &auth, b"{}").0, 404);

            let (code, _, body) = post(
                addr,
                "/api/upload?name=%EC%82%AC%EC%A7%84.png",
                &auth,
                b"0123456789",
            );
            assert_eq!(code, 200);
            let path = serde_json::from_slice::<Value>(&body).unwrap()["path"]
                .as_str()
                .unwrap()
                .to_string();
            assert!(path.contains("/uploads/"), "{path}");
            let q = path.replace('%', "%25").replace(' ', "%20");
            let (code, head, body) = get(
                addr,
                &format!("/api/file?path={q}"),
                &format!("{auth}Range: bytes=2-5\r\n"),
            );
            assert_eq!((code, body), (206, b"2345".to_vec()));
            assert!(head.contains("sandbox"), "{head}");
            assert_eq!(get(addr, "/api/file?path=/etc/hosts", &auth).0, 404);
            // A path as a bot wrote it, from the home folder.
            let file = Path::new(&path)
                .file_name()
                .unwrap()
                .to_string_lossy()
                .to_string();
            let old_home = std::env::var("HOME").ok();
            std::env::set_var("HOME", paths::home_dir());
            let tilde = get(
                addr,
                &format!(
                    "/api/file?path=%7E%2Fuploads%2F{}",
                    file.replace('%', "%25")
                ),
                &auth,
            );
            match old_home {
                Some(h) => std::env::set_var("HOME", h),
                None => std::env::remove_var("HOME"),
            }
            assert_eq!(
                (tilde.0, tilde.2),
                (200, b"0123456789".to_vec()),
                "a ~ path"
            );

            set_enabled(false).unwrap();
            std::thread::sleep(Duration::from_millis(300));
            assert!(
                std::net::TcpStream::connect(addr).is_err(),
                "turning it off closes the port"
            );
            std::env::remove_var("CREW_WEB_DIST");
        });
    }

    /// A new window command has a phone answer, or a reason it has none.
    #[test]
    fn every_window_command_has_a_web_answer() {
        let src = include_str!("desktop.rs");
        let start = src.find("generate_handler![").expect("handler") + "generate_handler![".len();
        let end = src[start..].find("])").expect("handler end");
        for name in src[start..start + end]
            .lines()
            .map(|l| l.trim().trim_end_matches(','))
            .filter(|l| !l.is_empty() && !l.starts_with("//"))
        {
            assert!(
                crate::web_dispatch::NAMES.contains(&name)
                    || crate::web_dispatch::SPECIAL.contains(&name)
                    || name.starts_with("mobile_"),
                "{name}: run scripts/gen_web_dispatch.py"
            );
        }
    }

    // --------------------------------------------- a phone stays connected

    /// Pair once and return the device cookie value, on the server at `addr`.
    fn pair_over_http(addr: SocketAddr) -> String {
        let pin = new_pair_code().unwrap()["code"].as_str().unwrap().to_string();
        let (code, head, _) = post(
            addr,
            "/api/pair",
            "User-Agent: Mozilla (iPhone)\r\n",
            format!(r#"{{"code":"{pin}"}}"#).as_bytes(),
        );
        assert_eq!(code, 200);
        let line = head
            .lines()
            .find(|l| l.to_ascii_lowercase().starts_with("set-cookie"))
            .unwrap();
        line.split("crew_device=").nth(1).unwrap().split(';').next().unwrap().to_string()
    }

    fn only_server_addr() -> SocketAddr {
        state().lock().unwrap().servers[0].server.server_addr().to_ip().unwrap()
    }

    fn forget_kept() {
        if let Ok(mut st) = state().lock() {
            st.kept = None;
        }
    }

    /// The Crew update that restarts the daemon, and a daemon that comes back on
    /// the same files: the device cookie from before is still this phone.
    #[test]
    fn a_connected_phone_is_known_after_the_server_restarts() {
        paths::testing::with_home("web-restart", || {
            save_settings(&Settings { enabled: true, port: Some(0), loopback: true }).unwrap();
            bind_all().unwrap();
            let token = pair_over_http(only_server_addr());
            stop_all();
            // A new daemon: nothing in memory, the same home.
            if let Ok(mut st) = state().lock() {
                *st = State::default();
            }
            bind_all().unwrap();
            let addr = only_server_addr();
            let (code, head, body) = get(addr, "/api/session", &format!("Cookie: crew_device={token}\r\n"));
            assert_eq!(code, 200, "{}", String::from_utf8_lossy(&body));
            // And it is asked to keep the cookie another year from this visit.
            let renewed = head
                .lines()
                .find(|l| l.to_ascii_lowercase().starts_with("set-cookie"))
                .expect("the session answer renews the cookie");
            assert!(renewed.contains(&format!("crew_device={token}")) && renewed.contains("Max-Age=31536000"), "{renewed}");
            assert_eq!(get(addr, "/api/session", "").0, 401, "no cookie is no device");
            assert_eq!(
                get(addr, "/api/session", "Cookie: crew_device=0000\r\n").0,
                401,
                "a token this Mac does not know"
            );
            stop_all();
        });
    }

    /// The pairing link and the address Settings shows are the MagicDNS name,
    /// the same one every time. When Tailscale does not answer (slow after an
    /// update) the name last seen stands in, instead of a bare IP: a browser
    /// keeps its cookie per host, so an IP link is another site and the phone
    /// would be asked to connect again.
    #[test]
    fn the_address_stays_the_dns_name_when_tailscale_does_not_answer() {
        paths::testing::with_home("web-dns", || {
            forget_kept();
            let ip: IpAddr = "100.111.145.71".parse().unwrap();
            let bound = |addr: SocketAddr| {
                state().lock().unwrap().bound = vec![SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 47823), addr];
            };
            bound(SocketAddr::new(ip, 47823));
            // Never seen: only the IP can be offered.
            assert_eq!(urls(47823)[0], "http://127.0.0.1:47823");
            assert!(!urls(47823).iter().any(|u| u.contains("ts.net")));
            // Tailscale answered once.
            keep_net(&Tailnet {
                ips: vec![ip],
                dns: Some("mac.tail55bae5.ts.net".into()),
                owner: Some("me@example.com".into()),
            });
            assert_eq!(urls(47823)[0], "http://mac.tail55bae5.ts.net:47823");
            // It does not answer now (a test's `tailnet()` never does).
            assert!(tailnet().is_none());
            assert_eq!(urls(47823)[0], "http://mac.tail55bae5.ts.net:47823");
            assert!(host_allowed(Some("mac.tail55bae5.ts.net:47823")));
            assert!(host_allowed(Some("MAC.tail55bae5.ts.net")), "names are not case sensitive");
            assert!(!host_allowed(Some("evil.example:47823")), "no other name");
            // Kept across a restart, and a later answer that lacks a part keeps it.
            forget_kept();
            assert_eq!(known_tailnet().unwrap().dns.as_deref(), Some("mac.tail55bae5.ts.net"));
            keep_net(&Tailnet { ips: vec![], dns: None, owner: None });
            let kept = known_tailnet().unwrap();
            assert_eq!(
                (kept.dns.as_deref(), kept.owner.as_deref(), kept.ips),
                (Some("mac.tail55bae5.ts.net"), Some("me@example.com"), vec![ip])
            );
            // A new name replaces the old one.
            keep_net(&Tailnet { ips: vec![ip], dns: Some("renamed.tail55bae5.ts.net".into()), owner: None });
            assert_eq!(urls(47823)[0], "http://renamed.tail55bae5.ts.net:47823");
            state().lock().unwrap().bound.clear();
            forget_kept();
        });
    }

    #[test]
    fn a_peer_tailscale_could_not_vouch_for_gets_the_app_and_its_own_session_but_never_pairing() {
        // Who whois names against whose Mac this is.
        assert_eq!(owner_verdict(Some("a@x"), Some("a@x")), PeerCheck::Yes);
        assert_eq!(owner_verdict(Some("a@x"), Some("b@x")), PeerCheck::No);
        // No answer is not a stranger.
        assert_eq!(owner_verdict(Some("a@x"), None), PeerCheck::Unknown);
        assert_eq!(owner_verdict(None, Some("a@x")), PeerCheck::Unknown);
        assert_eq!(owner_verdict(None, None), PeerCheck::Unknown);
        for (is_api, is_pair, paired) in [(false, false, false), (true, false, true), (true, true, true)] {
            assert!(admitted(PeerCheck::Yes, is_api, is_pair, paired));
            assert!(!admitted(PeerCheck::No, is_api, is_pair, paired));
        }
        let unknown = |is_api, is_pair, paired| admitted(PeerCheck::Unknown, is_api, is_pair, paired);
        assert!(unknown(false, false, false), "the app's files");
        assert!(unknown(true, false, true), "the API with a paired device's cookie");
        assert!(!unknown(true, false, false), "the API without one");
        assert!(!unknown(true, true, true), "pairing, even from a paired device");
    }

    /// A phone is not turned away as unknown because the device list could not
    /// be read once, and no new device is written over a list that cannot be.
    #[test]
    fn the_device_list_is_not_lost_to_a_file_that_cannot_be_read() {
        paths::testing::with_home("web-devices", || {
            save_settings(&Settings { enabled: true, port: Some(0), loopback: true }).unwrap();
            let make = |name: &str| {
                let code = new_pair_code().unwrap()["code"].as_str().unwrap().to_string();
                pair(&code, name).unwrap()
            };
            let first = make("iPhone");
            let second = make("iPad");
            assert_eq!(load_devices().len(), 2);
            assert!(devices_backup_path().exists(), "the list is copied with each change");

            // The file is damaged: the copy of the last good list stands in.
            fs::write(devices_path(), b"{ not json").unwrap();
            assert_eq!(device_for(&first).map(|d| d.name), Some("iPhone".into()));
            assert!(device_for("nope").is_none());
            // Adding a device restores from the copy instead of dropping the others.
            let third = make("Android");
            assert_eq!(load_devices().len(), 3);
            assert!(device_for(&second).is_some() && device_for(&third).is_some());

            // Neither readable: a pairing is refused and nothing is written over it.
            fs::write(devices_path(), b"{ not json").unwrap();
            fs::write(devices_backup_path(), b"[ also not").unwrap();
            let code = new_pair_code().unwrap()["code"].as_str().unwrap().to_string();
            assert_eq!(pair(&code, "Browser"), Err(PairError::Unreadable));
            assert_eq!(fs::read(devices_path()).unwrap(), b"{ not json");
            assert!(revoke("x").is_err());

            // A missing file is simply no devices yet.
            fs::remove_file(devices_path()).unwrap();
            fs::remove_file(devices_backup_path()).unwrap();
            assert!(load_devices().is_empty());
            let code = new_pair_code().unwrap()["code"].as_str().unwrap().to_string();
            assert!(pair(&code, "Browser").is_ok());
            stop_all();
        });
    }

    /// Connecting again from a browser that still holds a device's token keeps
    /// one entry for the phone, with the new token; a browser that holds none
    /// (or one this Mac lost) adds one.
    #[test]
    fn connecting_again_from_the_same_browser_keeps_one_entry() {
        paths::testing::with_home("web-repair", || {
            save_settings(&Settings { enabled: true, port: Some(0), loopback: true }).unwrap();
            let code = || new_pair_code().unwrap()["code"].as_str().unwrap().to_string();
            let first = pair_replacing(&code(), "iPhone", None).unwrap();
            let other = pair_replacing(&code(), "iPad", None).unwrap();
            assert_eq!(load_devices().len(), 2);
            let id = device_for(&first).unwrap().id;
            let again = pair_replacing(&code(), "iPhone", Some(&first)).unwrap();
            assert_eq!(load_devices().len(), 2, "the phone's own entry was given the new token");
            assert!(device_for(&first).is_none(), "the old token is out");
            assert_eq!(device_for(&again).unwrap().id, id);
            assert!(device_for(&other).is_some(), "the other device is untouched");
            // A token this Mac does not know replaces nothing.
            pair_replacing(&code(), "iPhone", Some("not-a-token")).unwrap();
            assert_eq!(load_devices().len(), 3);
            stop_all();
        });
    }

    #[test]
    fn a_rejected_phone_is_logged_once_in_ten_minutes_for_each_peer_and_reason() {
        let mut seen = HashMap::new();
        let t0 = Instant::now();
        assert!(should_log_unauthorized(&mut seen, "1.2.3.4|no device cookie|h", t0));
        assert!(!should_log_unauthorized(&mut seen, "1.2.3.4|no device cookie|h", t0 + Duration::from_secs(60)));
        assert!(should_log_unauthorized(&mut seen, "1.2.3.4|unknown device token|h", t0));
        assert!(should_log_unauthorized(&mut seen, "5.6.7.8|no device cookie|h", t0));
        assert!(should_log_unauthorized(&mut seen, "1.2.3.4|no device cookie|h", t0 + Duration::from_secs(601)));
    }
}
