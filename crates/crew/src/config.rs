use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;

use anyhow::Context;
use clap::ValueEnum;
use serde::{Deserialize, Serialize};

use crate::cron;
use crate::paths;

const DEFAULT_AGENTS: &str = include_str!("../../../agents.example.json");

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Config {
    #[serde(default)]
    pub agents: Vec<AgentConfig>,
}

pub fn unique_ids(ids: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for id in ids {
        let id = id.trim().to_string();
        if id.is_empty() {
            continue;
        }
        if seen.insert(id.clone()) {
            out.push(id);
        }
    }
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ValueEnum)]
#[serde(rename_all = "lowercase")]
#[value(rename_all = "lowercase")]
pub enum Effort {
    Low,
    Medium,
    High,
}

impl Effort {
    pub fn as_str(self) -> &'static str {
        match self {
            Effort::Low => "low",
            Effort::Medium => "medium",
            Effort::High => "high",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ValueEnum)]
#[serde(rename_all = "kebab-case")]
#[value(rename_all = "kebab-case")]
pub enum AvatarShape {
    Circle,
    Teardrop,
    RoundedSquare,
    Hexagon,
    Triangle,
    Cloud,
    Pill,
    Diamond,
    Pentagon,
    Star,
    Heart,
    Square,
    Slanted,
    Arch,
    Fan,
    Arrow,
    SemiCircle,
    Oval,
    ClamShell,
    Gem,
    Sunny,
    Cookie,
    Ghostish,
    Clover,
    Burst,
    Flower,
    Puffy,
    PuffyDiamond,
    PixelCircle,
    PixelTriangle,
    Bun,
}

const AVATAR_SHAPES: &[AvatarShape] = &[
    AvatarShape::Circle,
    AvatarShape::Teardrop,
    AvatarShape::RoundedSquare,
    AvatarShape::Hexagon,
    AvatarShape::Triangle,
    AvatarShape::Cloud,
    AvatarShape::Pill,
    AvatarShape::Diamond,
    AvatarShape::Pentagon,
    AvatarShape::Star,
    AvatarShape::Heart,
    AvatarShape::Square,
    AvatarShape::Slanted,
    AvatarShape::Arch,
    AvatarShape::Fan,
    AvatarShape::Arrow,
    AvatarShape::SemiCircle,
    AvatarShape::Oval,
    AvatarShape::ClamShell,
    AvatarShape::Gem,
    AvatarShape::Sunny,
    AvatarShape::Cookie,
    AvatarShape::Ghostish,
    AvatarShape::Clover,
    AvatarShape::Burst,
    AvatarShape::Flower,
    AvatarShape::Puffy,
    AvatarShape::PuffyDiamond,
    AvatarShape::PixelCircle,
    AvatarShape::PixelTriangle,
    AvatarShape::Bun,
];

impl AvatarShape {
    pub fn as_str(self) -> &'static str {
        match self {
            AvatarShape::Circle => "circle",
            AvatarShape::Teardrop => "teardrop",
            AvatarShape::RoundedSquare => "rounded-square",
            AvatarShape::Hexagon => "hexagon",
            AvatarShape::Triangle => "triangle",
            AvatarShape::Cloud => "cloud",
            AvatarShape::Pill => "pill",
            AvatarShape::Diamond => "diamond",
            AvatarShape::Pentagon => "pentagon",
            AvatarShape::Star => "star",
            AvatarShape::Heart => "heart",
            AvatarShape::Square => "square",
            AvatarShape::Slanted => "slanted",
            AvatarShape::Arch => "arch",
            AvatarShape::Fan => "fan",
            AvatarShape::Arrow => "arrow",
            AvatarShape::SemiCircle => "semi-circle",
            AvatarShape::Oval => "oval",
            AvatarShape::ClamShell => "clam-shell",
            AvatarShape::Gem => "gem",
            AvatarShape::Sunny => "sunny",
            AvatarShape::Cookie => "cookie",
            AvatarShape::Ghostish => "ghostish",
            AvatarShape::Clover => "clover",
            AvatarShape::Burst => "burst",
            AvatarShape::Flower => "flower",
            AvatarShape::Puffy => "puffy",
            AvatarShape::PuffyDiamond => "puffy-diamond",
            AvatarShape::PixelCircle => "pixel-circle",
            AvatarShape::PixelTriangle => "pixel-triangle",
            AvatarShape::Bun => "bun",
        }
    }

    pub fn from_key(s: &str) -> anyhow::Result<Self> {
        let raw = s.trim().to_ascii_lowercase();
        let key = match raw.as_str() {
            "droplet" => "teardrop",
            "rounded_square" | "roundedsquare" => "rounded-square",
            "rhombus" => "diamond",
            "semi_circle" | "semicircle" => "semi-circle",
            "clam_shell" | "clamshell" => "clam-shell",
            "puffy_diamond" | "puffydiamond" => "puffy-diamond",
            "pixel_circle" | "pixelcircle" => "pixel-circle",
            "pixel_triangle" | "pixeltriangle" => "pixel-triangle",
            other => other,
        };
        AVATAR_SHAPES
            .iter()
            .copied()
            .find(|shape| shape.as_str() == key)
            .ok_or_else(|| {
                let names: Vec<_> = AVATAR_SHAPES.iter().map(|shape| shape.as_str()).collect();
                let list = match names.split_last() {
                    Some((last, rest)) => format!("{}, or {}", rest.join(", "), last),
                    None => String::new(),
                };
                anyhow::anyhow!("shape must be {list} (got {raw})")
            })
    }
}

pub fn parse_hex_color(s: &str) -> anyhow::Result<String> {
    let t = s.trim();
    let hex = t.strip_prefix('#').unwrap_or(t);
    let lower = hex.to_ascii_lowercase();
    if lower.len() == 3 && lower.chars().all(|c| c.is_ascii_hexdigit()) {
        let b = lower.as_bytes();
        return Ok(format!(
            "#{0}{0}{1}{1}{2}{2}",
            b[0] as char, b[1] as char, b[2] as char
        ));
    }
    if lower.len() == 6 && lower.chars().all(|c| c.is_ascii_hexdigit()) {
        return Ok(format!("#{lower}"));
    }
    anyhow::bail!("color must be a hex value like #ff6a00");
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
#[value(rename_all = "lowercase")]
pub enum AgentCli {
    Grok,
    Claude,
    Codex,
    /// Antigravity CLI. The binary is `agy`.
    Agy,
    Gemini,
    Copilot,
    Opencode,
}

impl AgentCli {
    pub fn default_cmd(self) -> Vec<String> {
        match self {
            AgentCli::Grok => vec!["grok".into(), "--always-approve".into()],
            AgentCli::Claude => vec!["claude".into(), "--dangerously-skip-permissions".into()],
            AgentCli::Codex => vec!["codex".into(), "--yolo".into()],
            AgentCli::Agy => vec!["agy".into(), "--dangerously-skip-permissions".into()],
            AgentCli::Gemini => vec!["gemini".into(), "--approval-mode".into(), "yolo".into()],
            AgentCli::Copilot => {
                vec!["copilot".into(), "--allow-all".into(), "--no-ask-user".into()]
            }
            AgentCli::Opencode => vec!["opencode".into(), "run".into(), "--auto".into()],
        }
    }

    pub fn from_key(s: &str) -> anyhow::Result<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "grok" => Ok(Self::Grok),
            "claude" => Ok(Self::Claude),
            "codex" => Ok(Self::Codex),
            "agy" | "antigravity" => Ok(Self::Agy),
            "gemini" => Ok(Self::Gemini),
            "copilot" => Ok(Self::Copilot),
            "opencode" => Ok(Self::Opencode),
            other => anyhow::bail!(
                "cli must be grok, claude, codex, agy, gemini, copilot, or opencode (got {other})"
            ),
        }
    }

    pub fn from_cmd(cmd: &[String]) -> Option<Self> {
        let bin = cmd.first()?;
        let name = std::path::Path::new(bin)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(bin);
        Self::from_key(name).ok()
    }
}

pub fn resolve_add_cmd(cli: Option<AgentCli>, cmd: Vec<String>) -> anyhow::Result<Vec<String>> {
    if !cmd.is_empty() {
        return Ok(cmd);
    }
    match cli {
        Some(cli) => Ok(cli.default_cmd()),
        None => anyhow::bail!(
            "pass --cli grok|claude|codex|agy|gemini|copilot|opencode or --cmd …"
        ),
    }
}

fn default_true() -> bool {
    true
}

fn is_false(v: &bool) -> bool {
    !*v
}

/// Split a command line the way a person types it: whitespace separates
/// arguments, and quotes keep a space inside one argument.
pub fn split_cmd(input: &str) -> anyhow::Result<Vec<String>> {
    let mut args = Vec::new();
    let mut cur = String::new();
    let mut chars = input.chars().peekable();
    let mut in_arg = false;
    let mut quote: Option<char> = None;
    while let Some(c) = chars.next() {
        match quote {
            Some(q) if c == q => quote = None,
            // Single quotes keep a backslash. A typed path like 'C:\tools\ai' must survive.
            Some('\'') => {
                in_arg = true;
                cur.push(c);
            }
            Some(_) if c == '\\' => {
                in_arg = true;
                cur.push(chars.next().unwrap_or('\\'));
            }
            Some(_) => {
                in_arg = true;
                cur.push(c);
            }
            None if c == '\\' => {
                in_arg = true;
                cur.push(chars.next().unwrap_or('\\'));
            }
            None if c == '"' || c == '\'' => {
                in_arg = true;
                quote = Some(c);
            }
            None if c.is_whitespace() => {
                if in_arg {
                    args.push(std::mem::take(&mut cur));
                    in_arg = false;
                }
            }
            None => {
                in_arg = true;
                cur.push(c);
            }
        }
    }
    if quote.is_some() {
        anyhow::bail!("command has an unclosed quote");
    }
    if in_arg {
        args.push(cur);
    }
    if args.is_empty() {
        anyhow::bail!("command is empty");
    }
    Ok(args)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Routine {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub schedule: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run: Option<String>,
}

impl Routine {
    pub fn new(name: String, schedule: String, prompt: String) -> anyhow::Result<Self> {
        let name = name.trim().to_string();
        if name.is_empty() {
            anyhow::bail!("routine name is empty");
        }
        if prompt.trim().is_empty() {
            anyhow::bail!("routine prompt is empty");
        }
        cron::validate(&schedule)?;
        Ok(Self {
            id: new_routine_id(),
            name,
            prompt,
            schedule,
            enabled: true,
            last_run: None,
        })
    }

    /// Replace the fields that are given and non-blank. A schedule may be cron
    /// or a short Korean/English sentence.
    pub fn edit(
        &mut self,
        name: Option<String>,
        schedule: Option<String>,
        prompt: Option<String>,
    ) -> anyhow::Result<()> {
        if let Some(name) = name {
            let name = name.trim();
            if !name.is_empty() {
                self.name = name.to_string();
            }
        }
        if let Some(schedule) = schedule {
            let schedule = schedule.trim();
            if !schedule.is_empty() {
                let resolved = if cron::validate(schedule).is_ok() {
                    schedule.to_string()
                } else {
                    crate::nl_routine::parse_nl_routine(schedule)?.schedule
                };
                cron::validate(&resolved)?;
                self.schedule = resolved;
            }
        }
        if let Some(prompt) = prompt {
            let prompt = prompt.trim();
            if !prompt.is_empty() {
                self.prompt = prompt.to_string();
            }
        }
        Ok(())
    }

    pub fn is_due(&self, now: &cron::LocalTime) -> bool {
        if !self.enabled {
            return false;
        }
        if !cron::matches(&self.schedule, now).unwrap_or(false) {
            return false;
        }
        self.last_run.as_deref() != Some(now.minute_key().as_str())
    }
}

fn new_routine_id() -> String {
    let n = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("r{n:x}")
}

pub fn find_routine_index(routines: &[Routine], key: &str) -> Option<usize> {
    let key = key.trim();
    if key.is_empty() {
        return None;
    }
    routines
        .iter()
        .position(|r| r.id == key)
        .or_else(|| routines.iter().position(|r| r.name == key))
        .or_else(|| {
            routines
                .iter()
                .position(|r| r.name.eq_ignore_ascii_case(key))
        })
}

pub fn default_add_cwd(id: &str) -> String {
    format!("/tmp/crew-demo/{id}")
}

/// Display name for a cloned bot. `--name` wins; otherwise append " 복사본".
pub fn clone_agent_name(src_name: &str, given: Option<&str>) -> String {
    match given.map(str::trim).filter(|s| !s.is_empty()) {
        Some(n) => n.to_string(),
        None => {
            let base = src_name.trim();
            if base.is_empty() {
                "복사본".into()
            } else {
                format!("{base} 복사본")
            }
        }
    }
}

/// ascii lowercase + hyphens. Non-ascii names fall back to `bot`.
pub fn slug_id(name: &str) -> String {
    slug_with_fallback(name, "bot")
}

/// Caps a minted slug well short of `valid_agent_id`'s 64, leaving room for the
/// `-2` … `-N` suffix `unique_from_base` appends. Without it a long name mints
/// an id the id rule then rejects.
const SLUG_MAX: usize = 48;

fn slug_with_fallback(name: &str, fallback: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if c.is_ascii_whitespace() || c == '_' || c == '-' {
            if !out.is_empty() && !out.ends_with('-') {
                out.push('-');
            }
        }
    }
    out.truncate(SLUG_MAX);
    let out = out.trim_matches('-').to_string();
    if out.is_empty() {
        fallback.into()
    } else {
        out
    }
}

/// Base36 milliseconds since the epoch.
///
/// This is a wall clock, not a monotonic one. It does not *prove* an id is
/// never reissued — a clock stepped backwards could repeat a millisecond — but
/// it is what stops the id of a deleted bot from being handed to the next bot
/// of that name, which is the way ids actually came back. A counter that
/// guarantees it would have to live in the daemon's saved state, and today the
/// id is minted by the caller before the `AddAgent` request is sent.
fn stamp_from(now: std::time::SystemTime) -> String {
    let mut ms = now
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    if ms == 0 {
        // A clock before the epoch would otherwise stamp every bot `-0`, which
        // is the recycling this exists to stop.
        return "epoch".into();
    }
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = String::new();
    while ms > 0 {
        out.insert(0, DIGITS[(ms % 36) as usize] as char);
        ms /= 36;
    }
    out
}

/// An id is minted from the name *and* the moment it was minted, so deleting a
/// bot does not free its id for the next one. A reused id would otherwise come
/// back attached to the deleted bot's `/tmp/crew-demo/<id>` folder, its
/// `routine_runs/<id>/` and its `archive/<id>/` — none of which removal clears.
///
/// The name still leads, so an id stays recognisable; a name with no ASCII
/// slugs to `bot`, and the stamp is what tells those apart.
fn agent_id_at<S: AsRef<str>>(
    name: &str,
    now: std::time::SystemTime,
    existing: impl IntoIterator<Item = S>,
) -> String {
    unique_from_base(format!("{}-{}", slug_id(name), stamp_from(now)), existing)
}

pub fn unique_agent_id<S: AsRef<str>>(name: &str, existing: impl IntoIterator<Item = S>) -> String {
    agent_id_at(name, std::time::SystemTime::now(), existing)
}

/// One wording for one rule, so the CLI and the daemon do not each phrase the
/// same refusal differently.
pub fn id_rule(id: &str) -> String {
    format!("id {id} must be 1-64 of a-z, 0-9, '-' or '_'")
}

/// Ids reach the filesystem through `paths::safe_agent_id`, which folds every
/// character outside `[A-Za-z0-9_-]` to `_` — so `춘식이` and `죠르디` would
/// share one transcript, one memory file and one avatar. Minted ids are always
/// in range; the CLI takes an id verbatim, so it is the CLI that needs telling.
///
/// Uppercase is out too: the app ships for macOS, where `Grok` and `grok` are
/// two agents to the daemon's maps and one file to the filesystem. Length is
/// bounded because `transcripts/<id>.jsonl` has to fit in a 255-byte name.
pub fn valid_agent_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

fn unique_from_base<S: AsRef<str>>(base: String, existing: impl IntoIterator<Item = S>) -> String {
    let taken: std::collections::HashSet<String> = existing
        .into_iter()
        .map(|s| s.as_ref().to_string())
        .collect();
    if !taken.contains(&base) {
        return base;
    }
    let mut n = 2u32;
    loop {
        let cand = format!("{base}-{n}");
        if !taken.contains(&cand) {
            return cand;
        }
        n += 1;
    }
}

pub fn empty_to_none(s: String) -> Option<String> {
    let t = s.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    pub id: String,
    pub name: String,
    pub cmd: Vec<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_shape: Option<AvatarShape>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<Effort>,
    /// An unknown command that chats: each message is its last argument.
    /// Known CLIs ignore this and follow their own program.
    #[serde(default, skip_serializing_if = "is_false")]
    pub headless: bool,
    #[serde(default)]
    pub routines: Vec<Routine>,
}

impl Config {
    pub fn load() -> anyhow::Result<Self> {
        let path = paths::agents_path();
        if !path.exists() {
            paths::ensure_home()?;
            fs::write(&path, DEFAULT_AGENTS)?;
        }
        let raw = fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
        // An empty roster is a starting point, not an error. Deleting the last
        // bot saves one, and refusing to load it left the daemon dead and the
        // desktop quitting on launch with no way back in.
        serde_json::from_str(&raw).with_context(|| format!("parse {}", path.display()))
    }

    pub fn save(&self) -> anyhow::Result<()> {
        paths::ensure_home()?;
        let path = paths::agents_path();
        let raw = serde_json::to_string_pretty(self)?;
        // The CLI reads this file while the daemon may be writing it.
        paths::write_atomic(&path, (raw + "\n").as_bytes())?;
        Ok(())
    }

    pub fn default_cwd(agent: &AgentConfig) -> PathBuf {
        match &agent.cwd {
            Some(cwd) if !cwd.is_empty() => paths::expand_tilde(cwd),
            _ => PathBuf::from("/tmp/crew-demo"),
        }
    }
}

impl AgentConfig {
    pub fn new(id: String, name: String, cmd: Vec<String>, cwd: Option<String>) -> Self {
        Self {
            id,
            name,
            cmd,
            cwd,
            avatar: None,
            avatar_shape: None,
            avatar_color: None,
            title: None,
            description: None,
            role: None,
            model: None,
            effort: None,
            headless: false,
            routines: Vec::new(),
        }
    }

    pub fn display_name(&self) -> &str {
        if self.name.is_empty() {
            &self.id
        } else {
            &self.name
        }
    }

    /// Same bot, new session: fresh id / cwd / routine ids. Avatar path is
    /// left empty — caller copies bytes via `avatar::copy_for`. Shape and
    /// color copy with the rest of the identity.
    pub fn duplicate<S: AsRef<str>>(
        &self,
        given_name: Option<&str>,
        existing_ids: impl IntoIterator<Item = S>,
    ) -> Self {
        let name = clone_agent_name(&self.name, given_name);
        let id = unique_agent_id(&name, existing_ids);
        Self {
            cwd: Some(default_add_cwd(&id)),
            id,
            name,
            cmd: self.cmd.clone(),
            avatar: None,
            avatar_shape: self.avatar_shape,
            avatar_color: self.avatar_color.clone(),
            title: self.title.clone(),
            description: self.description.clone(),
            role: self.role.clone(),
            model: self.model.clone(),
            effort: self.effort,
            headless: self.headless,
            routines: self
                .routines
                .iter()
                .enumerate()
                .map(|(i, r)| {
                    let mut c = r.clone();
                    c.id = format!("{}-{i}", new_routine_id());
                    c
                })
                .collect(),
        }
    }

    pub fn binary_name(&self) -> String {
        let raw = self.cmd.first().map(|s| s.as_str()).unwrap_or("");
        std::path::Path::new(raw)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(raw)
            .to_ascii_lowercase()
    }

    /// argv to spawn. `fresh_session` strips resume/continue flags so reset
    /// starts a new CLI session instead of attaching to the previous one.
    #[cfg(test)]
    pub fn spawn_cmd(&self, fresh_session: bool) -> Vec<String> {
        self.spawn_cmd_with(fresh_session, &[])
    }

    pub fn spawn_cmd_with(&self, fresh_session: bool, roster: &[AgentConfig]) -> Vec<String> {
        self.argv_with_memory(fresh_session, roster, &crate::memory::read(&self.id))
    }

    fn argv_with_memory(
        &self,
        fresh_session: bool,
        roster: &[AgentConfig],
        memory: &str,
    ) -> Vec<String> {
        let mut args = self.cmd.clone();
        if args.is_empty() {
            return args;
        }
        let program = self.binary_name();
        if fresh_session {
            strip_resume_flags(&program, &mut args);
        }
        inject_model_effort(&program, &mut args, self.model.as_deref(), self.effort);
        inject_system_prefix(&program, &mut args, self, roster, memory);
        args
    }

    /// grok / claude / codex and the other known CLIs run as one-shot headless
    /// turns. `cat` and other stubs stay on a long-lived PTY unless this bot
    /// was created with `headless`, which appends each message as the last arg.
    pub fn uses_pty(&self) -> bool {
        uses_pty_program(&self.binary_name()) && !self.headless
    }

    /// No per-bot session flag. Each turn sends the chat so far in the prompt.
    pub fn prompt_mode(&self) -> bool {
        match self.binary_name().as_str() {
            "grok" | "claude" | "codex" => false,
            "gemini" | "agy" | "copilot" | "opencode" => true,
            _ => self.headless,
        }
    }

    /// argv for one headless turn. Always strips stored resume flags, then
    /// attaches this turn's session (`--resume` / `--session-id` / `exec resume`)
    /// plus the real print/json flags for that CLI. `memory` is what goes in the
    /// system prompt; the caller picks it so a resumed session keeps its own.
    pub fn turn_cmd(
        &self,
        prompt: &str,
        session: Option<&TurnSession>,
        roster: &[AgentConfig],
        memory: &str,
    ) -> Vec<String> {
        let mut args = self.argv_with_memory(true, roster, memory);
        let spoken = self
            .prompt_mode()
            .then(|| prompt_with_preamble(self, roster, memory, prompt));
        let prompt = spoken.as_deref().unwrap_or(prompt);
        match self.binary_name().as_str() {
            "grok" => apply_grok_turn(&mut args, prompt, session),
            "claude" => apply_claude_turn(&mut args, prompt, session),
            "codex" => apply_codex_turn(&mut args, prompt, session),
            "gemini" => apply_gemini_turn(&mut args, prompt),
            "agy" => apply_agy_turn(&mut args, prompt),
            "copilot" => apply_copilot_turn(&mut args, prompt),
            "opencode" => apply_opencode_turn(&mut args, prompt),
            _ if self.headless => apply_custom_turn(&mut args, prompt),
            _ => {}
        }
        args
    }
}

pub fn uses_pty_program(program: &str) -> bool {
    !matches!(
        program,
        "grok" | "claude" | "codex" | "gemini" | "agy" | "copilot" | "opencode"
    )
}

/// `--headless` only marks a command Crew does not already know. A known CLI
/// stays on its own flags, so the flag cannot turn grok into a raw last-arg.
pub fn headless_cmd(flag: bool, cmd: &[String]) -> bool {
    if !flag {
        return false;
    }
    let raw = cmd.first().map(String::as_str).unwrap_or("");
    let program = std::path::Path::new(raw)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(raw)
        .to_ascii_lowercase();
    uses_pty_program(&program)
}

/// CLI conversation to continue. `resume` false means a brand-new session id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnSession {
    pub id: String,
    pub resume: bool,
}

fn has_flag(args: &[String], names: &[&str]) -> bool {
    args.iter().any(|a| {
        names
            .iter()
            .any(|n| a == n || a.starts_with(&format!("{n}=")))
    })
}

fn inject_model_effort(
    program: &str,
    args: &mut Vec<String>,
    model: Option<&str>,
    effort: Option<Effort>,
) {
    match program {
        "grok" => {
            if let Some(model) = model.filter(|m| !m.is_empty()) {
                if !has_flag(args, &["--model", "-m"]) {
                    args.push("--model".into());
                    args.push(model.to_string());
                }
            }
            if let Some(effort) = effort {
                if !has_flag(args, &["--reasoning-effort", "--effort"]) {
                    args.push("--reasoning-effort".into());
                    args.push(effort.as_str().to_string());
                }
            }
        }
        "claude" => {
            if let Some(model) = model.filter(|m| !m.is_empty()) {
                if !has_flag(args, &["--model"]) {
                    args.push("--model".into());
                    args.push(model.to_string());
                }
            }
            if let Some(effort) = effort {
                if !has_flag(args, &["--effort"]) {
                    args.push("--effort".into());
                    args.push(effort.as_str().to_string());
                }
            }
        }
        "codex" => {
            if let Some(model) = model.filter(|m| !m.is_empty()) {
                if !has_flag(args, &["--model", "-m"]) {
                    args.push("--model".into());
                    args.push(model.to_string());
                }
            }
            if let Some(effort) = effort {
                let already = args.iter().any(|a| a.contains("model_reasoning_effort"));
                if !already {
                    args.push("-c".into());
                    args.push(format!("model_reasoning_effort={}", effort.as_str()));
                }
            }
        }
        "agy" => {
            if let Some(model) = model.filter(|m| !m.is_empty()) {
                if !has_flag(args, &["--model", "-m"]) {
                    args.push("--model".into());
                    args.push(model.to_string());
                }
            }
            if let Some(effort) = effort {
                if !has_flag(args, &["--effort"]) {
                    args.push("--effort".into());
                    args.push(effort.as_str().to_string());
                }
            }
        }
        "gemini" | "copilot" => {
            if let Some(model) = model.filter(|m| !m.is_empty()) {
                if !has_flag(args, &["--model", "-m"]) {
                    args.push("--model".into());
                    args.push(model.to_string());
                }
            }
        }
        "opencode" => {
            if let Some(model) = model.filter(|m| !m.is_empty()) {
                if !has_flag(args, &["--model", "-m"]) {
                    let model = match effort {
                        Some(effort) if !model.contains('#') => {
                            format!("{model}#{}", effort.as_str())
                        }
                        _ => model.to_string(),
                    };
                    args.push("-m".into());
                    args.push(model);
                }
            }
        }
        _ => {}
    }
}

/// One-shot note for a bot that was just created. It asks what work to take.
/// The caller wraps this in a `[crew system]` envelope so it is not a user line.
pub fn new_bot_ask(english: bool) -> String {
    let lang = if english {
        "Write in English."
    } else {
        "Write in Korean."
    };
    format!(
        "You were just created and have no assigned work yet. Ask the user, in one short message, what work or role they want you to take. Do not ask permission to proceed, do not start other work, and do not use tools. {lang}"
    )
}

/// Short spawn-time prompt: identity, where the live team list lives, and how to `crew tell`.
pub fn team_rules(agent: &AgentConfig, _roster: &[AgentConfig]) -> String {
    let mut s = String::new();
    s.push_str(&format!(
        "You are Crew agent `{}` ({}).\n",
        agent.id,
        agent.display_name()
    ));
    s.push_str(
        "Shared memory is current on every turn. A `[crew system]` note that starts with `Shared memory` holds the live teammate list and your live name, plus the notes every bot shares. That note replaces any teammate list in these instructions, including after a compact. Use the note. To read it, run `crew share show`. To add a note for every bot, run `crew share append <<'EOF'` with one short line, then `EOF`. To replace the shared notes, run `crew share show`, then `crew share set <<'EOF'` with the notes only, then `EOF`. Crew writes the teammate list, so `crew share set` does not change it. Do not copy the teammate list into your own memory. Do not save secrets there. When you sit in a group, the note also holds a `# Group memory` section for that group. To add to it, run `crew group memory append <<'EOF'` with one short line, then `EOF`. To replace it, run `crew group memory show`, then `crew group memory set <<'EOF'` with the whole new notes, then `EOF`.\n",
    );
    s.push_str(
        "A teammate is written `@<id>`, and Crew shows it as their name. To name a teammate in your reply, write `@<id>` too; that only shows their name and sends nothing. When the user writes one, they are naming a teammate for YOU. Stay in this session. If you need them, actually run `crew tell <id> <text>` (crew is on PATH, CREW_AGENT_ID is set). Do not ask the user to switch chats. Do not pretend. If several teammates are named, they are asked after you finish, in the order they were written. A tell you run waits until then too, so after `crew tell`, end your turn. Do not wait, sleep, or check for the reply.\n",
    );
    s.push_str(
        "To change your display name, actually run `crew agent set --name \"New Name\"` (id defaults to CREW_AGENT_ID). Do not only claim you renamed yourself.\n",
    );
    s.push_str(
        "To create a bot, actually run `crew agent add --cli grok|claude|codex|agy|gemini|copilot|opencode --name \"Name\"`. Crew mints the id and prints `ok <id>`. Pass an id first only when you already have one (`crew agent add <id> --cli grok --name \"Name\"`). For a command Crew does not know, run `crew agent add --headless --name \"Name\" --cmd <program> [args]`; each message is appended as the last argument. `--cmd` has to be last, or the name is swallowed as an argument. Without `--headless`, an unknown command stays a terminal. To create a sidebar group, actually run `crew group add --name \"Name\"`, repeating `--bot <id>` for each bot that should sit in it. `crew group list` prints each group's id, name, and bots. Do not only claim you created a bot or a group.\n",
    );
    s.push_str(
        "To schedule recurring work, actually run `crew routine add --name \"...\" --schedule \"0 8 * * 1-5\" --prompt \"...\"`. Turn the user's words into 5-field cron yourself: numbers only, minute hour day month weekday (0 = Sunday), local time. If the day or time is unclear, ask with `crew ask` first. `crew routine list` shows yours; change one with `crew routine edit|remove|pause|resume <name>` (`crew routine --help`). Each prints your routines with their next run; tell the user the schedule and next run it shows. That creates a Crew routine, not a chat reminder.\n",
    );
    s.push_str(
        "In a paragraph of your reply, start each sentence on a new line, with no blank line between them; a blank line starts a new chat balloon. Keep list items, options, tables, headings and code as they are.\n",
    );
    s.push_str(
        "The user talks to you in this session. Incoming `[crew from:…]` / `[crew routine:…]` / `[crew system]` / `[crew handoff from:…]` / `[crew reply:…]` are real messages. A `[crew reply:…]` line is the user answering an earlier message; the next line is the quote, then their new text. A handoff is a teammate's finished reply; do not crew tell them that same text back.\n",
    );
    s.push_str(
        "To ask the human user in this chat to pick, actually run `crew ask --question \"어느 쪽을 고를래?\" --option A --option B --option C`. To ask them to type a value, run `crew ask --question \"로그인\" --input 아이디 --input 비밀번호`. Crew shows a card and prints their answer. Never send this to a teammate. Do not crew tell the options. Do not ask the user to type the letter. This is not a substitute for `crew tell`, `crew agent set`, or `crew routine add`.\n",
    );
    s.push_str(&format!(
        "Your memory survives chat resets. It is under `{MEMORY_HEADING}` at the end of these instructions (absent while empty); if it changes between turns, a `[crew system]` note gives you the new one, and `crew memory show` prints it now. It is your own memory: keep your notes there, not in other memory files or tools. The teammate list and notes every bot shares belong in shared memory. Keep it yourself: when you learn something later chats need (the user's name, preferences, a decision) or the user asks you to remember it, actually run `crew memory append <<'EOF'` with one short line, then `EOF`. To correct or forget something, run `crew memory show`, then `crew memory set <<'EOF'` with the whole new memory; it replaces everything. Always pass the text in a quoted heredoc like this, so the shell leaves `$` and backticks alone. A schedule is a routine, not a memory. Do not save what is already there, one-off chatter, or passwords, tokens and other secrets. Do not only claim you remembered.\n",
    ));
    s
}

const MEMORY_HEADING: &str = "# Your memory";

/// `id — name` list, in id order. `(none)` when this bot is alone.
fn teammates_sentence(agent: &AgentConfig, roster: &[AgentConfig]) -> String {
    let mut others: Vec<&AgentConfig> = roster.iter().filter(|a| a.id != agent.id).collect();
    others.sort_by(|a, b| a.id.cmp(&b.id));
    if others.is_empty() {
        return "Teammates: (none).".to_string();
    }
    let parts: Vec<String> = others
        .into_iter()
        .map(|a| format!("{} — {}", a.id, a.display_name()))
        .collect();
    format!("Teammates: {}.", parts.join("; "))
}

/// Short `[crew system]` note for running PTYs when the roster changes.
pub fn roster_update_text(agent: &AgentConfig, roster: &[AgentConfig]) -> String {
    format!(
        "You are `{}` ({}). {} A teammate is written `@<id>`, and Crew shows it as their name; write them that way in your reply too. When the user writes one they are naming a teammate for YOU. Stay in this session. If you need them, actually run `crew tell <id> <text>`. Do not ask the user to switch chats. Do not pretend.",
        agent.id,
        agent.display_name(),
        teammates_sentence(agent, roster)
    )
}

fn all_teammates_sentence(roster: &[AgentConfig]) -> String {
    if roster.is_empty() {
        return "Teammates: (none).".to_string();
    }
    let mut list: Vec<&AgentConfig> = roster.iter().collect();
    list.sort_by(|a, b| a.id.cmp(&b.id));
    let parts: Vec<String> = list
        .into_iter()
        .map(|a| format!("{} — {}", a.id, a.display_name()))
        .collect();
    format!("Teammates: {}.", parts.join("; "))
}

/// What `crew share show` prints, and the body of the per-turn note. The
/// teammate list is built from the live roster, not from the notes file.
pub fn shared_memory_body(agent: Option<&AgentConfig>, roster: &[AgentConfig], notes: &str) -> String {
    let mut s = String::new();
    if let Some(agent) = agent {
        s.push_str(&format!(
            "You are `{}` ({}). ",
            agent.id,
            agent.display_name()
        ));
        s.push_str(&teammates_sentence(agent, roster));
    } else {
        s.push_str(&all_teammates_sentence(roster));
    }
    s.push_str("\n# Notes\n");
    let notes = notes.trim();
    if notes.is_empty() {
        s.push_str("(none)\n");
    } else {
        s.push_str(notes);
        if !s.ends_with('\n') {
            s.push('\n');
        }
    }
    s
}

/// The group a bot sits in, as a section of the shared memory note. Empty
/// for a bot in no group.
pub fn group_memory_section(group: Option<&(String, String)>) -> String {
    let Some((name, notes)) = group else {
        return String::new();
    };
    let notes = notes.trim();
    let notes = if notes.is_empty() { "(none)" } else { notes };
    format!(
        "# Group memory ({name})\nNotes every bot in the group you are in shares.\n{notes}\n"
    )
}

/// Live team list and shared notes. grok, claude, and codex keep the
/// instructions from the turn the session started, so this note is the copy
/// that is actually current.
pub fn shared_memory_note(agent: &AgentConfig, roster: &[AgentConfig], notes: &str) -> String {
    format!(
        "[crew system] Shared memory. This is current and replaces the teammate list and your name in your instructions. Do not answer this note.\n{}",
        shared_memory_body(Some(agent), roster, notes)
    )
}

/// `@id` tokens in `text` that name a teammate (not `self_id`).
pub fn mentioned_teammate_ids(text: &str, self_id: &str, roster: &[AgentConfig]) -> Vec<String> {
    let mut found = Vec::new();
    let mut seen = HashSet::new();
    for token in mention_tokens(text) {
        if let Some(id) = resolve_mention(&token, self_id, roster) {
            if seen.insert(id.clone()) {
                found.push(id);
            }
        }
    }
    found
}

/// Prompt for the CLI: raw user text, plus a short `[crew system]` hint when
/// the user @mentioned teammates. Transcript keeps the raw message.
pub fn with_mention_hint(text: &str, self_id: &str, roster: &[AgentConfig]) -> String {
    let scan = crate::rows::reply_body(text);
    let ids = mentioned_teammate_ids(scan, self_id, roster);
    if ids.is_empty() {
        return text.to_string();
    }
    let note = format!(
        "User already messaged teammates via crew: {}. They have this request. Stay in this session. Do not ask the user to switch chats. Do not pretend.",
        ids.join(", ")
    );
    format!("{text}\n\n[crew system]\n{note}")
}

/// A handle is `@` and an id. Ids are ASCII (`valid_agent_id`), so one ends at
/// the first other character, as long as that ends the word too: a Korean
/// particle (`@bot-x에게`) or closing punctuation (`@bot-x,`) does, the `.ai`
/// in `@claude.ai` does not. Names are for the screen only; the composer
/// turns them into ids. `handleAt` in the UI reads a handle the same way.
pub(crate) fn mention_tokens(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut prev_ws = true;
    for (idx, ch) in text.char_indices() {
        if ch == '@' && prev_ws {
            let raw = text[idx + 1..].split(char::is_whitespace).next().unwrap_or("");
            let end = raw
                .find(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
                .unwrap_or(raw.len());
            let (token, rest) = raw.split_at(end);
            let ends = rest.is_empty()
                || !rest.starts_with(|c: char| c.is_ascii())
                || rest.chars().all(is_mention_punct);
            if !token.is_empty() && ends {
                out.push(token.to_string());
            }
        }
        prev_ws = ch.is_whitespace();
    }
    out
}

fn is_mention_punct(c: char) -> bool {
    matches!(
        c,
        ',' | '.' | '!' | '?' | ':' | ';' | ')' | ']' | '}' | '"' | '\''
    )
}

pub(crate) fn resolve_mention(
    token: &str,
    self_id: &str,
    roster: &[AgentConfig],
) -> Option<String> {
    roster
        .iter()
        .find(|a| a.id != self_id && a.id.eq_ignore_ascii_case(token))
        .map(|a| a.id.clone())
}

/// Stable team_rules first, then memory. Memory changes must not sit in front
/// of the identity/tell instructions or prefix caches miss every append.
fn inject_system_prefix(
    program: &str,
    args: &mut Vec<String>,
    agent: &AgentConfig,
    roster: &[AgentConfig],
    memory: &str,
) {
    inject_team_rules(program, args, agent, roster);
    inject_memory(program, args, memory);
}

fn inject_team_rules(
    program: &str,
    args: &mut Vec<String>,
    agent: &AgentConfig,
    roster: &[AgentConfig],
) {
    let text = team_rules(agent, roster);
    match program {
        "grok" => append_flag_value(args, "--rules", &text),
        "claude" => append_flag_value(args, "--append-system-prompt", &text),
        "codex" => append_codex_config(args, "developer_instructions", &text),
        _ => {}
    }
}

/// Team rules and memory have no flag on these CLIs, so they lead the prompt.
fn prompt_with_preamble(
    agent: &AgentConfig,
    roster: &[AgentConfig],
    memory: &str,
    prompt: &str,
) -> String {
    let mut body = team_rules(agent, roster);
    let memory = memory.trim();
    if !memory.is_empty() {
        body.push_str("\n\n");
        body.push_str(MEMORY_HEADING);
        body.push('\n');
        body.push_str(memory);
    }
    if !body.ends_with('\n') {
        body.push('\n');
    }
    body.push('\n');
    body.push_str(prompt);
    body
}

fn apply_gemini_turn(args: &mut Vec<String>, prompt: &str) {
    remove_switch(args, &["--yolo", "-y"]);
    remove_flag_with_value(
        args,
        &["-p", "--prompt", "--output-format", "--approval-mode"],
    );
    args.push("--approval-mode".into());
    args.push("yolo".into());
    args.push("--output-format".into());
    args.push("text".into());
    args.push("-p".into());
    args.push(prompt.to_string());
}

fn apply_agy_turn(args: &mut Vec<String>, prompt: &str) {
    // `-p` is print mode. The prompt is the argument after it, so a value
    // flag placed between them would be read as the prompt.
    remove_switch(args, &["-p", "--print", "--prompt", "-i", "--prompt-interactive"]);
    remove_flag_with_value(args, &["--output-format"]);
    if !has_flag(args, &["--dangerously-skip-permissions"]) {
        args.push("--dangerously-skip-permissions".into());
    }
    args.push("--output-format".into());
    args.push("text".into());
    args.push("-p".into());
    args.push(prompt.to_string());
}

fn apply_copilot_turn(args: &mut Vec<String>, prompt: &str) {
    remove_switch(args, &["-s", "--silent"]);
    remove_flag_with_value(args, &["-p", "--output-format"]);
    if !has_flag(args, &["--allow-all", "--yolo"]) {
        args.push("--allow-all".into());
    }
    if !has_flag(args, &["--no-ask-user"]) {
        args.push("--no-ask-user".into());
    }
    args.push("-s".into());
    args.push("-p".into());
    args.push(prompt.to_string());
}

fn apply_opencode_turn(args: &mut Vec<String>, prompt: &str) {
    if args.get(1).map(String::as_str) != Some("run") {
        args.insert(1, "run".into());
    }
    // `-c` is the last session in this directory, which may be another bot's.
    // `-p` is the server password, not a prompt, so it stays.
    remove_switch(args, &["--continue", "-c", "--fork"]);
    remove_flag_with_value(args, &["--session", "-s", "--format"]);
    if !has_flag(args, &["--auto"]) {
        args.push("--auto".into());
    }
    args.push(prompt.to_string());
}

fn apply_custom_turn(args: &mut Vec<String>, prompt: &str) {
    args.push(prompt.to_string());
}

fn apply_grok_turn(args: &mut Vec<String>, prompt: &str, session: Option<&TurnSession>) {
    remove_flag_with_value(
        args,
        &[
            "-p",
            "--single",
            "--output-format",
            "--resume",
            "-r",
            "--session-id",
            "-s",
            "--prompt-file",
            "--prompt-json",
        ],
    );
    args.push("--output-format".into());
    args.push("streaming-json".into());
    apply_session_flags(args, session, "--resume", "--session-id");
    args.push("-p".into());
    args.push(prompt.to_string());
}

fn apply_claude_turn(args: &mut Vec<String>, prompt: &str, session: Option<&TurnSession>) {
    remove_switch(
        args,
        &["-p", "--print", "--include-partial-messages", "--verbose"],
    );
    remove_flag_with_value(args, &["--output-format", "--resume", "-r", "--session-id"]);
    args.push("-p".into());
    args.push("--output-format".into());
    args.push("stream-json".into());
    args.push("--include-partial-messages".into());
    // Claude CLI 2.x: `-p --output-format=stream-json` exits unless `--verbose`.
    args.push("--verbose".into());
    apply_session_flags(args, session, "--resume", "--session-id");
    args.push(prompt.to_string());
}

fn apply_codex_turn(args: &mut Vec<String>, prompt: &str, session: Option<&TurnSession>) {
    if args.get(1).map(|s| s.as_str()) == Some("exec") {
        args.remove(1);
        if args.get(1).map(|s| s.as_str()) == Some("resume") {
            args.remove(1);
            if args.get(1).map(|s| !s.starts_with('-')).unwrap_or(false) {
                args.remove(1);
            }
        }
    }
    args.insert(1, "exec".into());
    if let Some(s) = session.filter(|s| s.resume && !s.id.is_empty()) {
        args.insert(2, "resume".into());
        args.insert(3, s.id.clone());
    }
    if !has_flag(args, &["--json"]) {
        args.push("--json".into());
    }
    args.push(prompt.to_string());
}

fn apply_session_flags(
    args: &mut Vec<String>,
    session: Option<&TurnSession>,
    resume_flag: &str,
    new_flag: &str,
) {
    let Some(session) = session else {
        return;
    };
    if session.id.is_empty() {
        return;
    }
    if session.resume {
        args.push(resume_flag.into());
    } else {
        args.push(new_flag.into());
    }
    args.push(session.id.clone());
}

fn inject_memory(program: &str, args: &mut Vec<String>, memory: &str) {
    let text = memory.trim();
    if text.is_empty() {
        return;
    }
    let text = &format!("{MEMORY_HEADING}\n{text}");
    match program {
        "grok" => append_flag_value(args, "--rules", text),
        "claude" => append_flag_value(args, "--append-system-prompt", text),
        "codex" => append_codex_config(args, "developer_instructions", text),
        _ => {}
    }
}

/// `-c key=value`. Repeating the same key appends to its value so team_rules
/// stay in front of memory, matching grok `--rules`.
fn append_codex_config(args: &mut Vec<String>, key: &str, extra: &str) {
    let prefix = format!("{key}=");
    let mut i = 1;
    while i < args.len() {
        if args[i] == "-c" && i + 1 < args.len() && args[i + 1].starts_with(&prefix) {
            let existing = args[i + 1][prefix.len()..].trim();
            if existing.is_empty() {
                args[i + 1] = format!("{prefix}{extra}");
            } else {
                args[i + 1] = format!("{prefix}{existing}\n\n{extra}");
            }
            return;
        }
        i += 1;
    }
    args.push("-c".into());
    args.push(format!("{prefix}{extra}"));
}

fn append_flag_value(args: &mut Vec<String>, flag: &str, extra: &str) {
    let mut i = 1;
    while i < args.len() {
        let a = &args[i];
        if a == flag {
            if i + 1 < args.len() && !args[i + 1].starts_with('-') {
                let existing = args[i + 1].trim();
                if existing.is_empty() {
                    args[i + 1] = extra.to_string();
                } else {
                    args[i + 1] = format!("{existing}\n\n{extra}");
                }
                return;
            }
            args.insert(i + 1, extra.to_string());
            return;
        }
        let prefix = format!("{flag}=");
        if a.starts_with(&prefix) {
            let existing = a[prefix.len()..].trim();
            if existing.is_empty() {
                args[i] = format!("{flag}={extra}");
            } else {
                args[i] = format!("{flag}={existing}\n\n{extra}");
            }
            return;
        }
        i += 1;
    }
    args.push(flag.into());
    args.push(extra.to_string());
}

pub fn format_roster(agents: &[AgentConfig]) -> String {
    let mut out = String::from("# Crew roster\n\n");
    out.push_str("Message a teammate with `crew tell <id> <text>`.\n");
    out.push_str("crew is on PATH; CREW_AGENT_ID is set in each agent session.\n");
    out.push_str("Rename yourself with `crew agent set --name \"New Name\"`.\n");
    out.push_str(
        "Schedule work with `crew routine add --name \"...\" --schedule \"0 8 * * 1-5\" --prompt \"...\"` (numeric 5-field cron); see yours with `crew routine list`, change one with `crew routine edit|remove|pause|resume <name>`.\n",
    );
    out.push_str(
        "Ask the human user to pick with `crew ask --question \"...\" --option A --option B`, or to type with `--input 아이디`. Do not use this to ask a teammate.\n\n",
    );
    out.push_str("## Agents\n\n");
    if agents.is_empty() {
        out.push_str("(none)\n");
    } else {
        let mut list: Vec<&AgentConfig> = agents.iter().collect();
        list.sort_by(|a, b| a.id.cmp(&b.id));
        for a in list {
            out.push_str(&format!("- `{}` — {}\n", a.id, a.display_name()));
            if let Some(title) = a.title.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
                out.push_str(&format!("  title: {title}\n"));
            }
        }
    }
    out
}

pub fn write_roster(agents: &[AgentConfig]) -> anyhow::Result<()> {
    paths::ensure_home()?;
    fs::write(paths::roster_path(), format_roster(agents))?;
    Ok(())
}

fn strip_resume_flags(program: &str, args: &mut Vec<String>) {
    match program {
        "grok" => {
            remove_switch(args, &["--continue", "-c", "--fork-session"]);
            remove_flag_with_value(args, &["--resume", "-r", "--session-id", "-s"]);
        }
        "claude" => {
            remove_switch(args, &["--continue", "--fork-session"]);
            remove_flag_with_value(args, &["--resume", "-r", "--session-id"]);
        }
        "codex" => {
            if args.get(1).map(|s| s.as_str()) == Some("resume") {
                args.remove(1);
            }
        }
        // A global "latest session" flag would continue some other bot's chat.
        "gemini" => {
            remove_flag_with_value(args, &["--resume", "--session-id", "--session-file"]);
        }
        "agy" => {
            remove_switch(args, &["--continue", "-c"]);
            remove_flag_with_value(args, &["--conversation"]);
        }
        "copilot" => {
            remove_switch(args, &["--continue"]);
            remove_flag_with_value(args, &["--resume", "--session-id"]);
        }
        "opencode" => {
            remove_switch(args, &["--continue", "-c", "--fork"]);
            remove_flag_with_value(args, &["--session", "-s"]);
        }
        _ => {}
    }
}

fn remove_switch(args: &mut Vec<String>, names: &[&str]) {
    let mut i = 1;
    while i < args.len() {
        if names.iter().any(|n| args[i] == *n) {
            args.remove(i);
        } else {
            i += 1;
        }
    }
}

fn remove_flag_with_value(args: &mut Vec<String>, names: &[&str]) {
    let mut i = 1;
    while i < args.len() {
        let a = &args[i];
        if names.iter().any(|n| a == n) {
            args.remove(i);
            if i < args.len() && !args[i].starts_with('-') {
                args.remove(i);
            }
        } else if names.iter().any(|n| a.starts_with(&format!("{n}="))) {
            args.remove(i);
        } else {
            i += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(cmd: &[&str], model: Option<&str>, effort: Option<Effort>) -> AgentConfig {
        let mut c = AgentConfig::new(
            "t".into(),
            "T".into(),
            cmd.iter().map(|s| s.to_string()).collect(),
            None,
        );
        c.model = model.map(|s| s.to_string());
        c.effort = effort;
        c
    }

    fn cfg_persona(cmd: &[&str], role: Option<&str>, description: Option<&str>) -> AgentConfig {
        let mut c = AgentConfig::new(
            "t".into(),
            "T".into(),
            cmd.iter().map(|s| s.to_string()).collect(),
            None,
        );
        c.role = role.map(|s| s.to_string());
        c.description = description.map(|s| s.to_string());
        c
    }

    fn rules_after<'a>(argv: &'a [String], flag: &str) -> &'a str {
        let i = argv.iter().position(|a| a == flag).expect(flag);
        argv.get(i + 1).map(|s| s.as_str()).unwrap_or("")
    }

    fn codex_config_after<'a>(argv: &'a [String], key: &str) -> &'a str {
        let prefix = format!("{key}=");
        argv.windows(2)
            .find(|w| w[0] == "-c" && w[1].starts_with(&prefix))
            .map(|w| &w[1][prefix.len()..])
            .unwrap_or("")
    }

    #[test]
    fn load_accepts_an_empty_roster() {
        paths::testing::with_home("config-empty-roster", || {
            paths::ensure_home().expect("home");
            fs::write(paths::agents_path(), r#"{"agents":[],"channels":[]}"#).expect("write");
            let cfg = Config::load().expect("an empty roster is not an error");
            assert!(cfg.agents.is_empty());
        });
    }

    #[test]
    fn load_accepts_a_config_that_omits_the_roster() {
        paths::testing::with_home("config-no-roster-key", || {
            paths::ensure_home().expect("home");
            fs::write(paths::agents_path(), r#"{"channels":[]}"#).expect("write");
            let cfg = Config::load().expect("a missing roster key is an empty roster");
            assert!(cfg.agents.is_empty());
        });
    }

    /// The offline CLI arms save straight after loading. Defaulting a config
    /// this binary cannot read would write that empty default over the roster.
    #[test]
    fn load_refuses_an_unreadable_config() {
        paths::testing::with_home("config-corrupt", || {
            paths::ensure_home().expect("home");
            fs::write(paths::agents_path(), "{\"agents\": [,]}").expect("write");
            let err = Config::load().expect_err("a corrupt config is an error");
            assert!(err.to_string().contains("agents.json"), "{err:#}");
        });
    }

    #[test]
    fn grok_gets_real_model_and_effort_flags() {
        let argv = cfg(
            &["grok", "--always-approve"],
            Some("grok-4"),
            Some(Effort::High),
        )
        .spawn_cmd(false);
        assert_eq!(argv[0], "grok");
        assert!(argv.contains(&"--always-approve".to_string()));
        assert!(argv.contains(&"--model".to_string()));
        assert!(argv.contains(&"grok-4".to_string()));
        assert!(argv.contains(&"--reasoning-effort".to_string()));
        assert!(argv.contains(&"high".to_string()));
        assert!(argv.contains(&"--rules".to_string()));
        assert!(rules_after(&argv, "--rules").contains("crew tell"));
    }

    #[test]
    fn claude_gets_real_model_and_effort_flags() {
        let argv = cfg(&["claude"], Some("sonnet"), Some(Effort::Low)).spawn_cmd(false);
        assert_eq!(argv[0], "claude");
        assert!(argv.contains(&"--model".to_string()));
        assert!(argv.contains(&"sonnet".to_string()));
        assert!(argv.contains(&"--effort".to_string()));
        assert!(argv.contains(&"low".to_string()));
        assert!(argv.contains(&"--append-system-prompt".to_string()));
    }

    #[test]
    fn codex_uses_model_flag_and_config_override() {
        let argv = cfg(&["codex", "--yolo"], Some("o3"), Some(Effort::Medium)).spawn_cmd(false);
        assert_eq!(argv[0], "codex");
        assert!(argv.contains(&"--yolo".to_string()));
        assert!(argv.contains(&"--model".to_string()));
        assert!(argv.contains(&"o3".to_string()));
        assert!(argv
            .windows(2)
            .any(|w| { w[0] == "-c" && w[1] == "model_reasoning_effort=medium" }));
        assert!(codex_config_after(&argv, "developer_instructions").contains("crew tell"));
    }

    #[test]
    fn unknown_cli_does_not_invent_flags() {
        let argv = cfg(&["cat"], Some("whatever"), Some(Effort::High)).spawn_cmd(false);
        assert_eq!(argv, vec!["cat"]);
    }

    #[test]
    fn grok_and_claude_are_headless_cat_stays_pty() {
        assert!(!cfg(&["grok"], None, None).uses_pty());
        assert!(!cfg(&["/opt/homebrew/bin/claude"], None, None).uses_pty());
        assert!(!cfg(&["codex", "--yolo"], None, None).uses_pty());
        assert!(cfg(&["cat"], None, None).uses_pty());
    }

    #[test]
    fn grok_turn_uses_real_headless_flags() {
        let c = cfg(
            &["grok", "--always-approve"],
            Some("grok-4"),
            Some(Effort::High),
        );
        let argv = c.turn_cmd("hello", None, &[], "");
        assert_eq!(argv[0], "grok");
        assert!(argv.contains(&"--always-approve".to_string()));
        assert!(argv.contains(&"--output-format".to_string()));
        assert!(argv.contains(&"streaming-json".to_string()));
        let p = argv.iter().position(|a| a == "-p").expect("-p");
        assert_eq!(argv[p + 1], "hello");
        assert!(!argv.iter().any(|a| a == "--resume" || a == "--session-id"));
        let resume = TurnSession {
            id: "11111111-2222-4333-8444-555555555555".into(),
            resume: true,
        };
        let argv = c.turn_cmd("hi", Some(&resume), &[], "");
        assert!(argv.contains(&"--resume".to_string()));
        assert!(argv.contains(&resume.id));
        assert!(!argv.contains(&"--session-id".to_string()));
        let fresh = TurnSession {
            id: resume.id.clone(),
            resume: false,
        };
        let argv = c.turn_cmd("hi", Some(&fresh), &[], "");
        assert!(argv.contains(&"--session-id".to_string()));
        assert!(!argv.contains(&"--resume".to_string()));
    }

    #[test]
    fn claude_turn_uses_print_and_stream_json() {
        let c = cfg(&["claude", "--dangerously-skip-permissions"], None, None);
        let argv = c.turn_cmd("hello", None, &[], "");
        assert!(argv.contains(&"-p".to_string()));
        assert!(argv.contains(&"--output-format".to_string()));
        assert!(argv.contains(&"stream-json".to_string()));
        assert!(argv.contains(&"--include-partial-messages".to_string()));
        assert!(argv.contains(&"--verbose".to_string()));
        assert_eq!(argv.last().map(|s| s.as_str()), Some("hello"));
        let resume = TurnSession {
            id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee".into(),
            resume: true,
        };
        let argv = c.turn_cmd("next", Some(&resume), &[], "");
        assert!(argv.contains(&"--resume".to_string()));
        assert_eq!(argv.last().map(|s| s.as_str()), Some("next"));
    }

    #[test]
    fn codex_turn_inserts_exec_json_and_resume() {
        let c = cfg(&["codex", "--yolo"], None, None);
        let argv = c.turn_cmd("hello", None, &[], "");
        assert_eq!(argv[0], "codex");
        assert_eq!(argv[1], "exec");
        assert!(argv.contains(&"--yolo".to_string()));
        assert!(argv.contains(&"--json".to_string()));
        assert_eq!(argv.last().map(|s| s.as_str()), Some("hello"));
        let resume = TurnSession {
            id: "0199a213-81c0-7800-8aa1-bbab2a035a53".into(),
            resume: true,
        };
        let argv = c.turn_cmd("again", Some(&resume), &[], "");
        assert_eq!(argv[1], "exec");
        assert_eq!(argv[2], "resume");
        assert_eq!(argv[3], resume.id);
        assert_eq!(argv.last().map(|s| s.as_str()), Some("again"));
        assert!(codex_config_after(&argv, "developer_instructions").contains("crew tell"));
    }

    #[test]
    fn gemini_turn_is_text_and_does_not_keep_a_session_id() {
        let c = cfg(&["gemini"], Some("gemini-2.5-flash"), Some(Effort::High));
        let session = TurnSession {
            id: "11111111-2222-4333-8444-555555555555".into(),
            resume: true,
        };
        let argv = c.turn_cmd("hello", Some(&session), &[], "");
        assert_eq!(argv[0], "gemini");
        assert!(argv.windows(2).any(|w| w[0] == "--approval-mode" && w[1] == "yolo"));
        assert!(argv.windows(2).any(|w| w[0] == "--output-format" && w[1] == "text"));
        assert!(argv.windows(2).any(|w| w[0] == "--model" && w[1] == "gemini-2.5-flash"));
        assert!(!argv.iter().any(|a| a == "--effort" || a == "high"));
        let p = argv.iter().position(|a| a == "-p").expect("-p");
        assert!(argv[p + 1].contains("crew tell"));
        assert!(argv[p + 1].ends_with("hello"));
        assert!(!argv.iter().any(|a| a.contains(&session.id)));
    }

    #[test]
    fn agy_turn_prints_text_with_model_and_effort() {
        let c = cfg(
            &["agy", "--dangerously-skip-permissions"],
            Some("gemini-3.8-flash-low"),
            Some(Effort::Low),
        );
        let argv = c.turn_cmd("hello", None, &[], "");
        assert_eq!(argv[0], "agy");
        assert!(argv.contains(&"--dangerously-skip-permissions".to_string()));
        assert!(argv.windows(2).any(|w| w[0] == "--output-format" && w[1] == "text"));
        assert!(argv.windows(2).any(|w| w[0] == "--model" && w[1] == "gemini-3.8-flash-low"));
        assert!(argv.windows(2).any(|w| w[0] == "--effort" && w[1] == "low"));
        let p = argv.iter().position(|a| a == "-p").expect("-p");
        assert!(argv[p + 1].ends_with("hello"));
        assert!(!argv.iter().any(|a| a == "--continue" || a == "--conversation"));
    }

    #[test]
    fn copilot_turn_is_silent_and_does_not_ask() {
        let c = cfg(&["copilot"], Some("gpt-6"), None);
        let argv = c.turn_cmd("hello", None, &[], "");
        assert_eq!(argv[0], "copilot");
        assert!(argv.contains(&"--allow-all".to_string()));
        assert!(argv.contains(&"--no-ask-user".to_string()));
        assert!(argv.contains(&"-s".to_string()));
        assert!(argv.windows(2).any(|w| w[0] == "--model" && w[1] == "gpt-6"));
        let p = argv.iter().position(|a| a == "-p").expect("-p");
        assert!(argv[p + 1].ends_with("hello"));
        assert!(!argv.iter().any(|a| a == "--resume" || a == "--session-id"));
    }

    #[test]
    fn opencode_turn_runs_auto_and_puts_effort_on_the_model() {
        let c = cfg(&["opencode"], Some("anthropic/claude"), Some(Effort::High));
        let argv = c.turn_cmd("hello", None, &[], "");
        assert_eq!(argv[0], "opencode");
        assert_eq!(argv[1], "run");
        assert!(argv.contains(&"--auto".to_string()));
        assert!(argv.windows(2).any(|w| w[0] == "-m" && w[1] == "anthropic/claude#high"));
        assert!(argv.last().unwrap().ends_with("hello"));
        assert!(!argv.iter().any(|a| a == "-p" || a == "-c" || a == "--continue"));
    }

    #[test]
    fn opencode_does_not_treat_password_flag_as_the_prompt() {
        let c = cfg(&["opencode", "run", "-p", "secret", "--auto"], None, None);
        let argv = c.turn_cmd("hello", None, &[], "");
        let p = argv.iter().position(|a| a == "-p").expect("-p");
        assert_eq!(argv[p + 1], "secret");
        assert!(argv.last().unwrap().ends_with("hello"));
    }

    #[test]
    fn headless_command_appends_the_message_and_cat_does_not() {
        let cat = cfg(&["cat"], Some("whatever"), Some(Effort::High));
        assert!(cat.uses_pty());
        assert!(!cat.prompt_mode());
        assert_eq!(cat.turn_cmd("hello", None, &[], "note"), vec!["cat"]);

        let mut custom = cfg(&["my-ai", "--fast"], None, Some(Effort::High));
        custom.headless = true;
        assert!(!custom.uses_pty());
        assert!(custom.prompt_mode());
        let argv = custom.turn_cmd("hello", None, &[], "note");
        assert_eq!(argv[0], "my-ai");
        assert_eq!(argv[1], "--fast");
        let prompt = argv.last().unwrap();
        assert!(prompt.contains("crew tell"));
        assert!(prompt.contains("# Your memory\nnote"));
        assert!(prompt.ends_with("hello"));
        assert!(!argv.iter().any(|a| a == "--model" || a == "--effort"));
    }

    #[test]
    fn headless_flag_does_not_change_a_grok_turn() {
        let mut c = cfg(&["grok", "--always-approve"], None, None);
        c.headless = true;
        assert!(!c.prompt_mode());
        assert!(!c.uses_pty());
        let argv = c.turn_cmd("hello", None, &[], "");
        let p = argv.iter().position(|a| a == "-p").expect("-p");
        assert_eq!(argv[p + 1], "hello");
    }

    #[test]
    fn split_cmd_keeps_quoted_spaces() {
        assert_eq!(
            split_cmd(r#"my-ai --say "hello world""#).unwrap(),
            vec!["my-ai", "--say", "hello world"]
        );
        assert!(split_cmd("   ").is_err());
        assert!(split_cmd("\"open").is_err());
        assert_eq!(
            split_cmd(r"'C:\tools\ai'").unwrap(),
            vec![r"C:\tools\ai".to_string()]
        );
        assert_eq!(
            split_cmd(r#""C:\\tools\\ai""#).unwrap(),
            vec![r"C:\tools\ai".to_string()]
        );
        assert_eq!(split_cmd(r"my-ai foo\").unwrap(), vec!["my-ai", r"foo\"]);
        assert!(!headless_cmd(true, &["grok".into()]));
        assert!(headless_cmd(true, &["my-ai".into()]));
        assert!(!headless_cmd(false, &["my-ai".into()]));
    }

    #[test]
    fn agent_without_headless_field_stays_a_terminal() {
        let raw = r#"{"id":"a","name":"A","cmd":["cat"],"routines":[]}"#;
        let back: AgentConfig = serde_json::from_str(raw).unwrap();
        assert!(!back.headless);
        assert!(back.uses_pty());
    }

    #[test]
    fn reset_strips_grok_resume() {
        let argv = cfg(&["grok", "--always-approve", "--continue"], None, None).spawn_cmd(true);
        assert!(!argv.iter().any(|a| a == "--continue"));
        assert_eq!(argv[0], "grok");
        assert!(argv.contains(&"--always-approve".to_string()));
        let argv = cfg(&["grok", "-r", "abc", "--always-approve"], None, None).spawn_cmd(true);
        assert!(!argv.iter().any(|a| a == "-r" || a == "abc"));
    }

    #[test]
    fn does_not_duplicate_existing_flags() {
        let argv = cfg(&["grok", "--model", "already"], Some("ignored"), None).spawn_cmd(false);
        let models: Vec<_> = argv
            .iter()
            .enumerate()
            .filter(|(_, a)| *a == "--model")
            .collect();
        assert_eq!(models.len(), 1);
        assert_eq!(argv[models[0].0 + 1], "already");
    }

    #[test]
    fn routines_roundtrip() {
        let mut c = AgentConfig::new("a".into(), "A".into(), vec!["cat".into()], None);
        c.routines
            .push(Routine::new("morning".into(), "0 9 * * *".into(), "stand up".into()).unwrap());
        let raw = serde_json::to_string(&c).unwrap();
        let back: AgentConfig = serde_json::from_str(&raw).unwrap();
        assert_eq!(back.routines.len(), 1);
        assert_eq!(back.routines[0].name, "morning");
        assert!(back.routines[0].enabled);
        c.routines.clear();
        let raw = serde_json::to_string_pretty(&c).unwrap();
        assert!(raw.contains("\"routines\": []"), "{raw}");
    }

    #[test]
    fn team_rules_omit_role_and_description() {
        let argv = cfg_persona(
            &["grok", "--always-approve"],
            Some("PM"),
            Some("Keep replies short."),
        )
        .spawn_cmd(false);
        let rules = rules_after(&argv, "--rules");
        assert!(!rules.contains("PM"));
        assert!(!rules.contains("Keep replies short."));
        assert!(rules.contains("You are Crew agent `t` (T)."));
        assert!(rules.contains("crew tell"));
        assert!(rules.contains("[crew from:"));
    }

    #[test]
    fn new_bot_ask_is_one_question_in_the_ui_language() {
        let ko = new_bot_ask(false);
        assert!(ko.contains("what work or role"));
        assert!(ko.contains("one short message"));
        assert!(ko.contains("Do not ask permission"));
        assert!(ko.contains("do not use tools"));
        assert!(ko.contains("Write in Korean."));
        assert!(new_bot_ask(true).contains("Write in English."));
    }

    #[test]
    fn claude_appends_system_prompt() {
        let argv = cfg_persona(&["claude"], Some("reviewer"), None).spawn_cmd(false);
        assert_eq!(argv[0], "claude");
        assert_eq!(argv[1], "--append-system-prompt");
        assert!(!argv[2].contains("reviewer"));
        assert!(argv[2].contains("crew tell"));
    }

    #[test]
    fn unknown_cli_skips_persona_flags() {
        let cat = cfg_persona(&["cat"], Some("x"), Some("y")).spawn_cmd(false);
        assert_eq!(cat, vec!["cat"]);
    }

    #[test]
    fn codex_gets_developer_instructions() {
        let argv = cfg_persona(&["codex", "--yolo"], Some("reviewer"), None).spawn_cmd(false);
        assert_eq!(argv[0], "codex");
        assert!(argv.contains(&"--yolo".to_string()));
        let text = codex_config_after(&argv, "developer_instructions");
        assert!(text.contains("You are Crew agent `t`"));
        assert!(!text.contains("reviewer"));
        assert!(text.contains("crew tell"));
        assert!(text.contains("crew agent set --name"));
        assert!(text.contains("crew routine add"));
    }

    #[test]
    fn grok_team_rules_keep_existing_text_and_skip_the_roster() {
        let mut alpha = AgentConfig::new(
            "alpha".into(),
            "Alpha".into(),
            vec![
                "grok".into(),
                "--always-approve".into(),
                "--rules".into(),
                "keep this".into(),
            ],
            None,
        );
        alpha.role = Some("PM".into());
        let mut beta = AgentConfig::new("beta".into(), "Beta".into(), vec!["cat".into()], None);
        beta.role = Some("reviewer".into());
        let argv = alpha.spawn_cmd_with(false, &[alpha.clone(), beta]);
        let rules = rules_after(&argv, "--rules");
        assert!(rules.contains("keep this"));
        assert!(rules.contains("You are Crew agent `alpha` (Alpha)."));
        assert!(!rules.contains("PM"));
        // The live list is composed each turn, so the spawn prompt must not snapshot it.
        assert!(!rules.contains("- beta — Beta\n"));
        assert!(rules.contains("starts with `Shared memory`"));
        assert!(!rules.contains("reviewer"));
        assert!(!rules.contains("alpha — Alpha"));
        assert!(rules.contains("crew tell"));
        assert!(rules.contains("@<id>"));
    }

    #[test]
    fn roster_markdown_lists_agents() {
        let mut a = AgentConfig::new("alpha".into(), "Alpha".into(), vec!["cat".into()], None);
        a.role = Some("PM".into());
        let md = format_roster(&[a]);
        assert!(md.contains("`alpha` — Alpha\n"));
        assert!(!md.contains("PM"));
        assert!(md.contains("crew tell"));
        assert!(md.contains("crew agent set --name"));
        assert!(md.contains("crew routine add"));
        assert!(md.contains("crew ask --question"));
        assert!(md.contains("--input"));
        assert!(!md.contains("channel"));
    }

    #[test]
    fn old_channel_field_is_ignored() {
        let raw = r#"{"agents":[{"id":"a","name":"A","cmd":["cat"]}],"channels":[{"id":"room","name":"Room","members":["a"]}]}"#;
        let cfg: Config = serde_json::from_str(raw).unwrap();
        assert_eq!(cfg.agents.len(), 1);
        assert_eq!(cfg.agents[0].id, "a");
        let saved = serde_json::to_string(&cfg).unwrap();
        assert!(!saved.contains("channels"));
    }

    #[test]
    fn cli_presets() {
        assert_eq!(
            AgentCli::Grok.default_cmd(),
            vec!["grok", "--always-approve"]
        );
        assert_eq!(
            AgentCli::Claude.default_cmd(),
            vec!["claude", "--dangerously-skip-permissions"]
        );
        assert_eq!(AgentCli::Codex.default_cmd(), vec!["codex", "--yolo"]);
    }

    #[test]
    fn paused_or_already_run_is_not_due() {
        let now = cron::LocalTime {
            year: 2026,
            month: 8,
            day: 28,
            hour: 9,
            minute: 0,
            wday: 5,
        };
        let mut r = Routine::new("ping".into(), "* * * * *".into(), "hi".into()).unwrap();
        assert!(r.is_due(&now));
        r.last_run = Some(now.minute_key());
        assert!(!r.is_due(&now));
        r.last_run = None;
        r.enabled = false;
        assert!(!r.is_due(&now));
    }

    #[test]
    fn default_add_cwd_is_dedicated() {
        assert_eq!(default_add_cwd("demo-claude"), "/tmp/crew-demo/demo-claude");
    }

    #[test]
    fn default_cwd_prefers_agent_path() {
        let mut a = AgentConfig::new("x".into(), "X".into(), vec!["cat".into()], None);
        assert_eq!(Config::default_cwd(&a), PathBuf::from("/tmp/crew-demo"));
        a.cwd = Some("".into());
        assert_eq!(Config::default_cwd(&a), PathBuf::from("/tmp/crew-demo"));
        a.cwd = Some("/tmp/crew-work/x".into());
        assert_eq!(Config::default_cwd(&a), PathBuf::from("/tmp/crew-work/x"));
    }

    #[test]
    fn slug_id_ascii_lowercase_hyphens() {
        assert_eq!(slug_id("Frontend Bot"), "frontend-bot");
        assert_eq!(slug_id("My_Bot"), "my-bot");
        assert_eq!(slug_id("  -- Hello --  "), "hello");
        assert_eq!(slug_id("프론트"), "bot");
        assert_eq!(slug_id("PM-2"), "pm-2");
    }

    #[test]
    fn a_minted_id_leads_with_the_name_and_ends_with_the_moment() {
        let t = |ms| std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms);
        let none: [&str; 0] = [];
        assert_eq!(
            agent_id_at("Grok", t(1_788_000_000_000), none),
            "grok-mte919mo"
        );
        // Two names with no ASCII both slug to `bot`; the stamp is what keeps
        // them apart, and it is why neither can inherit a deleted bot's id.
        assert_eq!(
            agent_id_at("춘식이", t(1_788_000_000_000), none),
            "bot-mte919mo"
        );
        assert_ne!(
            agent_id_at("춘식이", t(1_788_000_000_000), none),
            agent_id_at("죠르디", t(1_788_000_000_001), none),
        );
        // A clock before the epoch must not stamp every bot the same.
        assert_eq!(
            agent_id_at("Grok", std::time::UNIX_EPOCH, none),
            "grok-epoch"
        );
    }

    #[test]
    fn a_second_bot_in_one_millisecond_walks_the_suffix() {
        let t = std::time::UNIX_EPOCH + std::time::Duration::from_millis(1_788_000_000_000);
        let first = agent_id_at("Grok", t, [] as [&str; 0]);
        let second = agent_id_at("Grok", t, [first.as_str()]);
        assert_eq!(second, format!("{first}-2"));
        let third = agent_id_at("Grok", t, [first.as_str(), second.as_str()]);
        assert_eq!(third, format!("{first}-3"));
    }

    #[test]
    fn an_id_the_filesystem_would_fold_is_refused() {
        assert!(valid_agent_id("bot-mte919mo"));
        assert!(valid_agent_id("frontend_bot"));
        assert!(!valid_agent_id(""));
        // macOS folds case, so these are two agents and one transcript file.
        assert!(!valid_agent_id("Grok"));
        // `transcripts/<id>.jsonl` has to fit in a 255-byte name.
        assert!(!valid_agent_id(&"a".repeat(65)));
        // `safe_agent_id` folds both of these to `___`, so they would share
        // every per-id file.
        assert!(!valid_agent_id("춘식이"));
        assert!(!valid_agent_id("죠르디"));
        // A colon is not in the id alphabet.
        assert!(!valid_agent_id("ch:general"));
    }

    #[test]
    fn clone_agent_name_appends_copy() {
        assert_eq!(clone_agent_name("Grok", None), "Grok 복사본");
        assert_eq!(clone_agent_name("Grok", Some("Twin")), "Twin");
        assert_eq!(clone_agent_name("Grok", Some("  ")), "Grok 복사본");
        assert_eq!(clone_agent_name("", None), "복사본");
    }

    #[test]
    fn duplicate_agent_fresh_id_cwd_routines() {
        let mut src = AgentConfig::new(
            "grok".into(),
            "Grok".into(),
            vec!["grok".into(), "--always-approve".into()],
            Some("/tmp/crew-demo/grok".into()),
        );
        src.title = Some("Lead".into());
        src.role = Some("PM".into());
        src.description = Some("does things".into());
        src.model = Some("grok-4".into());
        src.effort = Some(Effort::High);
        src.avatar = Some("/tmp/avatars/grok.png".into());
        src.avatar_shape = Some(AvatarShape::Teardrop);
        src.avatar_color = Some("#ff6a00".into());
        src.routines
            .push(Routine::new("ping".into(), "0 9 * * *".into(), "hi".into()).unwrap());
        let rid = src.routines[0].id.clone();
        let dup = src.duplicate(None, ["grok"]);
        // The clone is a new bot, so it gets a minted id, not the next suffix.
        assert!(dup.id.starts_with("grok-"), "{}", dup.id);
        assert_ne!(dup.id, "grok");
        assert_eq!(dup.name, "Grok 복사본");
        // The clone's folder follows its own id, so it never lands in the
        // folder a deleted bot left behind. Pinned by value, not re-derived
        // from `default_add_cwd`, which would hold for any id at all.
        let cwd = dup.cwd.as_deref().expect("clone has a folder");
        assert!(cwd.starts_with("/tmp/crew-demo/grok-"), "{cwd}");
        assert!(cwd.ends_with(&dup.id), "{cwd}");
        assert_ne!(Some(cwd), src.cwd.as_deref());
        assert_eq!(dup.title.as_deref(), Some("Lead"));
        assert_eq!(dup.role.as_deref(), Some("PM"));
        assert_eq!(dup.description.as_deref(), Some("does things"));
        assert_eq!(dup.cmd, src.cmd);
        assert_eq!(dup.model.as_deref(), Some("grok-4"));
        assert_eq!(dup.effort, Some(Effort::High));
        assert_eq!(dup.routines.len(), 1);
        assert_ne!(dup.routines[0].id, rid);
        assert_eq!(dup.routines[0].name, "ping");
        assert_eq!(dup.routines[0].prompt, "hi");
        assert!(dup.avatar.is_none());
        assert_eq!(dup.avatar_shape, Some(AvatarShape::Teardrop));
        assert_eq!(dup.avatar_color.as_deref(), Some("#ff6a00"));
        // Same display name as the source is allowed; the id is still its own.
        // `clone_agent` passes the live roster, so the first clone is in it.
        let named = src.duplicate(Some("Grok"), ["grok", dup.id.as_str()]);
        assert_ne!(named.id, "grok");
        assert_ne!(named.id, dup.id);
        assert_eq!(named.name, "Grok");
    }

    #[test]
    fn parse_hex_color_normalizes() {
        assert_eq!(parse_hex_color("#ff6a00").unwrap(), "#ff6a00");
        assert_eq!(parse_hex_color("FF6A00").unwrap(), "#ff6a00");
        assert_eq!(parse_hex_color(" #f60 ").unwrap(), "#ff6600");
        assert!(parse_hex_color("").is_err());
        assert!(parse_hex_color("blue").is_err());
        assert!(parse_hex_color("#gg0000").is_err());
    }

    #[test]
    fn avatar_shape_roundtrip() {
        let raw = serde_json::to_string(&AvatarShape::RoundedSquare).unwrap();
        assert_eq!(raw, "\"rounded-square\"");
        let back: AvatarShape = serde_json::from_str(&raw).unwrap();
        assert_eq!(back, AvatarShape::RoundedSquare);
        assert_eq!(AvatarShape::from_key("rounded_square").unwrap(), back);
        assert_eq!(AvatarShape::from_key("star").unwrap(), AvatarShape::Star);
        assert_eq!(
            AvatarShape::from_key("droplet").unwrap(),
            AvatarShape::Teardrop
        );
        for shape in AVATAR_SHAPES {
            assert_eq!(AvatarShape::from_key(shape.as_str()).unwrap(), *shape);
            let raw = serde_json::to_string(shape).unwrap();
            let back: AvatarShape = serde_json::from_str(&raw).unwrap();
            assert_eq!(back, *shape);
        }
        assert_eq!(
            AvatarShape::from_key("semi_circle").unwrap(),
            AvatarShape::SemiCircle
        );
        assert_eq!(
            AvatarShape::from_key("ghostish").unwrap(),
            AvatarShape::Ghostish
        );
        assert!(AvatarShape::from_key("banana").is_err());
    }

    #[test]
    fn a_minted_id_always_passes_the_id_rule() {
        let long = "Browser QA for the checkout flow regression suite and payment edge cases";
        let id = unique_agent_id(long, Vec::<&str>::new());
        assert!(valid_agent_id(&id), "{id}");
        let taken: Vec<String> = (2..40)
            .map(|n| format!("{id}-{n}"))
            .chain([id.clone()])
            .collect();
        let suffixed = unique_agent_id(long, taken);
        assert!(valid_agent_id(&suffixed), "{suffixed}");
    }

    #[test]
    fn roster_update_lists_other_teammates() {
        let mut alpha = AgentConfig::new("alpha".into(), "Alpha".into(), vec!["cat".into()], None);
        alpha.role = Some("PM".into());
        let mut beta = AgentConfig::new("beta".into(), "Beta".into(), vec!["cat".into()], None);
        beta.role = Some("reviewer".into());
        let text = roster_update_text(&alpha, &[alpha.clone(), beta.clone()]);
        assert!(text.contains("You are `alpha` (Alpha)."));
        assert!(text.contains("beta — Beta"));
        assert!(!text.contains("reviewer"));
        assert!(!text.contains("alpha — Alpha"));
        assert!(text.contains("crew tell"));
        assert!(text.contains("@<id>"));
        let solo = roster_update_text(&alpha, &[alpha.clone()]);
        assert!(solo.contains("Teammates: (none)"));
        let note = shared_memory_note(&alpha, &[alpha.clone(), beta.clone()], "harbor is closed");
        assert!(note.starts_with("[crew system] Shared memory."));
        assert!(note.contains("You are `alpha` (Alpha)."));
        assert!(note.contains("Teammates: beta — Beta."));
        assert!(note.contains("# Notes\nharbor is closed\n"));
        assert!(note.contains("Do not answer this note."));
        assert!(!note.contains("crew tell"));
        assert!(!note.contains("reviewer"));
        assert!(!note.contains("alpha — Alpha"));
        let empty = shared_memory_note(&alpha, &[alpha.clone()], "");
        assert!(empty.contains("# Notes\n(none)\n"));
        let user = shared_memory_body(None, &[alpha.clone(), beta], "");
        assert!(user.contains("alpha — Alpha"));
        assert!(user.contains("beta — Beta"));
        assert!(!user.contains("You are"));
    }

    #[test]
    fn mentioned_teammates_from_at_tokens() {
        let alpha = AgentConfig::new("alpha".into(), "Alpha".into(), vec!["cat".into()], None);
        let choon = AgentConfig::new("choonsik".into(), "춘식이".into(), vec!["cat".into()], None);
        let beta = AgentConfig::new("beta".into(), "Beta".into(), vec!["cat".into()], None);
        let roster = [alpha.clone(), choon, beta];

        // An id ends where a Korean particle starts.
        assert_eq!(
            mentioned_teammate_ids("@choonsik에게 안녕", "alpha", &roster),
            vec!["choonsik"]
        );
        assert_eq!(
            mentioned_teammate_ids("ask @beta, then @choonsik.", "alpha", &roster),
            vec!["beta", "choonsik"]
        );
        // A name is for the screen; the composer sends it as an id.
        assert_eq!(
            mentioned_teammate_ids("@춘식이 안녕", "alpha", &roster),
            Vec::<String>::new()
        );
        // An id has to end the word, so a domain or a path names no one.
        assert_eq!(
            mentioned_teammate_ids("see @beta.com and @beta/cli, @beta's", "alpha", &roster),
            Vec::<String>::new()
        );
        assert_eq!(
            mentioned_teammate_ids("@beta: hi", "alpha", &roster),
            vec!["beta"]
        );
        assert_eq!(
            mentioned_teammate_ids("hello @nobody and @alpha", "alpha", &roster),
            Vec::<String>::new()
        );
        assert_eq!(
            mentioned_teammate_ids("email me@beta.com", "alpha", &roster),
            Vec::<String>::new()
        );

        let hinted = with_mention_hint("ping @Beta please", "alpha", &roster);
        assert!(hinted.starts_with("ping @Beta please"));
        assert!(hinted.contains("[crew system]"));
        assert!(hinted.contains("beta"));
        assert!(hinted.contains("already messaged teammates"));
        assert_eq!(with_mention_hint("no mentions", "alpha", &roster), "no mentions");
        let quoted = "[crew reply:1-2 from:beta]\nask @beta later\n\njust thinking";
        assert_eq!(with_mention_hint(quoted, "alpha", &roster), quoted);
        let body_mention = "[crew reply:1-2 from:alice]\nhello\n\nask @beta";
        assert!(with_mention_hint(body_mention, "alpha", &roster).contains("[crew system]"));
    }

    #[test]
    fn team_rules_explain_at_mentions() {
        let alpha = AgentConfig::new("alpha".into(), "Alpha".into(), vec!["cat".into()], None);
        let beta = AgentConfig::new("beta".into(), "Beta".into(), vec!["cat".into()], None);
        let rules = team_rules(&alpha, &[alpha.clone(), beta]);
        assert!(rules.contains("@<id>"));
        assert!(rules.contains("naming a teammate for YOU"));
        assert!(rules.contains("crew tell"));
        assert!(rules.contains("Do not ask the user to switch chats"));
        assert!(rules.contains("[crew handoff from:"));
        assert!(rules.contains("[crew reply:"));
        assert!(rules.contains("start each sentence on a new line, with no blank line between them"));
        assert!(rules.contains("Keep list items, options, tables, headings and code as they are"));
        assert!(rules.contains("crew agent set --name"));
        assert!(rules.contains(
            "crew agent add --cli grok|claude|codex|agy|gemini|copilot|opencode --name"
        ));
        assert!(rules.contains(
            "crew agent add --headless --name \"Name\" --cmd <program> [args]"
        ));
        assert!(rules.contains("`--cmd` has to be last"));
        assert!(!rules.contains("--cmd <program> [args] --name"));
        assert!(rules.contains("Without `--headless`, an unknown command stays a terminal"));
        assert!(rules.contains("prints `ok <id>`"));
        assert!(rules.contains("crew group add --name"));
        assert!(rules.contains("crew group memory append <<'EOF'"));
        assert!(rules.contains("crew group memory set <<'EOF'"));
        assert!(rules.contains("repeating `--bot <id>`"));
        assert!(rules.contains("`crew group list` prints each group's id, name, and bots"));
        assert!(rules.contains("Do not only claim you created a bot or a group"));
        assert!(!rules.contains("crew channel"));
        assert!(rules.contains("in the order they were written"));
        assert!(rules.contains("after `crew tell`, end your turn"));
        assert!(rules.contains("crew routine add"));
        assert!(rules.contains("into 5-field cron"));
        assert!(rules.contains("numbers only"));
        assert!(rules.contains("`crew routine list` shows yours"));
        assert!(rules.contains("crew routine edit|remove|pause|resume <name>"));
        assert!(rules.contains("tell the user the schedule and next run"));
        assert!(rules.contains("crew ask --question"));
        assert!(rules.contains("human user"));
        assert!(rules.contains("Never send this to a teammate"));
        assert!(rules.contains("--input"));
        assert!(rules.contains("not a substitute for `crew tell`"));
        assert!(!rules.contains("roster.md"));
        assert!(rules.contains("crew memory append <<'EOF'"));
        assert!(rules.contains("run `crew memory show`, then `crew memory set <<'EOF'`"));
        assert!(rules.contains("`# Your memory`"));
        assert!(rules.contains("if it changes between turns, a `[crew system]` note"));
        assert!(rules.contains("starts with `Shared memory`"));
        assert!(rules.contains("including after a compact"));
        assert!(rules.contains("crew share show"));
        assert!(rules.contains("crew share append <<'EOF'"));
        assert!(rules.contains("crew share set <<'EOF'"));
        assert!(rules.contains("`crew share set` does not change it"));
        assert!(rules.contains("your own memory"));
        assert!(!rules.contains("Teammates:\n"));
        assert!(rules.contains("A schedule is a routine, not a memory"));
        assert!(rules.contains("secrets"));
    }

    #[test]
    fn system_prefix_is_team_rules_then_memory() {
        crate::paths::testing::with_home("system-prefix-order", || {
            crate::memory::write("t", "remember the harbor").unwrap();
            let c = cfg(&["grok", "--always-approve"], None, None);
            let argv = c.spawn_cmd_with(false, &[c.clone()]);
            let rules = rules_after(&argv, "--rules");
            let team_at = rules.find("You are Crew agent `t`").expect("team_rules");
            let mem_at = rules.find("remember the harbor").expect("memory");
            assert!(team_at < mem_at, "{rules}");
            assert!(rules.ends_with("# Your memory\nremember the harbor"), "{rules}");
        });
    }

    #[test]
    fn codex_prefix_is_team_rules_then_memory() {
        crate::paths::testing::with_home("codex-prefix-order", || {
            crate::memory::write("t", "remember the harbor").unwrap();
            let c = cfg(&["codex", "--yolo"], None, None);
            let argv = c.spawn_cmd_with(false, &[c.clone()]);
            let text = codex_config_after(&argv, "developer_instructions");
            let team_at = text.find("You are Crew agent `t`").expect("team_rules");
            let mem_at = text.find("remember the harbor").expect("memory");
            assert!(team_at < mem_at, "{text}");
        });
    }

    #[test]
    fn resolve_add_cmd_prefers_explicit_cmd() {
        let cmd = resolve_add_cmd(Some(AgentCli::Grok), vec!["cat".into()]).unwrap();
        assert_eq!(cmd, vec!["cat"]);
        assert_eq!(
            resolve_add_cmd(Some(AgentCli::Grok), vec![]).unwrap(),
            AgentCli::Grok.default_cmd()
        );
        assert!(resolve_add_cmd(None, vec![]).is_err());
    }

    #[test]
    fn agent_cli_from_cmd_uses_binary_name() {
        assert_eq!(
            AgentCli::from_cmd(&["grok".into(), "--always-approve".into()]),
            Some(AgentCli::Grok)
        );
        assert_eq!(
            AgentCli::from_cmd(&["/opt/homebrew/bin/claude".into()]),
            Some(AgentCli::Claude)
        );
        assert_eq!(
            AgentCli::from_cmd(&["codex".into(), "--yolo".into()]),
            Some(AgentCli::Codex)
        );
        assert_eq!(AgentCli::from_cmd(&["cat".into()]), None);
        assert_eq!(AgentCli::from_cmd(&[]), None);
    }

    #[test]
    fn example_config_stays_grok_and_shell() {
        let cfg: Config = serde_json::from_str(DEFAULT_AGENTS).unwrap();
        let ids: Vec<&str> = cfg.agents.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(ids, vec!["grok", "shell"]);
        assert_eq!(cfg.agents[0].cmd, vec!["grok", "--always-approve"]);
    }
}
