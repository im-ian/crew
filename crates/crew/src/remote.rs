//! Remote bots: a teammate's representative bot on another PC, reached through
//! a crew-router. The plan and the wire protocol are in `docs/router.md`.
//!
//! One WebSocket per router in `remotes.json`. A remote bot's id is
//! `<alias>/<account>`. It has a transcript here, but no process: its turns run
//! on its owner's PC, and what it says comes back over the socket.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use anyhow::bail;
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message as WsMessage;

use crate::config::{AgentConfig, AvatarShape};
use crate::paths;
use crate::protocol::{AgentInfo, AgentStatus, AskQuestion, Event, Request};
use crate::targeting::TurnOrigin;

pub const PROTOCOL: u32 = 1;
/// One attachment. The router refuses a frame over 32MB.
const FILE_LIMIT: u64 = 25 * 1024 * 1024;
/// The router closes a socket on a frame over 32MB. Kept under it with room
/// for the JSON around the files, so one big frame cannot loop a reconnect.
const FRAME_LIMIT: usize = 30 * 1024 * 1024;
/// A custom face rides along only when it is small.
const AVATAR_LIMIT: usize = 256 * 1024;
const PROBE_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Peer {
    pub account: String,
    pub name: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RemoteConfig {
    pub alias: String,
    pub url: String,
    pub account: String,
    pub name: String,
    pub token: String,
    /// The local bot that answers for this PC on the router.
    pub bot: String,
    #[serde(default)]
    pub trusted: Vec<Peer>,
    #[serde(default)]
    pub blocked: Vec<Peer>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Member {
    pub account: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_shape: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_color: Option<String>,
    #[serde(default)]
    pub online: bool,
    #[serde(default = "idle")]
    pub status: String,
}

fn idle() -> String {
    "idle".into()
}

/// A router, as the settings and the sidebar see it. The token stays here.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteInfo {
    pub alias: String,
    pub url: String,
    pub name: String,
    pub account: String,
    pub bot: String,
    pub connected: bool,
    pub members: Vec<Member>,
    pub trusted: Vec<Peer>,
    pub blocked: Vec<Peer>,
    /// Why this PC stopped trying to connect, when it did.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// What a router said about itself before anyone signed in.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteServer {
    pub url: String,
    pub name: String,
    pub version: String,
    pub protocol: u32,
    pub title: String,
    pub signup: String,
}

/// A tell this PC sent, waiting on the remote bot.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct OutJob {
    id: String,
    alias: String,
    to: String,
    /// The local bot that asked, woken by the answer. `None` when the user
    /// wrote in the remote chat or @mentioned the remote bot.
    asker: Option<String>,
    /// The chat a user's @mention was typed in. The answer is copied there
    /// for its next prompt, without waking it, like a local mention.
    #[serde(default)]
    owner: Option<String>,
    hops: u32,
    /// The reply being written, in the remote bot's transcript here.
    #[serde(default)]
    row: Option<String>,
    /// Replies already sealed. The words of a sealed reply can still come by
    /// as progress, after it, and must not open a second row.
    #[serde(default)]
    sealed: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum InState {
    Queued,
    Running,
    /// The representative handed the work to a local bot and waits on it.
    Waiting,
}

/// A tell a teammate sent to this PC's representative.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct InJob {
    id: String,
    alias: String,
    from: String,
    bot: String,
    state: InState,
    /// The representative ran `crew tell` to a local bot in this turn.
    #[serde(default)]
    told: bool,
    /// The tell's row in the representative's chat, while it waits in line.
    #[serde(default)]
    row: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
struct Jobs {
    #[serde(default)]
    out: Vec<OutJob>,
    #[serde(default, rename = "in")]
    inbound: Vec<InJob>,
    /// Frames written while a router was out of reach, per alias. Kept on
    /// disk: a restart before the router is back must not lose a tell.
    #[serde(default)]
    outbox: HashMap<String, Vec<Value>>,
    /// First-request cards still open, as `(bot, card id)`. Nobody waits on
    /// them after a restart, and the tell comes again with a new card.
    #[serde(default)]
    cards: Vec<(String, String)>,
}

struct Link {
    cfg: RemoteConfig,
    tx: Option<mpsc::UnboundedSender<Value>>,
    connected: bool,
    members: Vec<Member>,
    team: (String, u64),
    presence: String,
    /// The profile frame last sent on this connection. Cleared on welcome.
    profile: Option<Value>,
    /// Why this PC stopped trying, as the settings say it. Cleared on welcome.
    error: Option<String>,
}

#[derive(Default)]
struct State {
    links: HashMap<String, Link>,
    jobs: Jobs,
    /// Mailbox items already handled: a reconnect delivers the unacked again.
    seen: HashSet<(String, String)>,
    /// Tells from a teammate whose first one is waiting on the owner's answer.
    awaiting_trust: HashMap<(String, String), Vec<Value>>,
    team_waiters: HashMap<String, Vec<oneshot::Sender<Result<(), String>>>>,
    /// Renames waiting on their router, by frame id: the error code on refusal.
    rename_waiters: HashMap<String, oneshot::Sender<Result<(), String>>>,
    /// Tells the owner picked on a hand-on card: (representative, bot, text).
    /// They go through once without another card.
    picked: HashSet<(String, String, String)>,
}

fn state() -> &'static Mutex<State> {
    static STATE: OnceLock<Mutex<State>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(State::default()))
}

fn ko() -> bool {
    paths::locale() != "en"
}

fn say(ko_text: &str, en_text: &str) -> String {
    if ko() { ko_text } else { en_text }.to_string()
}

pub fn remotes_path() -> PathBuf {
    paths::home_dir().join("remotes.json")
}

fn jobs_path() -> PathBuf {
    paths::home_dir().join("remote-jobs.json")
}

fn team_memory_path(alias: &str) -> PathBuf {
    paths::home_dir()
        .join("team-memory")
        .join(format!("{}.md", paths::safe_agent_id(alias)))
}

/// Where a representative works unless its owner moves it.
pub fn work_dir(alias: &str) -> PathBuf {
    paths::home_dir()
        .join("remote-work")
        .join(paths::safe_agent_id(alias))
}

pub fn load_configs() -> Vec<RemoteConfig> {
    fs::read_to_string(remotes_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_configs(st: &State) {
    let mut list: Vec<&RemoteConfig> = st.links.values().map(|l| &l.cfg).collect();
    list.sort_by(|a, b| a.alias.cmp(&b.alias));
    let path = remotes_path();
    let Ok(text) = serde_json::to_string_pretty(&list) else {
        return;
    };
    if let Err(err) = write_private(&path, &(text + "\n")) {
        eprintln!("[crew] remote: could not save {}: {err:#}", path.display());
    }
}

/// The tokens are in it, so only the owner reads it.
fn write_private(path: &Path, text: &str) -> anyhow::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("tmp");
    {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)?;
        f.write_all(text.as_bytes())?;
    }
    fs::rename(&tmp, path)?;
    Ok(())
}

fn save_jobs(st: &State) {
    if let Ok(text) = serde_json::to_string(&st.jobs) {
        let _ = write_private(&jobs_path(), &text);
    }
}

// ---- ids ----

pub fn remote_id(alias: &str, account: &str) -> String {
    format!("{alias}/{account}")
}

/// `(alias, account)` of an id shaped like a remote bot's.
pub fn split_id(id: &str) -> Option<(&str, &str)> {
    let (alias, account) = id.split_once('/')?;
    if alias.is_empty() || account.is_empty() || account.contains('/') {
        return None;
    }
    Some((alias, account))
}

/// A bot on a router this PC is in. The router may not know it any more; the
/// tell then comes back as `no_such_member`.
pub fn is_remote(id: &str) -> bool {
    let Some((alias, _)) = split_id(id) else {
        return false;
    };
    state()
        .lock()
        .map(|st| st.links.contains_key(alias))
        .unwrap_or(false)
}

/// `team/acc_x`, or `team/이안` by name.
fn resolve(id: &str) -> Option<(String, String)> {
    let (alias, who) = split_id(id)?;
    let st = state().lock().ok()?;
    let link = st.links.get(alias)?;
    if who.starts_with("acc_") {
        return Some((alias.to_string(), who.to_string()));
    }
    let key = who.to_lowercase();
    link.members
        .iter()
        .find(|m| m.name.to_lowercase() == key)
        .map(|m| (alias.to_string(), m.account.clone()))
}

/// The router alias `bot` answers for, if it is a representative.
pub fn rep_alias(bot: &str) -> Option<String> {
    let st = state().lock().ok()?;
    st.links
        .values()
        .find(|l| l.cfg.bot == bot)
        .map(|l| l.cfg.alias.clone())
}

pub fn is_rep(bot: &str) -> bool {
    rep_alias(bot).is_some()
}

/// Every local bot that represents this PC on a router.
fn rep_bots() -> HashSet<String> {
    state()
        .lock()
        .map(|st| st.links.values().map(|l| l.cfg.bot.clone()).collect())
        .unwrap_or_default()
}

fn member_name(alias: &str, account: &str) -> String {
    state()
        .lock()
        .ok()
        .and_then(|st| {
            st.links
                .get(alias)?
                .members
                .iter()
                .find(|m| m.account == account)
                .map(|m| m.name.clone())
        })
        .unwrap_or_else(|| account.to_string())
}

// ---- urls ----

/// `wss://host:7420/ws` from what the user typed. A bare host gets `wss://`.
pub fn ws_url(input: &str) -> anyhow::Result<String> {
    let raw = input.trim();
    if raw.is_empty() {
        bail!("{}", say("주소를 넣어 주세요", "Enter an address"));
    }
    let (scheme, rest) = match raw.split_once("://") {
        Some(("https", rest)) => ("wss", rest),
        Some(("http", rest)) => ("ws", rest),
        Some((s @ ("ws" | "wss"), rest)) => (s, rest),
        Some((other, _)) => bail!(
            "{}",
            say(
                &format!("{other}:// 주소는 쓸 수 없어요"),
                &format!("{other}:// is not a router address")
            )
        ),
        None => ("wss", raw),
    };
    let rest = rest.trim_end_matches('/');
    if rest.is_empty() || rest.starts_with('/') {
        bail!("{}", say("주소가 비어 있어요", "The address has no host"));
    }
    if rest.contains('/') {
        Ok(format!("{scheme}://{rest}"))
    } else {
        Ok(format!("{scheme}://{rest}/ws"))
    }
}

fn connect_error(err: &tokio_tungstenite::tungstenite::Error) -> String {
    use tokio_tungstenite::tungstenite::Error as E;
    let text = err.to_string();
    let tls = matches!(err, E::Tls(_))
        || text.contains("tls")
        || text.contains("TLS")
        || text.contains("certificate")
        || text.contains("InvalidContentType");
    if tls {
        return say(
            &format!("보안 연결(TLS)을 열 수 없어요. 서버가 TLS를 쓰지 않으면 끄고 다시 시도해 주세요. ({text})"),
            &format!("Could not open a secure (TLS) connection. If the server has no TLS, turn it off and try again. ({text})"),
        );
    }
    say(
        &format!("라우터에 연결할 수 없어요: {text}"),
        &format!("Could not reach the router: {text}"),
    )
}

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// What this side takes in one message. Above the router's 32MB: the
/// library's default (16MB) refused a large attachment, dropped the socket,
/// and the router sent the same item again on every reconnect.
const RECEIVE_LIMIT: usize = 40 * 1024 * 1024;

async fn open(url: &str) -> anyhow::Result<Ws> {
    let url = ws_url(url)?;
    let config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default()
        .max_message_size(Some(RECEIVE_LIMIT))
        .max_frame_size(Some(RECEIVE_LIMIT));
    let connecting =
        tokio_tungstenite::connect_async_with_config(url.as_str(), Some(config), false);
    match tokio::time::timeout(PROBE_TIMEOUT, connecting).await {
        Err(_) => bail!(
            "{}",
            say("라우터가 응답하지 않아요", "The router did not answer")
        ),
        Ok(Err(err)) => bail!("{}", connect_error(&err)),
        Ok(Ok((ws, _))) => Ok(ws),
    }
}

async fn send_frame(ws: &mut Ws, v: &Value) -> anyhow::Result<()> {
    ws.send(WsMessage::Text(v.to_string().into())).await?;
    Ok(())
}

/// The next JSON frame, skipping pings and the like.
async fn next_frame(ws: &mut Ws) -> anyhow::Result<Value> {
    let read = async {
        while let Some(msg) = ws.next().await {
            match msg? {
                WsMessage::Text(t) => return Ok(serde_json::from_str::<Value>(&t)?),
                WsMessage::Close(_) => break,
                _ => {}
            }
        }
        bail!(
            "{}",
            say(
                "라우터가 연결을 닫았어요",
                "The router closed the connection"
            )
        )
    };
    match tokio::time::timeout(PROBE_TIMEOUT, read).await {
        Ok(v) => v,
        Err(_) => bail!(
            "{}",
            say("라우터가 응답하지 않아요", "The router did not answer")
        ),
    }
}

fn hello() -> Value {
    json!({"type": "hello", "protocol": PROTOCOL, "client": format!("crew {}", env!("CARGO_PKG_VERSION"))})
}

fn server_from(url: &str, v: &Value) -> anyhow::Result<RemoteServer> {
    if v["type"] != "server" {
        bail!(
            "{}",
            say(
                "crew-router가 아닌 서버예요",
                "That server is not a crew-router"
            )
        );
    }
    let protocol = v["protocol"].as_u64().unwrap_or(0) as u32;
    if protocol != PROTOCOL {
        bail!(
            "{}",
            say(
                &format!(
                    "라우터 프로토콜 버전이 맞지 않아요 (라우터 v{protocol}, Crew v{PROTOCOL})"
                ),
                &format!("Router protocol mismatch (router v{protocol}, Crew v{PROTOCOL})"),
            )
        );
    }
    Ok(RemoteServer {
        url: url.to_string(),
        name: v["name"].as_str().unwrap_or("crew-router").to_string(),
        version: v["version"].as_str().unwrap_or("").to_string(),
        protocol,
        title: v["title"].as_str().unwrap_or("").to_string(),
        signup: v["signup"].as_str().unwrap_or("open").to_string(),
    })
}

/// The health check behind 원격 봇 추가.
pub async fn probe(url: &str) -> anyhow::Result<RemoteServer> {
    let mut ws = open(url).await?;
    send_frame(&mut ws, &hello()).await?;
    let v = next_frame(&mut ws).await?;
    let _ = ws.close(None).await;
    server_from(url, &v)
}

fn signup_error(code: &str, message: &str) -> String {
    match code {
        "name_taken" => say("이름이 이미 있어요", "That name is taken"),
        "bad_name" => say(
            "이름은 1–32자의 글자·숫자·-·_만 쓸 수 있어요",
            "A name is 1–32 letters, digits, - or _",
        ),
        "invite_required" => say("초대 코드가 맞지 않아요", "The invite code is wrong"),
        "signup_closed" => say(
            "이 라우터는 가입을 받지 않아요",
            "This router takes no signups",
        ),
        _ if !message.is_empty() => message.to_string(),
        _ => code.to_string(),
    }
}

/// `(account, name, token)` for a new member.
async fn signup(
    url: &str,
    name: &str,
    invite: Option<&str>,
    profile: Value,
) -> anyhow::Result<(String, String, String)> {
    let mut ws = open(url).await?;
    send_frame(&mut ws, &hello()).await?;
    server_from(url, &next_frame(&mut ws).await?)?;
    send_frame(
        &mut ws,
        &json!({"type": "signup", "name": name, "invite": invite, "profile": profile}),
    )
    .await?;
    let v = next_frame(&mut ws).await?;
    let _ = ws.close(None).await;
    if v["type"] == "signed_up" {
        let field = |k: &str| v[k].as_str().unwrap_or("").to_string();
        let (account, name, token) = (field("account"), field("name"), field("token"));
        if account.is_empty() || token.is_empty() {
            bail!("router sent an empty account");
        }
        return Ok((account, name, token));
    }
    bail!(
        "{}",
        signup_error(
            v["code"].as_str().unwrap_or(""),
            v["message"].as_str().unwrap_or("")
        )
    )
}

/// Sign in once more and leave: the name is free from now.
async fn leave_router(url: &str, token: &str) -> anyhow::Result<()> {
    let mut ws = open(url).await?;
    send_frame(&mut ws, &json!({"type": "auth", "token": token})).await?;
    let v = next_frame(&mut ws).await?;
    if v["type"] != "welcome" {
        bail!("{}", v["message"].as_str().unwrap_or("sign-in refused"));
    }
    send_frame(&mut ws, &json!({"type": "leave"})).await?;
    let _ = ws.close(None).await;
    Ok(())
}

// ---- the links ----

/// Bring up every router in `remotes.json`. Called once, inside the runtime.
pub fn start() {
    let configs = load_configs();
    let jobs: Jobs = fs::read_to_string(jobs_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    // Cards from before a restart have nobody waiting on them. Answering one
    // would go to the bot as a message; the tell comes again with a new card.
    for (bot, card) in &jobs.cards {
        crate::transcript::resolve_choice(bot, card, &[], &[], &[], true);
    }
    let mut jobs = jobs;
    jobs.cards.clear();
    {
        let mut st = state().lock().expect("remote state");
        st.jobs = jobs;
        save_jobs(&st);
        for cfg in configs {
            let team = fs::read_to_string(team_memory_path(&cfg.alias)).unwrap_or_default();
            st.links.insert(cfg.alias.clone(), new_link(cfg, team));
        }
    }
    let aliases: Vec<String> = state()
        .lock()
        .map(|st| st.links.keys().cloned().collect())
        .unwrap_or_default();
    for alias in aliases {
        tokio::spawn(run_link(alias));
    }
    tokio::spawn(watch_events());
}

fn new_link(cfg: RemoteConfig, team: String) -> Link {
    Link {
        cfg,
        tx: None,
        connected: false,
        members: Vec::new(),
        team: (team, 0),
        presence: String::new(),
        profile: None,
        error: None,
    }
}

/// A connected router for tests elsewhere: what goes out to it lands in the
/// returned receiver. [`drop_test_link`] takes it away again.
#[cfg(test)]
pub(crate) fn test_link(alias: &str) -> mpsc::UnboundedReceiver<Value> {
    let (tx, rx) = mpsc::unbounded_channel();
    let mut link = new_link(
        RemoteConfig {
            alias: alias.into(),
            account: "acc_me0000000000".into(),
            ..RemoteConfig::default()
        },
        String::new(),
    );
    link.tx = Some(tx);
    link.connected = true;
    state().lock().unwrap().links.insert(alias.into(), link);
    rx
}

#[cfg(test)]
pub(crate) fn drop_test_link(alias: &str) {
    let mut st = state().lock().unwrap();
    st.links.remove(alias);
    st.jobs.out.retain(|job| job.alias != alias);
}

fn link_cfg(alias: &str) -> Option<RemoteConfig> {
    state().lock().ok()?.links.get(alias).map(|l| l.cfg.clone())
}

/// The router turned this PC away for good: retrying would only fight it.
#[derive(Debug)]
struct Halt(String);

impl std::fmt::Display for Halt {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "router refused: {}", self.0)
    }
}

impl std::error::Error for Halt {}

/// Codes after which this PC stops trying until Crew starts again.
fn halts(code: &str) -> bool {
    matches!(code, "replaced" | "bad_token" | "account_gone")
}

fn halt_text(code: &str) -> String {
    match code {
        "replaced" => say(
            "같은 계정이 다른 곳에서 접속해서 이 PC의 연결을 끊었어요. 이 PC에서 쓰려면 Crew를 다시 시작해 주세요.",
            "The same account signed in somewhere else, so this PC was disconnected. Restart Crew to use it here.",
        ),
        _ => say(
            "라우터에서 이 계정이 지워졌어요. 원격 봇을 다시 추가해 주세요.",
            "This account is gone from the router. Add the remote bot again.",
        ),
    }
}

async fn run_link(alias: String) {
    let mut backoff = 1u64;
    loop {
        let Some(cfg) = link_cfg(&alias) else {
            return;
        };
        let halted = match session(&cfg).await {
            Ok(()) => {
                backoff = 1;
                None
            }
            Err(err) => {
                eprintln!("[crew] remote {alias}: {err:#}");
                err.downcast_ref::<Halt>().map(|h| halt_text(&h.0))
            }
        };
        let gone = {
            let mut st = state().lock().expect("remote state");
            match st.links.get_mut(&alias) {
                Some(link) => {
                    link.connected = false;
                    link.tx = None;
                    if halted.is_some() {
                        link.error = halted.clone();
                    }
                    false
                }
                None => true,
            }
        };
        if gone || halted.is_some() {
            return;
        }
        tokio::time::sleep(Duration::from_secs(backoff)).await;
        backoff = (backoff * 2).min(30);
    }
}

async fn session(cfg: &RemoteConfig) -> anyhow::Result<()> {
    let ws = open(&cfg.url).await?;
    let (mut sink, mut stream) = ws.split();
    sink.send(WsMessage::Text(
        json!({"type": "auth", "token": cfg.token})
            .to_string()
            .into(),
    ))
    .await?;
    let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
    {
        let mut st = state().lock().expect("remote state");
        let Some(link) = st.links.get_mut(&cfg.alias) else {
            return Ok(());
        };
        // Only the link holds the sender: removing the router ends this loop.
        link.tx = Some(tx);
    }
    let mut ping = tokio::time::interval(Duration::from_secs(30));
    ping.tick().await;
    loop {
        tokio::select! {
            msg = stream.next() => {
                let Some(msg) = msg else { return Ok(()) };
                match msg? {
                    WsMessage::Text(t) => {
                        let v: Value = match serde_json::from_str(&t) {
                            Ok(v) => v,
                            Err(_) => continue,
                        };
                        if v["type"] == "error" && v["id"].is_null() {
                            let code = v["code"].as_str().unwrap_or("").to_string();
                            if halts(&code) {
                                return Err(Halt(code).into());
                            }
                            if !is_connected(&cfg.alias) {
                                bail!("sign-in refused: {code}");
                            }
                        }
                        handle_frame(&cfg.alias, v);
                    }
                    WsMessage::Close(_) => return Ok(()),
                    _ => {}
                }
            }
            out = rx.recv() => {
                let Some(v) = out else {
                    let _ = sink.close().await;
                    return Ok(());
                };
                sink.send(WsMessage::Text(v.to_string().into())).await?;
            }
            _ = ping.tick() => {
                sink.send(WsMessage::Text(json!({"type": "ping"}).to_string().into())).await?;
            }
        }
    }
}

fn is_connected(alias: &str) -> bool {
    state()
        .lock()
        .ok()
        .and_then(|st| st.links.get(alias).map(|l| l.connected))
        .unwrap_or(false)
}

/// To the router now, or once it is back. Progress is only worth it live.
fn send(alias: &str, frame: Value) {
    let Ok(mut st) = state().lock() else {
        return;
    };
    let Some(link) = st.links.get_mut(alias) else {
        return;
    };
    if link.connected {
        if let Some(tx) = &link.tx {
            if tx.send(frame.clone()).is_ok() {
                return;
            }
        }
    }
    if frame["type"] != "progress" {
        st.jobs.outbox.entry(alias.to_string()).or_default().push(frame);
        save_jobs(&st);
    }
}

fn ack(alias: &str, v: &Value) {
    if let Some(item) = item_of(v) {
        send(alias, json!({"type": "ack", "item": item}));
    }
}

fn item_of(v: &Value) -> Option<String> {
    match &v["item"] {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// A mailbox item seen before is acked again and not handled twice.
fn first_time(alias: &str, v: &Value) -> bool {
    let Some(item) = item_of(v) else {
        return true;
    };
    state()
        .lock()
        .map(|mut st| st.seen.insert((alias.to_string(), item)))
        .unwrap_or(true)
}

fn handle_frame(alias: &str, v: Value) {
    match v["type"].as_str().unwrap_or("") {
        "welcome" => on_welcome(alias, &v),
        "members" => {
            let members: Vec<Member> =
                serde_json::from_value(v["members"].clone()).unwrap_or_default();
            set_members(alias, members);
        }
        "member" => {
            if let Ok(m) = serde_json::from_value::<Member>(v["member"].clone()) {
                upsert_member(alias, m);
            }
        }
        "member_left" => {
            let account = v["account"].as_str().unwrap_or("").to_string();
            if let Ok(mut st) = state().lock() {
                if let Some(link) = st.links.get_mut(alias) {
                    link.members.retain(|m| m.account != account);
                }
            }
        }
        "tell" => {
            if first_time(alias, &v) {
                on_tell(alias, v);
            } else {
                ack(alias, &v);
            }
        }
        "progress" => on_progress(alias, &v),
        "reply" => {
            if first_time(alias, &v) {
                on_reply(alias, &v);
            }
            ack(alias, &v);
        }
        "done" => {
            if first_time(alias, &v) {
                on_done(alias, &v);
            }
            ack(alias, &v);
        }
        "cancel" => {
            if first_time(alias, &v) {
                on_cancel(alias, &v);
            }
            ack(alias, &v);
        }
        "accepted" => {}
        "team_memory" => on_team_memory(alias, &v),
        "renamed" => {
            resolve_rename(&v, Ok(()));
        }
        "error" => on_error(alias, &v),
        _ => {}
    }
}

fn on_welcome(alias: &str, v: &Value) {
    let members: Vec<Member> = serde_json::from_value(v["members"].clone()).unwrap_or_default();
    let pending = {
        let mut st = state().lock().expect("remote state");
        let Some(link) = st.links.get_mut(alias) else {
            return;
        };
        link.connected = true;
        link.presence.clear();
        link.profile = None;
        link.error = None;
        if let Some(name) = v["name"].as_str() {
            link.cfg.name = name.to_string();
        }
        let pending = st.jobs.outbox.remove(alias).unwrap_or_default();
        save_jobs(&st);
        pending
    };
    set_members(alias, members);
    on_team_memory(alias, &v["team_memory"]);
    if let Some(bot) = link_cfg(alias).map(|c| c.bot) {
        send_profile(alias, &bot);
        send_presence(alias, &bot);
    }
    for frame in pending {
        send(alias, frame);
    }
}

/// Sends the bot's profile unless this connection already has it. Offline,
/// the next welcome sends it.
fn send_profile(alias: &str, bot: &str) {
    let frame = profile_frame(bot);
    let changed = state()
        .lock()
        .ok()
        .and_then(|mut st| {
            let link = st.links.get_mut(alias)?;
            if !link.connected || link.profile.as_ref() == Some(&frame) {
                return Some(false);
            }
            link.profile = Some(frame.clone());
            Some(true)
        })
        .unwrap_or(false);
    if changed {
        send(alias, frame);
    }
}

/// The bot's avatar or role changed: the routers it stands in for hear it now,
/// so teammates' PCs and bots see it without a reconnect.
pub fn on_profile_changed(bot: &str) {
    let aliases: Vec<String> = state()
        .lock()
        .map(|st| {
            st.links
                .values()
                .filter(|l| l.cfg.bot == bot)
                .map(|l| l.cfg.alias.clone())
                .collect()
        })
        .unwrap_or_default();
    for alias in aliases {
        send_profile(&alias, bot);
    }
}

fn profile_frame(bot: &str) -> Value {
    let cfg = crate::daemon::agent_config(bot);
    let avatar = cfg
        .as_ref()
        .and_then(|c| crate::avatar::data_url_for(c.avatar.as_deref()))
        .filter(|a| a.len() <= AVATAR_LIMIT);
    json!({
        "type": "profile",
        "role": cfg.as_ref().and_then(|c| c.role.clone()),
        "avatar": avatar,
        "avatar_shape": cfg.as_ref().and_then(|c| c.avatar_shape),
        "avatar_color": cfg.as_ref().and_then(|c| c.avatar_color.clone()),
    })
}

fn set_members(alias: &str, members: Vec<Member>) {
    let ids: Vec<String> = members
        .iter()
        .map(|m| remote_id(alias, &m.account))
        .collect();
    if let Ok(mut st) = state().lock() {
        if let Some(link) = st.links.get_mut(alias) {
            link.members = members;
        }
    }
    for id in ids {
        ensure_transcript(&id);
    }
}

fn upsert_member(alias: &str, m: Member) {
    let id = remote_id(alias, &m.account);
    if let Ok(mut st) = state().lock() {
        if let Some(link) = st.links.get_mut(alias) {
            match link.members.iter_mut().find(|x| x.account == m.account) {
                Some(slot) => *slot = m,
                None => link.members.push(m),
            }
        }
    }
    ensure_transcript(&id);
}

fn ensure_transcript(id: &str) {
    static LOADED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    let first = LOADED
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .map(|mut s| s.insert(id.to_string()))
        .unwrap_or(false);
    if first {
        crate::transcript::load_agent(id);
    }
}

// ---- this PC sends ----

fn new_job_id() -> String {
    let mut bytes = [0u8; 12];
    let _ = getrandom_fill(&mut bytes);
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("t_{hex}")
}

/// No `rand` here: a hash of time, pid and a counter is unique enough for ids.
fn getrandom_fill(out: &mut [u8]) -> std::io::Result<()> {
    use std::io::Read;
    if let Ok(mut f) = fs::File::open("/dev/urandom") {
        return f.read_exact(out);
    }
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let seed = format!(
        "{:?}{}{}",
        std::time::SystemTime::now(),
        std::process::id(),
        n
    );
    let hash = Sha256::digest(seed.as_bytes());
    for (o, h) in out.iter_mut().zip(hash.iter()) {
        *o = *h;
    }
    Ok(())
}

/// Files in `text` that came in through Crew's own uploads. Anything else on
/// the disk stays here, even when a bot names its path.
fn attachments(text: &str) -> Vec<Value> {
    let uploads = paths::home_dir().join("uploads");
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for raw in text.split_whitespace() {
        let token = raw.trim_matches(|c: char| {
            matches!(
                c,
                '"' | '\'' | '`' | '(' | ')' | '[' | ']' | '<' | '>' | ','
            )
        });
        if !token.starts_with('/') || !seen.insert(token.to_string()) {
            continue;
        }
        let path = Path::new(token);
        let Ok(real) = path.canonicalize() else {
            continue;
        };
        let Ok(base) = uploads.canonicalize() else {
            continue;
        };
        if !real.starts_with(&base) {
            continue;
        }
        let Ok(meta) = fs::metadata(&real) else {
            continue;
        };
        if !meta.is_file() || meta.len() > FILE_LIMIT {
            continue;
        }
        let Ok(bytes) = fs::read(&real) else {
            continue;
        };
        let name = real
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "file".into());
        out.push(json!({
            "name": name,
            "size": bytes.len(),
            "sha256": hex(&Sha256::digest(&bytes)),
            "data": base64::engine::general_purpose::STANDARD.encode(&bytes),
        }));
    }
    out
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A local bot (or the user, as `asker: None`) asks a remote bot. The rows
/// land in the remote bot's chat here; the reply comes back as a handoff.
pub fn tell(
    asker: Option<&str>,
    owner: Option<&str>,
    to: &str,
    text: &str,
    hops: u32,
) -> anyhow::Result<String> {
    let Some((alias, account)) = resolve(to) else {
        bail!("unknown agent {to}");
    };
    if !is_connected(&alias) && link_cfg(&alias).is_none() {
        bail!("unknown agent {to}");
    }
    let files = attachments(text);
    if frame_len(text, &files) > FRAME_LIMIT {
        bail!(
            "{}",
            say(
                "첨부를 합쳐 30MB가 넘어서 보낼 수 없어요. 나눠서 보내 주세요.",
                "The attachments add up to over 30MB. Send them in parts."
            )
        );
    }
    let id = new_job_id();
    let rid = remote_id(&alias, &account);
    ensure_transcript(&rid);
    let job = OutJob {
        id: id.clone(),
        alias: alias.clone(),
        to: account.clone(),
        asker: asker.map(str::to_string),
        owner: owner.map(str::to_string),
        hops,
        row: None,
        sealed: Vec::new(),
    };
    {
        let mut st = state().lock().expect("remote state");
        st.jobs.out.push(job);
        save_jobs(&st);
    }
    let to_name = member_name(&alias, &account);
    send(
        &alias,
        json!({"type": "tell", "id": id, "to": to_name, "text": text, "hops": hops, "files": files}),
    );
    Ok(rid)
}

/// The user wrote in a remote bot's chat.
/// `row_id`: the id the window already drew the line under.
pub fn send_from_user(to: &str, text: &str, row_id: Option<&str>) -> anyhow::Result<()> {
    let Some((alias, account)) = resolve(to) else {
        bail!("unknown agent {to}");
    };
    let rid = remote_id(&alias, &account);
    ensure_transcript(&rid);
    let row = crate::transcript::push_user_as(&rid, "user", text, row_id);
    // Not sent, so not a line in the chat: the window puts the draft back.
    if let Err(err) = tell(None, None, &rid, text, 0) {
        crate::transcript::remove_row(&rid, &row.id);
        return Err(err);
    }
    Ok(())
}

/// The stop button in a remote bot's chat: take back what is still on its way.
pub fn cancel(to: &str) -> anyhow::Result<()> {
    let Some((alias, account)) = resolve(to) else {
        bail!("unknown agent {to}");
    };
    let ids: Vec<String> = state()
        .lock()
        .map(|st| {
            st.jobs
                .out
                .iter()
                .filter(|j| j.alias == alias && j.to == account)
                .map(|j| j.id.clone())
                .collect()
        })
        .unwrap_or_default();
    for id in ids {
        send(&alias, json!({"type": "cancel", "id": id}));
    }
    Ok(())
}

fn out_job(id: &str) -> Option<OutJob> {
    state()
        .lock()
        .ok()?
        .jobs
        .out
        .iter()
        .find(|j| j.id == id)
        .cloned()
}

/// `id`'s reply `text` is sealed: the next words open a new row.
fn seal_out(id: &str, text: &str) {
    if let Ok(mut st) = state().lock() {
        if let Some(j) = st.jobs.out.iter_mut().find(|j| j.id == id) {
            j.row = None;
            j.sealed.push(text.to_string());
        }
        save_jobs(&st);
    }
}

fn set_out_row(id: &str, row: Option<String>) {
    if let Ok(mut st) = state().lock() {
        if let Some(j) = st.jobs.out.iter_mut().find(|j| j.id == id) {
            j.row = row;
        }
        save_jobs(&st);
    }
}

fn on_progress(_alias: &str, v: &Value) {
    let Some(job) = v["id"].as_str().and_then(out_job) else {
        return;
    };
    let text = v["text"].as_str().unwrap_or("").trim();
    if text.is_empty() || job.sealed.iter().any(|s| s.trim() == text) {
        return;
    }
    let rid = remote_id(&job.alias, &job.to);
    match &job.row {
        Some(row) => crate::transcript::set_text(&rid, row, text),
        None => {
            let row = crate::transcript::push_remote_reply(&rid, &rid, text, job.asker.clone());
            set_out_row(&job.id, Some(row.id));
        }
    }
}

fn received_files(alias: &str, from: &str, v: &Value) -> Vec<PathBuf> {
    let Some(files) = v["files"].as_array() else {
        return Vec::new();
    };
    let dir = paths::home_dir()
        .join("uploads")
        .join("remote")
        .join(paths::safe_agent_id(alias))
        .join(paths::safe_agent_id(from));
    let mut out = Vec::new();
    for f in files {
        let name = f["name"].as_str().unwrap_or("file");
        let name = Path::new(name)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .filter(|n| !n.starts_with('.') && !n.is_empty())
            .unwrap_or_else(|| "file".into());
        let Some(bytes) = f["data"]
            .as_str()
            .and_then(|d| base64::engine::general_purpose::STANDARD.decode(d).ok())
        else {
            continue;
        };
        if bytes.len() as u64 > FILE_LIMIT {
            continue;
        }
        if let Some(sum) = f["sha256"].as_str() {
            if !sum.eq_ignore_ascii_case(&hex(&Sha256::digest(&bytes))) {
                eprintln!("[crew] remote {alias}: dropped {name}, checksum mismatch");
                continue;
            }
        }
        if fs::create_dir_all(&dir).is_err() {
            continue;
        }
        let mut path = dir.join(&name);
        let mut n = 1;
        while path.exists() {
            path = dir.join(format!("{n}-{name}"));
            n += 1;
        }
        if fs::write(&path, &bytes).is_ok() {
            out.push(path);
        }
    }
    out
}

fn with_files(text: &str, files: &[PathBuf]) -> String {
    if files.is_empty() {
        return text.to_string();
    }
    let mut s = text.trim_end().to_string();
    s.push_str("\n\n");
    for f in files {
        s.push_str(&format!("[{}] {}\n", say("첨부", "attached"), f.display()));
    }
    s
}

fn on_reply(alias: &str, v: &Value) {
    let Some(job) = v["id"].as_str().and_then(out_job) else {
        return;
    };
    let rid = remote_id(&job.alias, &job.to);
    let files = received_files(alias, &job.to, v);
    let text = with_files(v["text"].as_str().unwrap_or(""), &files);
    if text.trim().is_empty() {
        return;
    }
    match &job.row {
        Some(row) => crate::transcript::set_text(&rid, row, &text),
        None => {
            crate::transcript::push_remote_reply(&rid, &rid, &text, job.asker.clone());
        }
    }
    seal_out(&job.id, v["text"].as_str().unwrap_or(""));
    if let Some(chat) = job.asker.as_ref().or(job.owner.as_ref()) {
        crate::daemon::remote_reply(chat, &rid, &text);
    }
}

fn done_text(error: &str) -> String {
    match error {
        "stopped" => say("상대가 이 일을 멈췄어요.", "They stopped this work."),
        "unresponsive" => say(
            "상대 PC의 CLI가 응답하지 않아 이 일을 끝내지 못했어요.",
            "Their CLI did not respond, so this work did not finish.",
        ),
        "expired" => say(
            "상대가 30일 동안 접속하지 않아 라우터가 이 요청을 지웠어요.",
            "They did not come online in time, so the router dropped this request.",
        ),
        "relay_limit" => say(
            "봇끼리 주고받은 횟수가 한도를 넘어 멈췄어요. 사람이 다시 보내 주세요.",
            "Bots passed this along too many times. Send it again yourself.",
        ),
        "denied" => say(
            "상대가 이 요청을 받지 않았어요.",
            "They did not take this request.",
        ),
        "recipient_gone" => say(
            "받는 봇이 라우터에서 사라졌어요.",
            "That bot left the router.",
        ),
        "cancelled" => say("요청을 취소했어요.", "The request was cancelled."),
        "no_such_member" => say("라우터에 그런 봇이 없어요.", "The router has no such bot."),
        "rate_limited" => say(
            "보낸 요청이 너무 많아요. 잠시 뒤에 다시 보내 주세요.",
            "Too many requests. Try again in a moment.",
        ),
        "too_large" => say(
            "첨부가 너무 커요 (파일당 25MB).",
            "An attachment is too large (25MB per file).",
        ),
        _ => say(
            "원격 봇이 일을 마치지 못했어요.",
            "The remote bot could not finish.",
        ),
    }
}

fn on_done(_alias: &str, v: &Value) {
    let Some(id) = v["id"].as_str() else {
        return;
    };
    finish_out(
        id,
        v["ok"].as_bool().unwrap_or(true),
        v["error"].as_str().unwrap_or(""),
    );
}

fn finish_out(id: &str, ok: bool, error: &str) {
    let job = {
        let Ok(mut st) = state().lock() else {
            return;
        };
        let Some(at) = st.jobs.out.iter().position(|j| j.id == id) else {
            return;
        };
        let job = st.jobs.out.remove(at);
        save_jobs(&st);
        job
    };
    let rid = remote_id(&job.alias, &job.to);
    if !ok {
        let text = done_text(error);
        crate::transcript::push_crew_note(&rid, &text);
        if let Some(chat) = job.asker.as_ref().or(job.owner.as_ref()) {
            crate::daemon::remote_reply(chat, &rid, &text);
        }
    }
    if let Some(asker) = &job.asker {
        crate::daemon::remote_wake(asker, &rid, job.hops);
    }
}

fn on_error(alias: &str, v: &Value) {
    let code = v["code"].as_str().unwrap_or("");
    if code == "version_conflict" {
        resolve_team_waiters(alias, Err("conflict".into()));
        return;
    }
    if resolve_rename(v, Err(code.to_string())) {
        return;
    }
    if let Some(id) = v["id"].as_str() {
        if out_job(id).is_some() {
            finish_out(id, false, code);
            return;
        }
    }
    eprintln!(
        "[crew] remote {alias}: {code} {}",
        v["message"].as_str().unwrap_or("")
    );
}

// ---- this PC receives ----

fn on_tell(alias: &str, v: Value) {
    let Some(cfg) = link_cfg(alias) else {
        return;
    };
    let from = v["from"].as_str().unwrap_or("").to_string();
    let id = v["id"].as_str().unwrap_or("").to_string();
    if from.is_empty() || id.is_empty() {
        ack(alias, &v);
        return;
    }
    if cfg.blocked.iter().any(|p| p.account == from) {
        send(
            alias,
            json!({"type": "done", "id": id, "ok": false, "error": "denied"}),
        );
        ack(alias, &v);
        return;
    }
    if cfg.trusted.iter().any(|p| p.account == from) {
        accept(alias, &cfg.bot, v);
        return;
    }
    let key = (alias.to_string(), from.clone());
    let first = {
        let mut st = state().lock().expect("remote state");
        let waiting = st.awaiting_trust.entry(key.clone()).or_default();
        waiting.push(v.clone());
        waiting.len() == 1
    };
    if first {
        send(
            alias,
            json!({"type": "progress", "id": id, "state": "waiting_owner"}),
        );
        tokio::spawn(ask_trust(alias.to_string(), cfg.bot.clone(), v));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Trust {
    Always,
    Once,
    Deny,
    Block,
}

const TRUST_ALWAYS: &str = "허용";
const TRUST_ONCE: &str = "이번만";
const TRUST_DENY: &str = "거절";
const TRUST_BLOCK: &str = "차단";

fn trust_options() -> [String; 4] {
    if ko() {
        [
            format!("{TRUST_ALWAYS} — 앞으로 이 팀원의 요청은 바로 실행"),
            format!("{TRUST_ONCE} — 이 요청만 실행"),
            TRUST_DENY.to_string(),
            format!("{TRUST_BLOCK} — 앞으로 이 팀원의 요청은 모두 거절"),
        ]
    } else {
        [
            "Allow — run this teammate's requests from now on".into(),
            "Just this once".into(),
            "Decline".into(),
            "Block — decline everything from this teammate".into(),
        ]
    }
}

/// The owner's pick on the first-request card. Anything else is a no.
fn parse_trust(answer: &str) -> Trust {
    let a = answer.trim();
    let picked = |ko_word: &str, en_word: &str| a.contains(ko_word) || a.starts_with(en_word);
    if picked(TRUST_BLOCK, "Block") {
        Trust::Block
    } else if picked(TRUST_ONCE, "Just this once") {
        Trust::Once
    } else if picked(TRUST_DENY, "Decline") {
        Trust::Deny
    } else if picked(TRUST_ALWAYS, "Allow") {
        Trust::Always
    } else {
        Trust::Deny
    }
}

fn preview(text: &str) -> String {
    let one: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let cut: String = one.chars().take(160).collect();
    if cut.chars().count() < one.chars().count() {
        format!("{cut}…")
    } else {
        cut
    }
}

async fn ask_trust(alias: String, bot: String, v: Value) {
    let from = v["from"].as_str().unwrap_or("").to_string();
    let name = v["from_name"].as_str().unwrap_or(&from).to_string();
    let question = if ko() {
        format!(
            "{name}님({alias})이 이 대표 봇에게 일을 맡기려 해요. 받아들이면 그 메시지가 이 PC에서 셸 권한으로 실행돼요."
        )
    } else {
        format!(
            "{name} ({alias}) wants this representative to take on work. Their messages would run on this PC with shell access."
        )
    };
    let ask = AskQuestion {
        question,
        options: trust_options().to_vec(),
        inputs: Vec::new(),
        hint: Some(preview(v["text"].as_str().unwrap_or(""))),
        multi: false,
    };
    let answer = match crate::daemon::open_ask(&bot, &[ask]) {
        Ok((card, rx)) => {
            let key = (bot.clone(), card);
            if let Ok(mut st) = state().lock() {
                st.jobs.cards.push(key.clone());
                save_jobs(&st);
            }
            let answer = match rx.await {
                Ok(Event::Answered { text }) => parse_trust(&text),
                _ => Trust::Deny,
            };
            if let Ok(mut st) = state().lock() {
                st.jobs.cards.retain(|c| c != &key);
                save_jobs(&st);
            }
            answer
        }
        Err(err) => {
            eprintln!("[crew] remote {alias}: could not ask about {name}: {err:#}");
            Trust::Deny
        }
    };
    let waiting = state()
        .lock()
        .ok()
        .and_then(|mut st| st.awaiting_trust.remove(&(alias.clone(), from.clone())))
        .unwrap_or_default();
    let peer = Peer {
        account: from.clone(),
        name: name.clone(),
    };
    match answer {
        Trust::Always => update_cfg(&alias, |c| {
            c.blocked.retain(|p| p.account != from);
            if !c.trusted.iter().any(|p| p.account == from) {
                c.trusted.push(peer.clone());
            }
        }),
        Trust::Block => update_cfg(&alias, |c| {
            c.trusted.retain(|p| p.account != from);
            if !c.blocked.iter().any(|p| p.account == from) {
                c.blocked.push(peer.clone());
            }
        }),
        Trust::Once | Trust::Deny => {}
    }
    for frame in waiting {
        if matches!(answer, Trust::Always | Trust::Once) {
            accept(&alias, &bot, frame);
        } else {
            let id = frame["id"].as_str().unwrap_or("");
            send(
                &alias,
                json!({"type": "done", "id": id, "ok": false, "error": "denied"}),
            );
            ack(&alias, &frame);
        }
    }
}

// ---- handing a teammate's work to a local bot ----

const KEEP_IT: &str = "맡기지 않기";
const MAX_CANDIDATES: usize = 4;

/// A representative's `crew tell` to a local bot outside its folder, made in a
/// teammate's job. Crew holds it and asks the owner which bot takes the work;
/// `true` means it is held. A tell to its folder's bots goes straight on.
pub fn hold_local_tell(
    rep: &str,
    to: &str,
    text: &str,
    origin: Option<TurnOrigin>,
    roster: &[AgentConfig],
) -> bool {
    if to == rep || split_id(to).is_some() || !is_rep(rep) || is_rep(to) {
        return false;
    }
    {
        let Ok(mut st) = state().lock() else {
            return false;
        };
        if st
            .picked
            .remove(&(rep.to_string(), to.to_string(), text.to_string()))
        {
            return false;
        }
        // The owner talking to it, or a routine, is not a teammate's job.
        if current_in(&mut st, rep, origin.as_ref()).is_none() {
            return false;
        }
    }
    if rep_folder(rep).is_some_and(|f| in_folder(&f, to)) {
        return false;
    }
    let Ok(rt) = tokio::runtime::Handle::try_current() else {
        return false;
    };
    // The job waits for the work to come back, as for any tell of its own.
    on_local_tell(rep, origin.as_ref());
    let name = roster
        .iter()
        .find(|a| a.id == rep)
        .map(|a| a.display_name().to_string())
        .unwrap_or_else(|| rep.to_string());
    let candidates = hand_on_candidates(rep, to, text, roster);
    let reps = rep_bots();
    let others: Vec<(String, String)> = roster
        .iter()
        .filter(|a| a.id != rep && !reps.contains(&a.id) && split_id(&a.id).is_none())
        .map(|a| (a.id.clone(), a.display_name().to_string()))
        .collect();
    rt.spawn(ask_hand_on(rep.to_string(), name, text.to_string(), origin, candidates, others));
    true
}

/// Who the card offers, as (id, label): the bot the representative named
/// first, then bots the work @mentions, then bots whose name, id or role the
/// work spells out. Never a representative, never a bot on another PC.
fn hand_on_candidates(
    rep: &str,
    to: &str,
    text: &str,
    roster: &[AgentConfig],
) -> Vec<(String, String)> {
    let reps = rep_bots();
    let pool: Vec<&AgentConfig> = roster
        .iter()
        .filter(|a| a.id != rep && !reps.contains(&a.id) && split_id(&a.id).is_none())
        .collect();
    let lower = text.to_lowercase();
    let spelled = |word: &str| {
        let w = word.trim().to_lowercase();
        w.chars().count() >= 2 && lower.contains(&w)
    };
    let mentioned: Vec<String> = crate::config::mention_tokens(text)
        .into_iter()
        .map(|t| t.to_lowercase())
        .collect();
    let mut ids: Vec<String> = Vec::new();
    let mut add = |id: &str| {
        if ids.len() < MAX_CANDIDATES && !ids.iter().any(|i| i == id) {
            ids.push(id.to_string());
        }
    };
    if let Some(a) = pool.iter().find(|a| a.id == to) {
        add(&a.id);
    }
    for a in &pool {
        if mentioned.contains(&a.id.to_lowercase()) {
            add(&a.id);
        }
    }
    for a in &pool {
        let role = a.role.as_deref().unwrap_or("");
        if spelled(a.display_name())
            || spelled(&a.id)
            || role.split(|c: char| c.is_whitespace() || c == ',' || c == '·').any(spelled)
        {
            add(&a.id);
        }
    }
    let name = |id: &str| {
        pool.iter()
            .find(|a| a.id == id)
            .map(|a| a.display_name().to_string())
            .unwrap_or_else(|| id.to_string())
    };
    ids.iter()
        .map(|id| {
            let n = name(id);
            let twin = ids.iter().any(|o| o != id && name(o) == n);
            let label = if twin { format!("{n} · {id}") } else { n };
            (id.clone(), label)
        })
        .collect()
}

/// The bot the owner picked on the card, or `None` to keep the work. The
/// answer reads `question → pick`; a typed name may pick a bot the card did
/// not offer, from `others`.
fn picked_bot(
    answer: &str,
    candidates: &[(String, String)],
    others: &[(String, String)],
) -> Option<String> {
    let a = answer.rsplit(" → ").next().unwrap_or("").trim();
    if a.is_empty() || a.contains(KEEP_IT) || a.starts_with("Keep it") {
        return None;
    }
    // The longest label first, so `리뷰어 2` is not read as `리뷰어`.
    let mut by_len: Vec<&(String, String)> = candidates.iter().collect();
    by_len.sort_by_key(|(_, label)| std::cmp::Reverse(label.chars().count()));
    by_len
        .into_iter()
        .find(|(_, label)| a == label || a.contains(label.as_str()))
        .or_else(|| {
            others
                .iter()
                .find(|(id, label)| a.eq_ignore_ascii_case(id) || a == label)
        })
        .map(|(id, _)| id.clone())
}

async fn ask_hand_on(
    rep: String,
    name: String,
    text: String,
    origin: Option<TurnOrigin>,
    candidates: Vec<(String, String)>,
    others: Vec<(String, String)>,
) {
    let question = if ko() {
        format!("{name}이(가) 팀원이 맡긴 일을 이 PC의 봇에게 넘기려 해요. 어느 봇에게 맡길까요?")
    } else {
        format!("{name} wants to hand a teammate's work to a bot on this PC. Which bot takes it?")
    };
    let mut options: Vec<String> = candidates.iter().map(|(_, label)| label.clone()).collect();
    options.push(say(KEEP_IT, "Keep it — answer the teammate itself"));
    let ask = AskQuestion {
        question,
        options,
        inputs: Vec::new(),
        hint: Some(preview(&text)),
        multi: false,
    };
    let picked = match crate::daemon::open_ask(&rep, &[ask]) {
        Ok((card, rx)) => {
            let key = (rep.clone(), card);
            if let Ok(mut st) = state().lock() {
                st.jobs.cards.push(key.clone());
                save_jobs(&st);
            }
            let answer = match rx.await {
                Ok(Event::Answered { text }) => picked_bot(&text, &candidates, &others),
                _ => None,
            };
            if let Ok(mut st) = state().lock() {
                st.jobs.cards.retain(|c| c != &key);
                save_jobs(&st);
            }
            answer
        }
        Err(err) => {
            eprintln!("[crew] remote: could not ask who takes {rep}'s work: {err:#}");
            None
        }
    };
    let sent = picked.and_then(|to| {
        if let Ok(mut st) = state().lock() {
            st.picked.insert((rep.clone(), to.clone(), text.clone()));
        }
        match crate::daemon::tell_as(&rep, &to, &text, origin) {
            Ok(()) => Some(()),
            Err(err) => {
                eprintln!("[crew] remote: could not hand {rep}'s work to {to}: {err:#}");
                if let Ok(mut st) = state().lock() {
                    st.picked.remove(&(rep.clone(), to, text.clone()));
                }
                None
            }
        }
    });
    if sent.is_none() {
        let note = say(
            "주인이 이 일을 다른 봇에게 맡기지 않기로 했어요. 직접 처리해서 팀원에게 답하세요.",
            "Your owner chose not to hand this work to another bot. Do it yourself and answer the teammate.",
        );
        if let Err(err) = crate::daemon::wake_from_crew(&rep, &note) {
            eprintln!("[crew] remote: could not wake {rep}: {err:#}");
        }
    }
}

fn update_cfg(alias: &str, f: impl FnOnce(&mut RemoteConfig)) {
    if let Ok(mut st) = state().lock() {
        if let Some(link) = st.links.get_mut(alias) {
            f(&mut link.cfg);
        }
        save_configs(&st);
    }
}

/// Into the representative's turn, like a tell from a local bot.
fn accept(alias: &str, bot: &str, v: Value) {
    let from = v["from"].as_str().unwrap_or("").to_string();
    let id = v["id"].as_str().unwrap_or("").to_string();
    let hops = v["hops"].as_u64().unwrap_or(0) as u32;
    let rid = remote_id(alias, &from);
    ensure_transcript(&rid);
    let files = received_files(alias, &from, &v);
    let text = with_files(v["text"].as_str().unwrap_or(""), &files);
    {
        let mut st = state().lock().expect("remote state");
        st.jobs.inbound.push(InJob {
            id: id.clone(),
            alias: alias.to_string(),
            from: from.clone(),
            bot: bot.to_string(),
            state: InState::Queued,
            told: false,
            row: None,
        });
        save_jobs(&st);
    }
    match crate::daemon::remote_deliver(bot, &rid, &text, hops) {
        Ok(row) => {
            if let Ok(mut st) = state().lock() {
                if let Some(j) = st.jobs.inbound.iter_mut().find(|j| j.id == id) {
                    j.row = Some(row);
                }
                save_jobs(&st);
            }
            send(
                alias,
                json!({"type": "progress", "id": id, "state": "started"}),
            )
        }
        Err(err) => {
            eprintln!("[crew] remote {alias}: could not start {bot}: {err:#}");
            drop_in(&id);
            let error = if format!("{err:#}").contains("relay limit") {
                "relay_limit"
            } else {
                "failed"
            };
            send(
                alias,
                json!({"type": "done", "id": id, "ok": false, "error": error}),
            );
        }
    }
    ack(alias, &v);
}

fn drop_in(id: &str) {
    if let Ok(mut st) = state().lock() {
        st.jobs.inbound.retain(|j| j.id != id);
        save_jobs(&st);
    }
}

/// The job `bot`'s turn works on: the tell that started it, or the one it
/// went back to after a local bot it asked answered.
fn current_in(st: &mut State, bot: &str, origin: Option<&TurnOrigin>) -> Option<usize> {
    let origin = origin?;
    let from = origin.from.as_str();
    let at = match split_id(from) {
        // A tell from a teammate names them as the one to answer. The wake
        // with a teammate's answer to a tell of ours does not: that turn is
        // not their job, even when they also asked us something.
        Some((alias, account)) if origin.reply_agent.as_deref() == Some(from) => {
            st.jobs.inbound.iter().position(|j| {
                j.bot == bot
                    && j.alias == alias
                    && j.from == account
                    && j.state != InState::Waiting
            })
        }
        Some(_) => None,
        // Only a local bot's answer picks a waiting job back up. The owner
        // talking to the representative, or a routine, is not that job.
        // The job this wake already picked up comes first; it is Running
        // once a word of the turn went out.
        None if woken_by_local_bot(origin) => {
            let mine = |state| {
                st.jobs
                    .inbound
                    .iter()
                    .position(|j| j.bot == bot && j.state == state)
            };
            mine(InState::Running).or_else(|| mine(InState::Waiting))
        }
        None => None,
    }?;
    st.jobs.inbound[at].state = InState::Running;
    Some(at)
}

/// The teammate whose job a local bot's answer picks back up, as `current_in`
/// will. Nobody asked that turn in so many words, but its reply is theirs, so
/// it belongs in their side chat.
pub fn waking_job_peer(bot: &str, origin: &TurnOrigin) -> Option<String> {
    if !woken_by_local_bot(origin) {
        return None;
    }
    let st = state().lock().ok()?;
    let mine = |state| {
        st.jobs
            .inbound
            .iter()
            .find(|j| j.bot == bot && j.state == state)
    };
    let job = mine(InState::Running).or_else(|| mine(InState::Waiting))?;
    Some(remote_id(&job.alias, &job.from))
}

fn woken_by_local_bot(origin: &TurnOrigin) -> bool {
    !origin.from.is_empty()
        && origin.from != "user"
        && origin.routine.is_none()
        && origin.reply_agent.is_none()
}

/// A sealed reply of the representative goes back to whoever asked.
pub fn on_sealed(bot: &str, text: &str, origin: Option<&TurnOrigin>) {
    if text.trim().is_empty() {
        return;
    }
    let target = {
        let Ok(mut st) = state().lock() else {
            return;
        };
        let Some(at) = current_in(&mut st, bot, origin) else {
            return;
        };
        let j = &st.jobs.inbound[at];
        (j.alias.clone(), j.id.clone())
    };
    let mut files = attachments(text);
    let mut text = text.to_string();
    if frame_len(&text, &files) > FRAME_LIMIT {
        files.clear();
        text.push_str(&say(
            "\n\n(첨부가 합쳐 30MB를 넘어서 빼고 보냈어요.)",
            "\n\n(The attachments were over 30MB together, so they were left out.)",
        ));
    }
    send(
        &target.0,
        json!({"type": "reply", "id": target.1, "text": text, "files": files}),
    );
}

/// About how long a frame with `text` and `files` is on the wire.
fn frame_len(text: &str, files: &[Value]) -> usize {
    text.len()
        + files
            .iter()
            .map(|f| f["data"].as_str().map_or(0, str::len) + 256)
            .sum::<usize>()
}

/// The representative ran `crew tell` to a local bot during a remote job: the
/// job waits for that answer instead of ending with this turn.
pub fn on_local_tell(bot: &str, origin: Option<&TurnOrigin>) {
    if let Ok(mut st) = state().lock() {
        if let Some(at) = current_in(&mut st, bot, origin) {
            st.jobs.inbound[at].told = true;
            save_jobs(&st);
        }
    }
}

/// `bot`'s turn is over. Its job ends, unless it is waiting on a local bot.
pub fn turn_over(bot: &str, origin: Option<&TurnOrigin>) {
    // Decided under the lock, sent after it: `send` takes the lock too.
    let frame = {
        let Ok(mut st) = state().lock() else {
            return;
        };
        let Some(at) = current_in(&mut st, bot, origin) else {
            return;
        };
        let job = &mut st.jobs.inbound[at];
        let frame = if job.told {
            job.told = false;
            job.state = InState::Waiting;
            let frame = (
                job.alias.clone(),
                json!({"type": "progress", "id": job.id, "state": "working"}),
            );
            frame
        } else {
            let job = st.jobs.inbound.remove(at);
            (job.alias, json!({"type": "done", "id": job.id, "ok": true}))
        };
        save_jobs(&st);
        frame
    };
    send(&frame.0, frame.1);
}

fn on_cancel(alias: &str, v: &Value) {
    let Some(id) = v["id"].as_str() else {
        return;
    };
    let job = state().lock().ok().and_then(|st| {
        st.jobs
            .inbound
            .iter()
            .find(|j| j.alias == alias && j.id == id)
            .cloned()
    });
    let Some(job) = job else {
        return;
    };
    // Still in line: only that line goes. A turn already on it is stopped.
    // Anyone else's turn, running ahead of it, is left alone.
    let queued = job
        .row
        .as_deref()
        .is_some_and(|row| crate::daemon::cancel_waiting(&job.bot, row));
    let on_it = !queued && is_current(&job);
    drop_in(id);
    if on_it {
        let _ = crate::daemon::stop_turn(&job.bot);
    }
    send(
        alias,
        json!({"type": "done", "id": id, "ok": false, "error": "cancelled"}),
    );
}

/// `job` is what its representative's turn is on right now.
fn is_current(job: &InJob) -> bool {
    if job.state == InState::Waiting {
        return false;
    }
    let origin = crate::daemon::turn_origin(&job.bot);
    let Some(origin) = origin.filter(|_| {
        matches!(
            crate::daemon::agent_status(&job.bot),
            Some(AgentStatus::Working | AgentStatus::Blocked)
        )
    }) else {
        return false;
    };
    let Ok(mut st) = state().lock() else {
        return false;
    };
    current_in(&mut st, &job.bot, Some(&origin)).is_some_and(|at| st.jobs.inbound[at].id == job.id)
}

/// `bot`'s turn ended without an answer (`error`: stopped, failed,
/// unresponsive): the teammate it was for hears so. `true` when the turn was
/// one of theirs.
pub fn end_job(bot: &str, origin: Option<&TurnOrigin>, error: &str) -> bool {
    let job = {
        let Ok(mut st) = state().lock() else {
            return false;
        };
        let Some(at) = current_in(&mut st, bot, origin) else {
            return false;
        };
        let job = st.jobs.inbound.remove(at);
        save_jobs(&st);
        job
    };
    send(
        &job.alias,
        json!({"type": "done", "id": job.id, "ok": false, "error": error}),
    );
    true
}

/// Live words and the representative's state, as the router's teammates see them.
async fn watch_events() {
    let mut rx = crate::daemon::events().subscribe();
    loop {
        let ev = match rx.recv().await {
            Ok(ev) => ev,
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
            Err(_) => return,
        };
        match ev {
            Event::Message { agent, message } => {
                if message.role != crate::protocol::Role::Assistant || !is_rep(&agent) {
                    continue;
                }
                let origin = crate::daemon::turn_origin(&agent);
                let target = state().lock().ok().and_then(|mut st| {
                    let at = current_in(&mut st, &agent, origin.as_ref())?;
                    let j = &st.jobs.inbound[at];
                    Some((j.alias.clone(), j.id.clone()))
                });
                if let Some((alias, id)) = target {
                    let text = crate::rows::display_text(&message);
                    send(
                        &alias,
                        json!({"type": "progress", "id": id, "state": "working", "text": text}),
                    );
                }
            }
            Event::Frame { agent, .. } => {
                if let Some(alias) = rep_alias(&agent) {
                    send_presence(&alias, &agent);
                }
            }
            _ => {}
        }
    }
}

fn send_presence(alias: &str, bot: &str) {
    let status = if crate::transcript::has_pending_choice(bot) {
        "asking"
    } else if matches!(
        crate::daemon::agent_status(bot),
        Some(AgentStatus::Working | AgentStatus::Blocked)
    ) {
        "working"
    } else {
        "idle"
    };
    let changed = state()
        .lock()
        .ok()
        .and_then(|mut st| {
            let link = st.links.get_mut(alias)?;
            if !link.connected || link.presence == status {
                return Some(false);
            }
            link.presence = status.to_string();
            Some(true)
        })
        .unwrap_or(false);
    if changed {
        send(alias, json!({"type": "presence", "status": status}));
    }
}

// ---- team memory ----

fn on_team_memory(alias: &str, v: &Value) {
    if !v.is_object() {
        return;
    }
    let text = v["text"].as_str().unwrap_or("").to_string();
    let version = v["version"].as_u64().unwrap_or(0);
    if let Ok(mut st) = state().lock() {
        if let Some(link) = st.links.get_mut(alias) {
            link.team = (text.clone(), version);
        }
    }
    let path = team_memory_path(alias);
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let _ = fs::write(&path, &text);
    resolve_team_waiters(alias, Ok(()));
}

fn resolve_team_waiters(alias: &str, result: Result<(), String>) {
    let waiters = state()
        .lock()
        .ok()
        .and_then(|mut st| st.team_waiters.remove(alias))
        .unwrap_or_default();
    for w in waiters {
        let _ = w.send(result.clone());
    }
}

pub fn team_memory(alias: &str) -> Option<(String, u64)> {
    state()
        .lock()
        .ok()?
        .links
        .get(alias)
        .map(|l| l.team.clone())
}

/// `true` once the router took it, `false` when someone changed it first.
async fn change_team_memory(alias: &str, frame: Value) -> anyhow::Result<bool> {
    if !is_connected(alias) {
        bail!(
            "{}",
            say(
                "라우터에 연결되어 있지 않아요",
                "Not connected to the router"
            )
        );
    }
    let (tx, rx) = oneshot::channel();
    if let Ok(mut st) = state().lock() {
        st.team_waiters
            .entry(alias.to_string())
            .or_default()
            .push(tx);
    }
    send(alias, frame);
    match tokio::time::timeout(PROBE_TIMEOUT, rx).await {
        Ok(Ok(Ok(()))) => Ok(true),
        Ok(Ok(Err(_))) => Ok(false),
        _ => bail!(
            "{}",
            say("라우터가 응답하지 않아요", "The router did not answer")
        ),
    }
}

fn resolve_rename(v: &Value, result: Result<(), String>) -> bool {
    let waiter = v["id"]
        .as_str()
        .and_then(|id| state().lock().ok()?.rename_waiters.remove(id));
    match waiter {
        Some(tx) => {
            let _ = tx.send(result);
            true
        }
        None => false,
    }
}

/// Asks one router to give this PC's account `name`.
async fn rename_on(alias: &str, name: &str) -> Result<(), String> {
    if !is_connected(alias) {
        return Err(say(
            &format!("{alias} 라우터에 연결되어 있지 않아서 이름을 바꿀 수 없어요"),
            &format!("Not connected to {alias}, so the name cannot change"),
        ));
    }
    let id = new_job_id();
    let (tx, rx) = oneshot::channel();
    if let Ok(mut st) = state().lock() {
        st.rename_waiters.insert(id.clone(), tx);
    }
    send(alias, json!({"type": "rename", "id": id, "name": name}));
    let result = tokio::time::timeout(PROBE_TIMEOUT, rx).await;
    if let Ok(mut st) = state().lock() {
        st.rename_waiters.remove(&id);
    }
    let code = match result {
        Ok(Ok(Ok(()))) => return Ok(()),
        Ok(Ok(Err(code))) => code,
        _ => String::new(),
    };
    Err(match code.as_str() {
        "name_taken" => say(
            &format!("{alias} 라우터에 이미 {name}이(가) 있어요"),
            &format!("{name} is taken on {alias}"),
        ),
        "bad_name" => say(
            "대표 봇 이름은 1–32자 글자·숫자·-·_만 쓸 수 있어요",
            "A representative's name is 1–32 letters, digits, - or _",
        ),
        "bad_frame" => say(
            &format!("{alias} 라우터가 이름 변경을 지원하지 않아요. 라우터를 업데이트해 주세요"),
            &format!("{alias} cannot rename members. Update the router"),
        ),
        "" => say("라우터가 응답하지 않아요", "The router did not answer"),
        other => other.to_string(),
    })
}

/// A representative's name is its account on every router it stands in for,
/// so they all take the new one before the bot does. One refusal puts back
/// the ones that already took it.
async fn rename(bot: &str, name: &str) -> Result<(), String> {
    let links: Vec<(String, String)> = state()
        .lock()
        .map(|st| {
            st.links
                .values()
                .filter(|l| l.cfg.bot == bot)
                .map(|l| (l.cfg.alias.clone(), l.cfg.name.clone()))
                .collect()
        })
        .unwrap_or_default();
    let mut done: Vec<(String, String)> = Vec::new();
    for (alias, old) in links {
        if let Err(err) = rename_on(&alias, name).await {
            for (alias, old) in done {
                if rename_on(&alias, &old).await.is_ok() {
                    set_account_name(&alias, &old);
                }
            }
            return Err(err);
        }
        set_account_name(&alias, name);
        done.push((alias, old));
    }
    Ok(())
}

fn set_account_name(alias: &str, name: &str) {
    if let Ok(mut st) = state().lock() {
        if let Some(link) = st.links.get_mut(alias) {
            link.cfg.name = name.to_string();
        }
        save_configs(&st);
    }
}

/// The router a bot means when it does not name one: the one it represents,
/// or the only one.
pub fn default_alias(bot: Option<&str>) -> Option<String> {
    if let Some(alias) = bot.and_then(rep_alias) {
        return Some(alias);
    }
    let st = state().lock().ok()?;
    if st.links.len() == 1 {
        return st.links.keys().next().cloned();
    }
    None
}

// ---- prompts ----

/// Remote teammates as roster entries, so the teammate sentence and mentions
/// see them like local bots.
fn remote_roster(skip_self_of: Option<&str>) -> Vec<AgentConfig> {
    let Ok(st) = state().lock() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for link in st.links.values() {
        if let Some(alias) = skip_self_of {
            if link.cfg.alias != alias {
                continue;
            }
        }
        for m in &link.members {
            if m.account == link.cfg.account {
                continue;
            }
            let mut cfg = AgentConfig::new(
                remote_id(&link.cfg.alias, &m.account),
                m.name.clone(),
                Vec::new(),
                None,
            );
            cfg.role = m.role.clone();
            out.push(cfg);
        }
    }
    out
}

/// The roster a bot's turn sees. A representative sees its own router's
/// teammates and the local bots it may hand work to: the ones in its folder,
/// or, outside a folder, every one (it asks its owner which first, see
/// [`rep_note`]). Everyone else sees every local bot and every remote one.
pub fn roster_for(bot: &str, roster: Vec<AgentConfig>) -> Vec<AgentConfig> {
    match rep_alias(bot) {
        Some(alias) => {
            let folder = rep_folder(bot);
            // Another router's representative works for another team.
            let reps = rep_bots();
            let mut out: Vec<AgentConfig> = roster
                .into_iter()
                .filter(|a| {
                    a.id == bot
                        || (!reps.contains(&a.id)
                            && folder.as_ref().is_none_or(|f| in_folder(f, &a.id)))
                })
                .collect();
            out.extend(remote_roster(Some(&alias)));
            out
        }
        None => with_remote(roster),
    }
}

/// Every local bot and every remote one: who the user can @mention, even in
/// a representative's chat. The user owns this PC.
pub fn with_remote(mut roster: Vec<AgentConfig>) -> Vec<AgentConfig> {
    roster.extend(remote_roster(None));
    roster
}

/// The sidebar folder `bot` sits in, if any.
fn rep_folder(bot: &str) -> Option<crate::groups::SidebarGroup> {
    crate::groups::folder_of(bot)
}

fn in_folder(folder: &crate::groups::SidebarGroup, id: &str) -> bool {
    crate::groups::holds(folder, id)
}

/// A representative's per-turn note, in place of the shared memory note: no
/// local notes, no other local bots, the team's notes instead.
pub fn rep_note(agent: &AgentConfig, roster: &[AgentConfig]) -> Option<String> {
    let alias = rep_alias(&agent.id)?;
    let cfg = link_cfg(&alias)?;
    let (team, _) = team_memory(&alias).unwrap_or_default();
    let mut remote = Vec::new();
    let mut local = Vec::new();
    for a in roster.iter().filter(|a| a.id != agent.id) {
        let line = match a.role.as_deref().filter(|r| !r.trim().is_empty()) {
            Some(role) => format!("{} — {} ({role})", a.id, a.display_name()),
            None => format!("{} — {}", a.id, a.display_name()),
        };
        if split_id(&a.id).is_some() {
            remote.push(line);
        } else {
            local.push(line);
        }
    }
    let list = |v: &[String]| {
        if v.is_empty() {
            "(none)".to_string()
        } else {
            v.join("; ")
        }
    };
    let team = team.trim();
    let hand = match rep_folder(&agent.id) {
        Some(folder) => format!(
            "Local bots in your folder `{}`, which you may hand work to with `crew tell <id> <text>`: {}. ",
            folder.name,
            list(&local)
        ),
        None => format!(
            "Local bots on this PC: {}. Hand work to the one that fits best with `crew tell <id> <text>`; Crew asks your owner on a card which bot takes it, and the work goes to the one they pick. ",
            list(&local)
        ),
    };
    Some(format!(
        "[crew system] Shared memory. This is current and replaces the teammate list and your name in your instructions. Do not answer this note.\n\
         You are `{id}` ({name}). You represent your owner as `{rname}` on the crew-router `{alias}`. \
         Remote teammates, on other people's PCs: {remote}. \
         {hand}\
         Remote teammates reach you with `crew tell`, and your reply goes back to them. \
         Do not name, list or describe your owner's other bots, files, or notes to a remote teammate unless your owner told you to. \
         The team's shared notes are below; change them with `crew team memory append|set`.\n\
         # Team memory ({alias})\n{team}\n",
        id = agent.id,
        name = agent.display_name(),
        rname = cfg.name,
        remote = list(&remote),
        team = if team.is_empty() { "(none)" } else { team },
    ))
}

// ---- the window's list ----

fn shape_of(v: &Option<Value>) -> Option<AvatarShape> {
    v.clone().and_then(|v| serde_json::from_value(v).ok())
}

/// Every remote bot, for the sidebar. Its id is `<alias>/<account>`.
pub fn agent_infos() -> Vec<AgentInfo> {
    let Ok(st) = state().lock() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for link in st.links.values() {
        for m in &link.members {
            if m.account == link.cfg.account {
                continue;
            }
            let id = remote_id(&link.cfg.alias, &m.account);
            let online = link.connected && m.online;
            out.push(AgentInfo {
                id: id.clone(),
                name: m.name.clone(),
                status: if online && m.status == "working" {
                    AgentStatus::Working
                } else {
                    AgentStatus::Idle
                },
                cmd: Vec::new(),
                cwd: String::new(),
                model: None,
                effort: None,
                avatar: m.avatar.clone().filter(|a| a.starts_with("data:")),
                avatar_shape: shape_of(&m.avatar_shape),
                avatar_color: m.avatar_color.clone(),
                title: None,
                description: None,
                role: m.role.clone(),
                routines: Vec::new(),
                preview: None,
                last_ts: 0,
                headless: true,
                failed: false,
                asking: online && m.status == "asking",
                for_bot: false,
                remote: Some(link.cfg.alias.clone()),
                remote_online: online,
                watch: Vec::new(),
                work_dir: None,
            });
        }
    }
    drop(st);
    for a in &mut out {
        a.preview = crate::transcript::preview(&a.id);
        a.last_ts = crate::transcript::last_ts(&a.id);
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

pub fn infos() -> Vec<RemoteInfo> {
    let Ok(st) = state().lock() else {
        return Vec::new();
    };
    let mut out: Vec<RemoteInfo> = st
        .links
        .values()
        .map(|l| RemoteInfo {
            alias: l.cfg.alias.clone(),
            url: l.cfg.url.clone(),
            name: l.cfg.name.clone(),
            account: l.cfg.account.clone(),
            bot: l.cfg.bot.clone(),
            connected: l.connected,
            members: l.members.clone(),
            trusted: l.cfg.trusted.clone(),
            blocked: l.cfg.blocked.clone(),
            error: l.error.clone(),
        })
        .collect();
    out.sort_by(|a, b| a.alias.cmp(&b.alias));
    out
}

// ---- requests ----

/// An alias is how the bot ids on this router start: short and ASCII.
pub fn valid_alias(alias: &str) -> bool {
    !alias.is_empty()
        && alias.len() <= 32
        && alias
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

async fn join(
    url: &str,
    alias: &str,
    name: &str,
    invite: Option<&str>,
    bot: &str,
) -> anyhow::Result<()> {
    if !valid_alias(alias) {
        bail!(
            "{}",
            say(
                "별칭은 32자 이하의 영문 소문자·숫자·-·_만 쓸 수 있어요",
                "An alias is up to 32 lowercase letters, digits, - or _"
            )
        );
    }
    if link_cfg(alias).is_some() {
        bail!(
            "{}",
            say(
                "같은 별칭의 라우터가 이미 있어요",
                "A router with that alias is already here"
            )
        );
    }
    if crate::daemon::agent_config(bot).is_none() {
        bail!("unknown agent {bot}");
    }
    let mut profile = profile_frame(bot);
    if let Some(o) = profile.as_object_mut() {
        o.remove("type");
    }
    let (account, name, token) = signup(url, name, invite, profile).await?;
    let cfg = RemoteConfig {
        alias: alias.to_string(),
        url: url.to_string(),
        account,
        name,
        token,
        bot: bot.to_string(),
        ..RemoteConfig::default()
    };
    {
        let mut st = state().lock().expect("remote state");
        st.links
            .insert(alias.to_string(), new_link(cfg, String::new()));
        save_configs(&st);
    }
    // Its first turn, or anything said before, ran with this PC's notes and
    // bots. The session would carry them into turns for the team.
    if let Err(err) = crate::daemon::fresh_start(bot) {
        eprintln!("[crew] remote {alias}: could not start {bot} afresh: {err:#}");
    }
    tokio::spawn(run_link(alias.to_string()));
    Ok(())
}

async fn leave(alias: &str) -> anyhow::Result<()> {
    let Some(cfg) = link_cfg(alias) else {
        bail!("unknown router {alias}");
    };
    if let Err(err) = leave_router(&cfg.url, &cfg.token).await {
        // The name stays taken until the router hears it. Keep the link so
        // the user can try again instead of losing the token.
        bail!(
            "{}",
            say(
                &format!("라우터에서 나가지 못했어요: {err:#}"),
                &format!("Could not leave the router: {err:#}")
            )
        );
    }
    forget(alias);
    Ok(())
}

fn forget(alias: &str) {
    if let Ok(mut st) = state().lock() {
        st.links.remove(alias);
        st.jobs.out.retain(|j| j.alias != alias);
        st.jobs.inbound.retain(|j| j.alias != alias);
        st.awaiting_trust.retain(|(a, _), _| a != alias);
        st.jobs.outbox.remove(alias);
        save_configs(&st);
        save_jobs(&st);
    }
    let _ = fs::remove_file(team_memory_path(alias));
}

/// The representative was deleted: so is its name on the router.
pub fn on_bot_removed(bot: &str) {
    let aliases: Vec<String> = state()
        .lock()
        .map(|st| {
            st.links
                .values()
                .filter(|l| l.cfg.bot == bot)
                .map(|l| l.cfg.alias.clone())
                .collect()
        })
        .unwrap_or_default();
    for alias in aliases {
        tokio::spawn(async move {
            if let Err(err) = leave(&alias).await {
                eprintln!("[crew] remote {alias}: {err:#}");
                forget(&alias);
            }
        });
    }
}

fn set(
    alias: &str,
    trusted: Option<Vec<String>>,
    blocked: Option<Vec<String>>,
) -> anyhow::Result<()> {
    let Some(cfg) = link_cfg(alias) else {
        bail!("unknown router {alias}");
    };
    let keep = |list: &[Peer], ids: Option<Vec<String>>| -> Vec<Peer> {
        match ids {
            None => list.to_vec(),
            Some(ids) => ids
                .into_iter()
                .map(|account| {
                    let name = list
                        .iter()
                        .find(|p| p.account == account)
                        .map(|p| p.name.clone())
                        .unwrap_or_else(|| member_name(alias, &account));
                    Peer { account, name }
                })
                .collect(),
        }
    };
    let trusted = keep(&cfg.trusted, trusted);
    let blocked = keep(&cfg.blocked, blocked);
    update_cfg(alias, |c| {
        c.trusted = trusted;
        c.blocked = blocked;
    });
    Ok(())
}

fn error(err: impl std::fmt::Display) -> Vec<Event> {
    vec![Event::Error {
        message: err.to_string(),
    }]
}

/// Requests that wait on the network. `None` for anything else.
pub async fn handle(req: &Request) -> Option<Vec<Event>> {
    let out = match req {
        Request::RemoteProbe { url } => match probe(url).await {
            Ok(server) => vec![Event::RemoteServer { server }],
            Err(err) => error(format!("{err:#}")),
        },
        Request::RemoteJoin {
            url,
            alias,
            name,
            invite,
            bot,
        } => {
            let invite = invite.as_deref().map(str::trim).filter(|s| !s.is_empty());
            match join(url, alias, name.trim(), invite, bot).await {
                Ok(()) => vec![Event::Ok],
                Err(err) => error(format!("{err:#}")),
            }
        }
        Request::SetAgent {
            id, name: Some(name), ..
        } if is_rep(id) => {
            let name = name.trim();
            let current = crate::daemon::agent_config(id).map(|c| c.name);
            if name.is_empty() || current.as_deref() == Some(name) {
                return None;
            }
            match rename(id, name).await {
                Ok(()) => return None,
                Err(err) => error(err),
            }
        }
        Request::RemoteList => vec![Event::Remotes { remotes: infos() }],
        Request::RemoteSet {
            alias,
            trusted,
            blocked,
        } => match set(alias, trusted.clone(), blocked.clone()) {
            Ok(()) => vec![Event::Ok],
            Err(err) => error(err),
        },
        Request::RemoteLeave { alias } => match leave(alias).await {
            Ok(()) => vec![Event::Ok],
            Err(err) => error(format!("{err:#}")),
        },
        Request::TeamMemory { alias, bot } => {
            let alias = alias.clone().or_else(|| default_alias(bot.as_deref()));
            match alias
                .as_deref()
                .and_then(|a| team_memory(a).map(|t| (a.to_string(), t)))
            {
                Some((alias, (text, version))) => vec![Event::TeamMemory {
                    alias,
                    text,
                    version,
                }],
                None => error(say(
                    "어느 라우터인지 모르겠어요. --remote <별칭>을 붙여 주세요",
                    "Which router? Add --remote <alias>",
                )),
            }
        }
        Request::TeamMemoryAppend { alias, bot, text } => {
            let Some(alias) = alias.clone().or_else(|| default_alias(bot.as_deref())) else {
                return Some(error(say(
                    "어느 라우터인지 모르겠어요. --remote <별칭>을 붙여 주세요",
                    "Which router? Add --remote <alias>",
                )));
            };
            let frame = json!({"type": "team_memory_append", "text": text});
            match change_team_memory(&alias, frame).await {
                Ok(_) => vec![Event::Ok],
                Err(err) => error(err),
            }
        }
        Request::TeamMemorySet {
            alias,
            bot,
            text,
            version,
        } => {
            let Some(alias) = alias.clone().or_else(|| default_alias(bot.as_deref())) else {
                return Some(error(say(
                    "어느 라우터인지 모르겠어요. --remote <별칭>을 붙여 주세요",
                    "Which router? Add --remote <alias>",
                )));
            };
            let version = version
                .or_else(|| team_memory(&alias).map(|t| t.1))
                .unwrap_or(0);
            let frame = json!({"type": "team_memory_set", "text": text, "version": version});
            match change_team_memory(&alias, frame).await {
                Ok(true) => vec![Event::Ok],
                Ok(false) => vec![Event::TeamMemoryConflict],
                Err(err) => error(err),
            }
        }
        _ => return None,
    };
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bare_host_gets_a_secure_socket_on_ws() {
        assert_eq!(
            ws_url("router.example.com:7420").unwrap(),
            "wss://router.example.com:7420/ws"
        );
        assert_eq!(
            ws_url("ws://10.0.0.2:7420").unwrap(),
            "ws://10.0.0.2:7420/ws"
        );
        assert_eq!(
            ws_url("https://r.example.com/").unwrap(),
            "wss://r.example.com/ws"
        );
        assert_eq!(
            ws_url("http://r.local:7420").unwrap(),
            "ws://r.local:7420/ws"
        );
        assert_eq!(
            ws_url("wss://r.example.com/crew/ws").unwrap(),
            "wss://r.example.com/crew/ws"
        );
        assert!(ws_url("  ").is_err());
        assert!(ws_url("wss://").is_err());
        assert!(ws_url("ftp://x").is_err());
    }

    #[test]
    fn a_remote_id_is_alias_slash_account() {
        assert_eq!(split_id("team/acc_abc"), Some(("team", "acc_abc")));
        assert_eq!(split_id("alpha"), None);
        assert_eq!(split_id("team/"), None);
        assert_eq!(split_id("/acc"), None);
        assert_eq!(split_id("a/b/c"), None);
        assert_eq!(remote_id("team", "acc_x"), "team/acc_x");
    }

    #[test]
    fn an_alias_is_short_lowercase_ascii() {
        assert!(valid_alias("team-1"));
        assert!(valid_alias("a_b"));
        assert!(!valid_alias(""));
        assert!(!valid_alias("Team"));
        assert!(!valid_alias("팀"));
        assert!(!valid_alias("a/b"));
        assert!(!valid_alias(&"a".repeat(33)));
    }

    #[test]
    fn the_hand_on_card_offers_the_named_bot_then_related_ones() {
        let bot = |id: &str, name: &str, role: Option<&str>| {
            let mut a = AgentConfig::new(id.into(), name.into(), vec!["cat".into()], None);
            a.role = role.map(str::to_string);
            a
        };
        let roster = vec![
            bot("rep", "이안", None),
            bot("impl", "구현", None),
            bot("review", "리뷰어", Some("코드 리뷰")),
            bot("design", "디자이너", None),
            bot("notes", "메모", None),
            bot("team/acc_x", "원격", None),
        ];
        let ids = |v: Vec<(String, String)>| v.into_iter().map(|(id, _)| id).collect::<Vec<_>>();
        assert_eq!(
            ids(hand_on_candidates("rep", "impl", "구현 끝나면 리뷰 부탁하고 @design 에게 화면도", &roster)),
            ["impl", "design", "review"]
        );
        assert_eq!(ids(hand_on_candidates("rep", "notes", "정리해 줘", &roster)), ["notes"]);

        let offered = hand_on_candidates("rep", "impl", "리뷰어 확인", &roster);
        let others = vec![("notes".to_string(), "메모".to_string())];
        let q = "이안이(가) 팀원이 맡긴 일을 이 PC의 봇에게 넘기려 해요. 어느 봇에게 맡길까요?";
        assert_eq!(picked_bot(&format!("{q} → 리뷰어"), &offered, &others), Some("review".into()));
        assert_eq!(picked_bot(&format!("{q} → 구현"), &offered, &others), Some("impl".into()));
        assert_eq!(picked_bot(&format!("{q} → 메모"), &offered, &others), Some("notes".into()));
        assert_eq!(picked_bot(&format!("{q} → {KEEP_IT}"), &offered, &others), None);
        assert_eq!(picked_bot(&format!("{q} → (답 없음)"), &offered, &others), None);
    }

    #[test]
    fn the_first_request_card_reads_the_owners_pick() {
        let [always, once, deny, block] = [
            format!("{TRUST_ALWAYS} — 앞으로 이 팀원의 요청은 바로 실행"),
            format!("{TRUST_ONCE} — 이 요청만 실행"),
            TRUST_DENY.to_string(),
            format!("{TRUST_BLOCK} — 앞으로 이 팀원의 요청은 모두 거절"),
        ];
        assert_eq!(parse_trust(&always), Trust::Always);
        assert_eq!(parse_trust(&once), Trust::Once);
        assert_eq!(parse_trust(&deny), Trust::Deny);
        assert_eq!(parse_trust(&block), Trust::Block);
        assert_eq!(
            parse_trust("Allow — run this teammate's requests from now on"),
            Trust::Always
        );
        assert_eq!(parse_trust("Block — decline everything"), Trust::Block);
        assert_eq!(parse_trust("Just this once"), Trust::Once);
        assert_eq!(parse_trust("(no answer)"), Trust::Deny);
        assert_eq!(parse_trust("음 글쎄요"), Trust::Deny);
    }

    #[test]
    fn every_way_a_job_ends_says_why() {
        let codes = [
            "denied",
            "recipient_gone",
            "cancelled",
            "stopped",
            "unresponsive",
            "expired",
            "relay_limit",
            "no_such_member",
            "rate_limited",
            "too_large",
        ];
        let texts: HashSet<String> = codes.iter().map(|c| done_text(c)).collect();
        assert_eq!(texts.len(), codes.len(), "two reasons read the same");
        assert_eq!(done_text("failed"), done_text("anything else"));
    }

    #[test]
    fn only_a_lost_account_stops_the_reconnects() {
        assert!(halts("replaced"));
        assert!(halts("bad_token"));
        assert!(halts("account_gone"));
        assert!(!halts("rate_limited"));
        assert!(!halts(""));
        assert_ne!(halt_text("replaced"), halt_text("account_gone"));
    }

    #[test]
    fn a_preview_is_one_line_and_short() {
        assert_eq!(preview("a\n\nb   c"), "a b c");
        let long = "가".repeat(200);
        let p = preview(&long);
        assert_eq!(p.chars().count(), 161);
        assert!(p.ends_with('…'));
    }

    #[test]
    fn received_files_are_listed_under_the_text() {
        let text = with_files("봐 줘", &[PathBuf::from("/tmp/a.png")]);
        assert!(text.starts_with("봐 줘\n\n["));
        assert!(text.contains("/tmp/a.png"));
        assert_eq!(with_files("그대로", &[]), "그대로");
    }

    #[test]
    fn a_router_that_is_not_one_or_too_new_is_refused() {
        let ok = json!({"type": "server", "name": "crew-router", "version": "0.1.0", "protocol": 1, "title": "Team", "signup": "invite"});
        let server = server_from("wss://x", &ok).unwrap();
        assert_eq!(server.title, "Team");
        assert_eq!(server.signup, "invite");
        assert!(server_from("wss://x", &json!({"type": "server", "protocol": 2})).is_err());
        assert!(server_from("wss://x", &json!({"type": "welcome"})).is_err());
    }

    #[test]
    fn the_user_can_mention_every_bot_but_a_representative_sees_only_its_own() {
        crate::paths::testing::with_home("rep-roster", || {
            let alias = "rostertest";
            let cfg = RemoteConfig {
                alias: alias.into(),
                account: "acc_me0000000000".into(),
                bot: "rep".into(),
                ..RemoteConfig::default()
            };
            let other = "rostertest2";
            let other_cfg = RemoteConfig {
                alias: other.into(),
                account: "acc_me0000000000".into(),
                bot: "other-rep".into(),
                ..RemoteConfig::default()
            };
            state()
                .lock()
                .unwrap()
                .links
                .insert(other.into(), new_link(other_cfg, String::new()));
            let mut link = new_link(cfg, String::new());
            link.members = vec![
                Member {
                    account: "acc_me0000000000".into(),
                    name: "me".into(),
                    ..Member::default()
                },
                Member {
                    account: "acc_jay000000000".into(),
                    name: "Jay".into(),
                    ..Member::default()
                },
            ];
            state().lock().unwrap().links.insert(alias.into(), link);
            let local = |id: &str| AgentConfig::new(id.into(), id.into(), vec!["cat".into()], None);
            let roster = vec![local("rep"), local("helper"), local("secret"), local("other-rep")];
            let ids = |v: Vec<AgentConfig>| v.into_iter().map(|a| a.id).collect::<Vec<_>>();

            let all = ids(with_remote(roster.clone()));
            assert!(all.contains(&"secret".to_string()));
            assert!(all.contains(&"rostertest/acc_jay000000000".to_string()));
            assert!(!all.contains(&"rostertest/acc_me0000000000".to_string()));

            // In a folder, the folder's bots are the ones to hand work to.
            let folder = |items: &[&str]| crate::groups::SidebarGroup {
                id: "g1".into(),
                name: "Team".into(),
                collapsed: false,
                items: items.iter().map(|id| format!("agent:{id}")).collect(),
                path: None,
                lead: None,
            };
            crate::groups::save(&[folder(&["rep", "helper", "other-rep"])]).unwrap();
            let rep = ids(roster_for("rep", roster.clone()));
            assert!(rep.contains(&"helper".to_string()));
            assert!(rep.contains(&"rostertest/acc_jay000000000".to_string()));
            assert!(!rep.contains(&"secret".to_string()));
            assert!(
                !rep.contains(&"other-rep".to_string()),
                "another router's representative is not one to hand work to"
            );
            let note = rep_note(&local("rep"), &roster_for("rep", roster.clone())).unwrap();
            assert!(note.contains("in your folder `Team`"), "{note}");

            // Outside a folder it sees every bot but asks its owner which.
            crate::groups::save(&[folder(&["helper"])]).unwrap();
            let rep = ids(roster_for("rep", roster.clone()));
            assert!(rep.contains(&"helper".to_string()));
            assert!(rep.contains(&"secret".to_string()));
            assert!(!rep.contains(&"other-rep".to_string()));
            let note = rep_note(&local("rep"), &roster_for("rep", roster)).unwrap();
            assert!(note.contains("Crew asks your owner on a card"), "{note}");

            state().lock().unwrap().links.remove(alias);
            state().lock().unwrap().links.remove(other);
        });
    }

    #[test]
    fn a_changed_profile_goes_out_once_and_only_while_connected() {
        let alias = "profiletest";
        let cfg = RemoteConfig {
            alias: alias.into(),
            account: "acc_me0000000000".into(),
            bot: "profile-rep".into(),
            ..RemoteConfig::default()
        };
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut link = new_link(cfg, String::new());
        link.tx = Some(tx);
        link.connected = true;
        state().lock().unwrap().links.insert(alias.into(), link);
        let sent = |rx: &mut mpsc::UnboundedReceiver<Value>| {
            std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>()
        };

        on_profile_changed("profile-rep");
        let frames = sent(&mut rx);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0]["type"], "profile");
        on_profile_changed("profile-rep");
        assert!(sent(&mut rx).is_empty(), "the same profile again stays home");
        on_profile_changed("someone-else");
        assert!(sent(&mut rx).is_empty());

        state().lock().unwrap().links.get_mut(alias).unwrap().profile = None;
        on_profile_changed("profile-rep");
        assert_eq!(sent(&mut rx).len(), 1, "a new connection hears it again");

        {
            let mut st = state().lock().unwrap();
            let link = st.links.get_mut(alias).unwrap();
            link.connected = false;
            link.profile = None;
        }
        on_profile_changed("profile-rep");
        assert!(sent(&mut rx).is_empty());
        let mut st = state().lock().unwrap();
        assert!(!st.jobs.outbox.contains_key(alias), "the next welcome sends it");
        st.links.remove(alias);
    }

    /// A one-shot router on a local port: answers `hello`, then `signup`.
    async fn fake_router(signup_reply: Value) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                let reply = signup_reply.clone();
                tokio::spawn(async move {
                    let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
                    while let Some(Ok(WsMessage::Text(t))) = ws.next().await {
                        let v: Value = serde_json::from_str(&t).unwrap();
                        let out = match v["type"].as_str().unwrap() {
                            "hello" => {
                                json!({"type": "server", "name": "crew-router", "version": "0.1.0", "protocol": 1, "title": "Lab", "signup": "open"})
                            }
                            "signup" => reply.clone(),
                            _ => continue,
                        };
                        ws.send(WsMessage::Text(out.to_string().into()))
                            .await
                            .unwrap();
                    }
                });
            }
        });
        format!("ws://{addr}")
    }

    #[tokio::test]
    async fn probe_reads_the_router_title() {
        let url = fake_router(json!({})).await;
        let server = probe(&url).await.unwrap();
        assert_eq!(server.title, "Lab");
        assert_eq!(server.protocol, PROTOCOL);
    }

    #[tokio::test]
    async fn signup_returns_the_token_or_why_not() {
        let url = fake_router(json!({"type": "signed_up", "account": "acc_abc123def456", "name": "이안", "token": "crt_x"})).await;
        let (account, name, token) = signup(&url, "이안", None, json!({})).await.unwrap();
        assert_eq!(
            (account.as_str(), name.as_str(), token.as_str()),
            ("acc_abc123def456", "이안", "crt_x")
        );

        let url = fake_router(json!({"type": "error", "code": "name_taken", "message": ""})).await;
        let err = signup(&url, "이안", None, json!({}))
            .await
            .unwrap_err()
            .to_string();
        assert!(
            err == "이름이 이미 있어요" || err == "That name is taken",
            "{err}"
        );
    }

    #[tokio::test]
    async fn a_closed_port_says_it_could_not_connect() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);
        let err = probe(&format!("ws://{addr}"))
            .await
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("연결할 수 없어요") || err.contains("Could not reach"),
            "{err}"
        );
    }
}
