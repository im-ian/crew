use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;

use clap::ValueEnum;
use serde::{Deserialize, Serialize};

use crate::cron;
use crate::paths;

const DEFAULT_AGENTS: &str = include_str!("../../../agents.example.json");

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Config {
    pub agents: Vec<AgentConfig>,
    #[serde(default)]
    pub channels: Vec<Channel>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Channel {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub members: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brief: Option<String>,
}

impl Channel {
    pub fn new(id: String, name: String, members: Vec<String>) -> anyhow::Result<Self> {
        let id = id.trim().to_string();
        if id.is_empty() {
            anyhow::bail!("channel id is empty");
        }
        if !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            anyhow::bail!("channel id must be ascii alphanumeric, '-' or '_'");
        }
        let name = {
            let n = name.trim();
            if n.is_empty() {
                id.clone()
            } else {
                n.to_string()
            }
        };
        Ok(Self {
            id,
            name,
            members: unique_ids(members),
            brief: None,
        })
    }

    pub fn set_name(&mut self, name: String) {
        let n = name.trim();
        self.name = if n.is_empty() {
            self.id.clone()
        } else {
            n.to_string()
        };
    }

    pub fn set_brief(&mut self, brief: Option<String>) {
        self.brief = brief.and_then(empty_to_none);
    }

    pub fn set_members(
        &mut self,
        members: Vec<String>,
        known: impl IntoIterator<Item = impl AsRef<str>>,
    ) -> anyhow::Result<()> {
        let known: HashSet<String> = known
            .into_iter()
            .map(|s| s.as_ref().trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        let members = unique_ids(members);
        for m in &members {
            if !known.contains(m) {
                anyhow::bail!("unknown agent {m}");
            }
        }
        self.members = members;
        Ok(())
    }
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
}

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
        }
    }

    pub fn from_key(s: &str) -> anyhow::Result<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "circle" => Ok(Self::Circle),
            "teardrop" | "droplet" => Ok(Self::Teardrop),
            "rounded-square" | "rounded_square" | "roundedsquare" => Ok(Self::RoundedSquare),
            "hexagon" => Ok(Self::Hexagon),
            "triangle" => Ok(Self::Triangle),
            "cloud" => Ok(Self::Cloud),
            "pill" => Ok(Self::Pill),
            "diamond" | "rhombus" => Ok(Self::Diamond),
            "pentagon" => Ok(Self::Pentagon),
            "star" => Ok(Self::Star),
            "heart" => Ok(Self::Heart),
            other => anyhow::bail!(
                "shape must be circle, teardrop, rounded-square, hexagon, triangle, cloud, pill, diamond, pentagon, star, or heart (got {other})"
            ),
        }
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
}

impl AgentCli {
    pub fn default_cmd(self) -> Vec<String> {
        match self {
            AgentCli::Grok => vec!["grok".into(), "--always-approve".into()],
            AgentCli::Claude => vec!["claude".into(), "--dangerously-skip-permissions".into()],
            AgentCli::Codex => vec!["codex".into(), "--yolo".into()],
        }
    }

    pub fn from_key(s: &str) -> anyhow::Result<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "grok" => Ok(Self::Grok),
            "claude" => Ok(Self::Claude),
            "codex" => Ok(Self::Codex),
            other => anyhow::bail!("cli must be grok, claude, or codex (got {other})"),
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
        None => anyhow::bail!("pass --cli grok|claude|codex or --cmd …"),
    }
}

fn default_true() -> bool {
    true
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
    let out = out.trim_matches('-').to_string();
    if out.is_empty() {
        fallback.into()
    } else {
        out
    }
}

pub fn unique_agent_id<S: AsRef<str>>(name: &str, existing: impl IntoIterator<Item = S>) -> String {
    unique_from_base(slug_id(name), existing)
}

pub fn unique_channel_id<S: AsRef<str>>(
    name: &str,
    existing: impl IntoIterator<Item = S>,
) -> String {
    unique_from_base(slug_with_fallback(name, "channel"), existing)
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
        let raw = fs::read_to_string(&path)?;
        let cfg: Config = serde_json::from_str(&raw)?;
        if cfg.agents.is_empty() {
            anyhow::bail!("no agents configured in {}", path.display());
        }
        Ok(cfg)
    }

    pub fn save(&self) -> anyhow::Result<()> {
        paths::ensure_home()?;
        let path = paths::agents_path();
        let raw = serde_json::to_string_pretty(self)?;
        fs::write(path, raw + "\n")?;
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
        let mut args = self.cmd.clone();
        if args.is_empty() {
            return args;
        }
        let program = self.binary_name();
        if fresh_session {
            strip_resume_flags(&program, &mut args);
        }
        inject_model_effort(&program, &mut args, self.model.as_deref(), self.effort);
        inject_team_rules(&program, &mut args, self, roster);
        inject_memory(&program, &mut args, &self.id);
        args
    }

    /// grok / claude / codex run as one-shot headless turns. `cat` and other
    /// stubs stay on a long-lived PTY.
    pub fn uses_pty(&self) -> bool {
        uses_pty_program(&self.binary_name())
    }

    /// argv for one headless turn. Always strips stored resume flags, then
    /// attaches this turn's session (`--resume` / `--session-id` / `exec resume`)
    /// plus the real print/json flags for that CLI.
    pub fn turn_cmd(
        &self,
        prompt: &str,
        session: Option<&TurnSession>,
        roster: &[AgentConfig],
    ) -> Vec<String> {
        let mut args = self.spawn_cmd_with(true, roster);
        match self.binary_name().as_str() {
            "grok" => apply_grok_turn(&mut args, prompt, session),
            "claude" => apply_claude_turn(&mut args, prompt, session),
            "codex" => apply_codex_turn(&mut args, prompt, session),
            _ => {}
        }
        args
    }
}

pub fn uses_pty_program(program: &str) -> bool {
    !matches!(program, "grok" | "claude" | "codex")
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
        _ => {}
    }
}

pub fn persona_text(role: Option<&str>, description: Option<&str>) -> Option<String> {
    let role = role.map(str::trim).filter(|s| !s.is_empty());
    let description = description.map(str::trim).filter(|s| !s.is_empty());
    match (role, description) {
        (None, None) => None,
        (Some(r), None) => Some(r.to_string()),
        (None, Some(d)) => Some(d.to_string()),
        (Some(r), Some(d)) => Some(format!("{r}\n\n{d}")),
    }
}

/// Short spawn-time prompt: identity, teammates, and how to `crew tell`.
pub fn team_rules(agent: &AgentConfig, roster: &[AgentConfig]) -> String {
    let mut s = String::new();
    s.push_str(&format!(
        "You are Crew agent `{}` ({}).",
        agent.id,
        agent.display_name()
    ));
    if let Some(persona) = persona_text(agent.role.as_deref(), agent.description.as_deref()) {
        s.push(' ');
        s.push_str(&persona);
        if !persona.ends_with('.') && !persona.contains('\n') {
            s.push('.');
        }
    }
    s.push('\n');
    let mut others: Vec<&AgentConfig> = roster.iter().filter(|a| a.id != agent.id).collect();
    others.sort_by(|a, b| a.id.cmp(&b.id));
    if !others.is_empty() {
        s.push_str("Teammates:\n");
        for a in others {
            let role = a
                .role
                .as_deref()
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .unwrap_or("-");
            s.push_str(&format!("- {} — {} — {}\n", a.id, a.display_name(), role));
        }
    }
    s.push_str(
        "When the user writes @id or @display-name, they are naming a teammate for YOU. Stay in this session. If you need them, actually run `crew tell <id> <text>` (crew is on PATH, CREW_AGENT_ID is set). Do not ask the user to switch chats. Do not pretend.\n",
    );
    s.push_str(
        "The user talks to you in this session. Incoming `[crew from:…]` / `[crew routine:…]` / `[crew channel:…]` / `[crew system]` are real messages.\n",
    );
    s.push_str("Live roster: $CREW_HOME/roster.md\n");
    s.push_str(
        "Persistent memory: `crew memory show` / `crew memory append <text>` writes $CREW_HOME/memory/$CREW_AGENT_ID.md and survives reset.\n",
    );
    s
}

/// Short `[crew system]` note for running PTYs when the roster changes.
pub fn roster_update_text(agent: &AgentConfig, roster: &[AgentConfig]) -> String {
    let mut others: Vec<&AgentConfig> = roster.iter().filter(|a| a.id != agent.id).collect();
    others.sort_by(|a, b| a.id.cmp(&b.id));
    let mut body = String::new();
    if others.is_empty() {
        body.push_str("Teammates: (none).");
    } else {
        body.push_str("Teammates: ");
        let parts: Vec<String> = others
            .into_iter()
            .map(|a| {
                let role = a
                    .role
                    .as_deref()
                    .map(str::trim)
                    .filter(|t| !t.is_empty())
                    .unwrap_or("-");
                format!("{} — {} — {}", a.id, a.display_name(), role)
            })
            .collect();
        body.push_str(&parts.join("; "));
        body.push('.');
    }
    body.push_str(" When the user writes @id or @display-name they are naming a teammate for YOU. Stay in this session. If you need them, actually run `crew tell <id> <text>`. Do not ask the user to switch chats. Do not pretend.");
    body
}

/// `@id` / `@display-name` tokens in `text` that name a teammate (not `self_id`).
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
/// the user @mentioned teammates. Transcript should keep the raw message.
pub fn with_mention_hint(text: &str, self_id: &str, roster: &[AgentConfig]) -> String {
    let ids = mentioned_teammate_ids(text, self_id, roster);
    if ids.is_empty() {
        return text.to_string();
    }
    format!(
        "{text}\n\n[crew system]\nUser already messaged teammates via crew: {}. They have this request. Stay in this session. Do not ask the user to switch chats. Do not pretend.",
        ids.join(", ")
    )
}

pub(crate) fn mention_tokens(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut prev_ws = true;
    for (idx, ch) in text.char_indices() {
        if ch == '@' && prev_ws {
            let rest = &text[idx + ch.len_utf8()..];
            let raw: String = rest.chars().take_while(|c| !c.is_whitespace()).collect();
            let token = raw.trim_end_matches(is_mention_punct);
            if !token.is_empty() {
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

pub(crate) fn resolve_mention(token: &str, self_id: &str, roster: &[AgentConfig]) -> Option<String> {
    let lower = token.to_lowercase();
    roster
        .iter()
        .find(|a| {
            a.id != self_id
                && (a.id == token
                    || a.name == token
                    || a.id.to_lowercase() == lower
                    || a.display_name().to_lowercase() == lower)
        })
        .map(|a| a.id.clone())
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
        _ => {}
    }
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
        &[
            "-p",
            "--print",
            "--include-partial-messages",
            "--verbose",
        ],
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

fn inject_memory(program: &str, args: &mut Vec<String>, agent_id: &str) {
    let text = crate::memory::read(agent_id);
    let text = text.trim();
    if text.is_empty() {
        return;
    }
    match program {
        "grok" => append_flag_value(args, "--rules", text),
        "claude" => append_flag_value(args, "--append-system-prompt", text),
        _ => {}
    }
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

pub fn format_roster(agents: &[AgentConfig], channels: &[Channel]) -> String {
    let mut out = String::from("# Crew roster\n\n");
    out.push_str("Message a teammate with `crew tell <id> <text>`.\n");
    out.push_str("crew is on PATH; CREW_AGENT_ID is set in each agent session.\n");
    out.push_str(
        "Channel post: `crew tell --channel <id> <text>` or `crew channel send <id> <text>`.\n\n",
    );
    out.push_str("## Agents\n\n");
    if agents.is_empty() {
        out.push_str("(none)\n");
    } else {
        let mut list: Vec<&AgentConfig> = agents.iter().collect();
        list.sort_by(|a, b| a.id.cmp(&b.id));
        for a in list {
            let role = a
                .role
                .as_deref()
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .unwrap_or("-");
            out.push_str(&format!("- `{}` — {} — {}\n", a.id, a.display_name(), role));
            if let Some(title) = a.title.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
                out.push_str(&format!("  title: {title}\n"));
            }
        }
    }
    out.push_str("\n## Channels\n\n");
    if channels.is_empty() {
        out.push_str("(none)\n");
    } else {
        let mut list: Vec<&Channel> = channels.iter().collect();
        list.sort_by(|a, b| a.id.cmp(&b.id));
        for c in list {
            let members = if c.members.is_empty() {
                "(none)".to_string()
            } else {
                c.members.join(", ")
            };
            out.push_str(&format!(
                "- `{}` — {}\n  members: {}\n",
                c.id, c.name, members
            ));
            if let Some(brief) = c
                .brief
                .as_deref()
                .map(str::trim)
                .filter(|t| !t.is_empty())
            {
                out.push_str(&format!("  brief: {brief}\n"));
            }
        }
    }
    out
}

pub fn write_roster(agents: &[AgentConfig], channels: &[Channel]) -> anyhow::Result<()> {
    paths::ensure_home()?;
    fs::write(paths::roster_path(), format_roster(agents, channels))?;
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
        assert_eq!(
            argv,
            vec![
                "codex",
                "--yolo",
                "--model",
                "o3",
                "-c",
                "model_reasoning_effort=medium"
            ]
        );
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
        let argv = c.turn_cmd("hello", None, &[]);
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
        let argv = c.turn_cmd("hi", Some(&resume), &[]);
        assert!(argv.contains(&"--resume".to_string()));
        assert!(argv.contains(&resume.id));
        assert!(!argv.contains(&"--session-id".to_string()));
        let fresh = TurnSession {
            id: resume.id.clone(),
            resume: false,
        };
        let argv = c.turn_cmd("hi", Some(&fresh), &[]);
        assert!(argv.contains(&"--session-id".to_string()));
        assert!(!argv.contains(&"--resume".to_string()));
    }

    #[test]
    fn claude_turn_uses_print_and_stream_json() {
        let c = cfg(&["claude", "--dangerously-skip-permissions"], None, None);
        let argv = c.turn_cmd("hello", None, &[]);
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
        let argv = c.turn_cmd("next", Some(&resume), &[]);
        assert!(argv.contains(&"--resume".to_string()));
        assert_eq!(argv.last().map(|s| s.as_str()), Some("next"));
    }

    #[test]
    fn codex_turn_inserts_exec_json_and_resume() {
        let c = cfg(&["codex", "--yolo"], None, None);
        let argv = c.turn_cmd("hello", None, &[]);
        assert_eq!(argv[0], "codex");
        assert_eq!(argv[1], "exec");
        assert!(argv.contains(&"--yolo".to_string()));
        assert!(argv.contains(&"--json".to_string()));
        assert_eq!(argv.last().map(|s| s.as_str()), Some("hello"));
        let resume = TurnSession {
            id: "0199a213-81c0-7800-8aa1-bbab2a035a53".into(),
            resume: true,
        };
        let argv = c.turn_cmd("again", Some(&resume), &[]);
        assert_eq!(argv[1], "exec");
        assert_eq!(argv[2], "resume");
        assert_eq!(argv[3], resume.id);
        assert_eq!(argv.last().map(|s| s.as_str()), Some("again"));
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
    fn grok_gets_rules_from_role_and_description() {
        let argv = cfg_persona(
            &["grok", "--always-approve"],
            Some("PM"),
            Some("Keep replies short."),
        )
        .spawn_cmd(false);
        let rules = rules_after(&argv, "--rules");
        assert!(rules.contains("PM"));
        assert!(rules.contains("Keep replies short."));
        assert!(rules.contains("`t`"));
        assert!(rules.contains("crew tell"));
        assert!(rules.contains("[crew from:"));
    }

    #[test]
    fn claude_appends_system_prompt() {
        let argv = cfg_persona(&["claude"], Some("reviewer"), None).spawn_cmd(false);
        assert_eq!(argv[0], "claude");
        assert_eq!(argv[1], "--append-system-prompt");
        assert!(argv[2].contains("reviewer"));
        assert!(argv[2].contains("crew tell"));
    }

    #[test]
    fn unknown_and_codex_skip_persona_flags() {
        let cat = cfg_persona(&["cat"], Some("x"), Some("y")).spawn_cmd(false);
        assert_eq!(cat, vec!["cat"]);
        let codex = cfg_persona(&["codex", "--yolo"], Some("x"), None).spawn_cmd(false);
        assert_eq!(codex, vec!["codex", "--yolo"]);
    }

    #[test]
    fn grok_team_rules_list_teammates_and_append_existing() {
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
        assert!(rules.contains("PM"));
        assert!(rules.contains("beta — Beta — reviewer"));
        assert!(!rules.contains("alpha — Alpha"));
        assert!(rules.contains("crew tell"));
        assert!(rules.contains("@id"));
    }

    #[test]
    fn roster_markdown_lists_agents_and_channels() {
        let mut a = AgentConfig::new("alpha".into(), "Alpha".into(), vec!["cat".into()], None);
        a.role = Some("PM".into());
        let ch = Channel::new(
            "room".into(),
            "Room".into(),
            vec!["alpha".into(), "beta".into()],
        )
        .unwrap();
        let md = format_roster(&[a.clone()], &[ch.clone()]);
        assert!(md.contains("`alpha` — Alpha — PM"));
        assert!(md.contains("`room` — Room"));
        assert!(md.contains("members: alpha, beta"));
        assert!(!md.contains("brief:"));
        let mut with_brief = ch.clone();
        with_brief.brief = Some("launch notes".into());
        let md = format_roster(&[a], &[with_brief]);
        assert!(md.contains("brief: launch notes"));
        assert!(md.contains("crew tell"));
    }

    #[test]
    fn channels_roundtrip_in_config() {
        let raw = r#"{"agents":[{"id":"a","name":"A","cmd":["cat"]}],"channels":[{"id":"room","name":"Room","members":["a"]}]}"#;
        let cfg: Config = serde_json::from_str(raw).unwrap();
        assert_eq!(cfg.channels.len(), 1);
        assert_eq!(cfg.channels[0].members, vec!["a"]);
        assert!(cfg.channels[0].brief.is_none());
        let with_brief = r#"{"agents":[{"id":"a","name":"A","cmd":["cat"]}],"channels":[{"id":"room","name":"Room","members":["a"],"brief":"notes"}]}"#;
        let cfg: Config = serde_json::from_str(with_brief).unwrap();
        assert_eq!(cfg.channels[0].brief.as_deref(), Some("notes"));
        let old = r#"{"agents":[{"id":"a","name":"A","cmd":["cat"]}]}"#;
        let cfg: Config = serde_json::from_str(old).unwrap();
        assert!(cfg.channels.is_empty());
    }

    #[test]
    fn channel_set_name_brief_members() {
        let mut ch = Channel::new("room".into(), "Room".into(), vec!["a".into()]).unwrap();
        ch.set_name("  Launch  ".into());
        assert_eq!(ch.name, "Launch");
        ch.set_brief(Some("  keep this  ".into()));
        assert_eq!(ch.brief.as_deref(), Some("keep this"));
        ch.set_brief(Some("   ".into()));
        assert!(ch.brief.is_none());
        ch.set_members(vec!["a".into(), "b".into(), "a".into()], ["a", "b", "c"])
            .unwrap();
        assert_eq!(ch.members, vec!["a", "b"]);
        let err = ch
            .set_members(vec!["nope".into()], ["a", "b"])
            .unwrap_err();
        assert!(err.to_string().contains("unknown agent nope"), "{err}");
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
    fn slug_id_ascii_lowercase_hyphens() {
        assert_eq!(slug_id("Frontend Bot"), "frontend-bot");
        assert_eq!(slug_id("My_Bot"), "my-bot");
        assert_eq!(slug_id("  -- Hello --  "), "hello");
        assert_eq!(slug_id("프론트"), "bot");
        assert_eq!(slug_id("PM-2"), "pm-2");
    }

    #[test]
    fn unique_agent_id_suffixes() {
        assert_eq!(unique_agent_id("Grok", ["grok"]), "grok-2");
        assert_eq!(unique_agent_id("Grok", ["grok", "grok-2"]), "grok-3");
        assert_eq!(unique_agent_id("Alpha", ["grok"]), "alpha");
        assert_eq!(unique_agent_id("Grok 복사본", ["grok"]), "grok-2");
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
        assert_eq!(dup.id, "grok-2");
        assert_eq!(dup.name, "Grok 복사본");
        assert_eq!(dup.cwd.as_deref(), Some("/tmp/crew-demo/grok-2"));
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
        let named = src.duplicate(Some("Grok"), ["grok"]);
        assert_eq!(named.id, "grok-2");
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
        assert_eq!(AvatarShape::from_key("droplet").unwrap(), AvatarShape::Teardrop);
        for shape in [
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
        ] {
            assert_eq!(AvatarShape::from_key(shape.as_str()).unwrap(), shape);
        }
        assert!(AvatarShape::from_key("banana").is_err());
    }

    #[test]
    fn unique_channel_id_suffixes() {
        assert_eq!(unique_channel_id("Room", ["room"]), "room-2");
        assert_eq!(unique_channel_id("프로젝트", Vec::<&str>::new()), "channel");
    }

    #[test]
    fn roster_update_lists_other_teammates() {
        let mut alpha = AgentConfig::new("alpha".into(), "Alpha".into(), vec!["cat".into()], None);
        alpha.role = Some("PM".into());
        let mut beta = AgentConfig::new("beta".into(), "Beta".into(), vec!["cat".into()], None);
        beta.role = Some("reviewer".into());
        let text = roster_update_text(&alpha, &[alpha.clone(), beta]);
        assert!(text.contains("beta — Beta — reviewer"));
        assert!(!text.contains("alpha — Alpha"));
        assert!(text.contains("crew tell"));
        assert!(text.contains("@id"));
        let solo = roster_update_text(&alpha, &[alpha.clone()]);
        assert!(solo.contains("Teammates: (none)"));
    }

    #[test]
    fn mentioned_teammates_from_at_tokens() {
        let alpha = AgentConfig::new("alpha".into(), "Alpha".into(), vec!["cat".into()], None);
        let choon = AgentConfig::new("choonsik".into(), "춘식이".into(), vec!["cat".into()], None);
        let beta = AgentConfig::new("beta".into(), "Beta".into(), vec!["cat".into()], None);
        let roster = [alpha.clone(), choon, beta];

        assert_eq!(
            mentioned_teammate_ids("@춘식이 안녕", "alpha", &roster),
            vec!["choonsik"]
        );
        assert_eq!(
            mentioned_teammate_ids("ask @beta, then @춘식이.", "alpha", &roster),
            vec!["beta", "choonsik"]
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
        assert_eq!(
            with_mention_hint("no mentions", "alpha", &roster),
            "no mentions"
        );
    }

    #[test]
    fn team_rules_explain_at_mentions() {
        let alpha = AgentConfig::new("alpha".into(), "Alpha".into(), vec!["cat".into()], None);
        let beta = AgentConfig::new("beta".into(), "Beta".into(), vec!["cat".into()], None);
        let rules = team_rules(&alpha, &[alpha.clone(), beta]);
        assert!(rules.contains("@id"));
        assert!(rules.contains("naming a teammate for YOU"));
        assert!(rules.contains("crew tell"));
        assert!(rules.contains("Do not ask the user to switch chats"));
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
        assert!(cfg.channels.is_empty());
    }
}
