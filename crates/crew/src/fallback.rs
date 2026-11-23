//! Other AIs a bot's turn runs on when its own CLI is out of its plan.
//!
//! The list is the "default AI" setting, in order: the first one is what a
//! new bot gets, and the rest are tried top to bottom. A fallback runs that
//! one turn only. The bot keeps its CLI, its model and its session, and its
//! own CLI is tried again once the limit is over: at the reset time when one
//! is known, otherwise every [`RETRY_SECS`].

use crate::config::{AgentCli, AgentConfig, Effort};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

/// How long a limit with no known reset keeps its CLI aside before the next
/// turn tries it again.
pub const RETRY_SECS: i64 = 10 * 60;

/// One AI in the list. `cmd` is a typed command, which can be the first one,
/// a new bot's default, but never stands in for another bot. With a known
/// CLI it is the path of that CLI's program.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Candidate {
    pub cli: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub effort: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub cmd: String,
}

fn list_path() -> PathBuf {
    crate::paths::home_dir().join("fallback-ai.json")
}

/// None when the list was never saved, so the window can carry its old
/// single default over.
pub fn load() -> Option<Vec<Candidate>> {
    let text = fs::read_to_string(list_path()).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn save(list: &[Candidate]) -> anyhow::Result<()> {
    crate::paths::ensure_home()?;
    let path = list_path();
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_string_pretty(list)?)?;
    fs::rename(&tmp, &path)?;
    Ok(())
}

/// The bot's config with this AI's command, model and effort. None for a
/// typed command or a CLI Crew does not know.
pub fn config_for(bot: &AgentConfig, c: &Candidate) -> Option<AgentConfig> {
    let cli = AgentCli::from_key(&c.cli).ok()?;
    let mut cfg = bot.clone();
    cfg.cmd = cli.default_cmd();
    if !c.cmd.trim().is_empty() {
        cfg.cmd[0] = c.cmd.trim().to_string();
    }
    cfg.model = Some(c.model.trim().to_string()).filter(|m| !m.is_empty());
    cfg.effort = match c.effort.trim() {
        "low" => Some(Effort::Low),
        "medium" => Some(Effort::Medium),
        "high" => Some(Effort::High),
        _ => None,
    };
    cfg.headless = false;
    Some(cfg)
}

/// The model and effort `crew agent add --cli <cli>` starts with, as the window's
/// New bot dialog does: when neither flag was given and `cli` is the default AI
/// (the list's first), that AI's own. Any other CLI keeps the CLI's default.
pub fn add_defaults(
    cli: Option<AgentCli>,
    model: Option<String>,
    effort: Option<Effort>,
    list: &[Candidate],
) -> (Option<String>, Option<Effort>) {
    let first = list.first();
    let same = cli.zip(first).is_some_and(|(cli, c)| {
        c.cmd.trim().is_empty() && AgentCli::from_key(&c.cli).is_ok_and(|first| first == cli)
    });
    if !same || model.is_some() || effort.is_some() {
        return (model, effort);
    }
    let Some(first) = first else { return (model, effort) };
    let filled = config_for(&AgentConfig::new(String::new(), String::new(), Vec::new(), None), first);
    match filled {
        Some(cfg) => (cfg.model, cfg.effort),
        None => (model, effort),
    }
}

/// The AIs this bot's turn may move to, in order: a known CLI other than its
/// own, each once, installed. Whether one is out of its own limit is asked
/// as each is tried.
pub fn candidates_for(bot: &AgentConfig) -> Vec<(Candidate, AgentConfig)> {
    let own = bot.binary_name();
    let mut seen: Vec<String> = vec![own];
    let mut out = Vec::new();
    for c in load().unwrap_or_default() {
        let Some(cfg) = config_for(bot, &c) else { continue };
        let program = cfg.binary_name();
        if seen.contains(&program) {
            continue;
        }
        seen.push(program.clone());
        if !crate::paths::resolve_program(&cfg.cmd[0]).is_file() {
            continue;
        }
        out.push((c, cfg));
    }
    out
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Limit {
    /// Unix seconds when the CLI is tried again.
    pub until: i64,
    /// `until` is the plan's own reset time, not a guess.
    pub known: bool,
}

static LIMITS: Mutex<Option<HashMap<String, Limit>>> = Mutex::new(None);

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// The CLI ran out: aside until `reset`, or for [`RETRY_SECS`] without one.
/// A later reset already known is kept.
pub fn note_limited(program: &str, reset: Option<i64>) -> Limit {
    let now = now();
    let fresh = match reset.filter(|&t| t > now) {
        Some(until) => Limit { until, known: true },
        None => Limit {
            until: now + RETRY_SECS,
            known: false,
        },
    };
    let mut guard = LIMITS.lock().unwrap_or_else(|e| e.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    let kept = map
        .get(program)
        .copied()
        .filter(|old| old.known && old.until > fresh.until);
    let limit = kept.unwrap_or(fresh);
    map.insert(program.to_string(), limit);
    limit
}

/// It answered: the limit is over.
pub fn clear_limited(program: &str) {
    let mut guard = LIMITS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(map) = guard.as_mut() {
        map.remove(program);
    }
    drop(guard);
    crate::usage::clear_out_of_balance(program);
}

/// Whether this CLI is still out: what a turn ran into, or a plan reading
/// that shows a window used up and not reset yet.
pub fn limited(program: &str) -> Option<Limit> {
    let now = now();
    let noted = {
        let guard = LIMITS.lock().unwrap_or_else(|e| e.into_inner());
        guard
            .as_ref()
            .and_then(|map| map.get(program).copied())
            .filter(|l| l.until > now)
    };
    if noted.is_some() {
        return noted;
    }
    crate::usage::full_until(program, now).map(|until| Limit { until, known: true })
}

/// What a CLI prints when its plan or the API turns a turn away for its
/// limit, in any of the CLIs' wordings.
pub fn is_limit_error(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    const PHRASES: &[&str] = &[
        "usage limit",
        "usage_limit",
        "rate limit",
        "rate_limit",
        "rate-limit",
        "ratelimit",
        "too many requests",
        "resource_exhausted",
        "resource exhausted",
        "quota exceeded",
        "exceeded your current quota",
        "insufficient_quota",
        "out of credits",
        "run out of credits",
        "credit limit",
        "limit reached",
        "hit your limit",
        "out of extra usage",
        "-hour limit",
        "weekly limit",
        "session limit",
    ];
    if PHRASES.iter().any(|p| lower.contains(p)) {
        return true;
    }
    hit_your_limit(&lower) || has_status(&lower, "429") || is_balance_error(text)
}

/// A turn turned away because the account has no balance left to pay for it,
/// not because a window used up: Grok's `402 Payment Required: Grok Build
/// usage balance exhausted`, Claude's `Credit balance is too low`, OpenAI's
/// `insufficient_quota`. Topping up or switching AI is the way out, and
/// sending the same turn again changes nothing.
pub fn is_balance_error(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    const PHRASES: &[&str] = &[
        "usage balance",
        "balance exhausted",
        "payment required",
        "insufficient balance",
        "insufficient funds",
        "insufficient credit",
        "credit balance is too low",
        "credit balance too low",
        "out of credits",
        "run out of credits",
        "insufficient_quota",
        "exceeded your current quota",
    ];
    PHRASES.iter().any(|p| lower.contains(p)) || has_status(&lower, "402")
}

/// Claude's `You've hit your 5-hour limit`, `hit your Opus weekly limit`:
/// a limit named between "hit your" and "limit", in the same sentence.
fn hit_your_limit(lower: &str) -> bool {
    lower.match_indices("hit your ").any(|(at, p)| {
        let near: String = lower[at + p.len()..].chars().take(40).collect();
        near.split(['.', '\n', '·', '∙']).next().is_some_and(|s| s.contains("limit"))
    })
}

/// `code` (`429`, `402`) as an HTTP status, not inside a longer number.
fn has_status(lower: &str, code: &str) -> bool {
    let bytes = lower.as_bytes();
    let mut from = 0;
    while let Some(at) = lower[from..].find(code) {
        let start = from + at;
        let end = start + code.len();
        let before = start == 0 || !bytes[start - 1].is_ascii_digit();
        let after = end >= bytes.len() || !bytes[end].is_ascii_digit();
        if before && after {
            return lower.contains("status") || lower.contains("error") || lower.contains("http");
        }
        from = end;
    }
    false
}

/// When the limit in this message resets, if it says: Claude's
/// `limit reached|<unix seconds>`, `resets 6:50pm (Asia/Seoul)`, or
/// `try again in 2 hours 5 minutes`.
pub fn reset_in_error(text: &str, now: i64) -> Option<i64> {
    if let Some(at) = text.find("limit reached|") {
        let digits: String = text[at + "limit reached|".len()..]
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        if let Ok(t) = digits.parse::<i64>() {
            if t > 1_000_000_000 {
                return Some(t);
            }
        }
    }
    if let Some(at) = reset_at_clock(text, now) {
        return Some(at);
    }
    let lower = text.to_ascii_lowercase();
    let at = lower.find("try again in ")?;
    let rest = &lower[at + "try again in ".len()..];
    let mut secs = 0i64;
    let mut found = false;
    let mut words = rest
        .split(|c: char| c.is_whitespace() || c == ',')
        .filter(|w| !w.is_empty())
        .peekable();
    while let Some(word) = words.next() {
        let digits: String = word.chars().take_while(|c| c.is_ascii_digit()).collect();
        let Ok(n) = digits.parse::<i64>() else {
            if word == "and" {
                continue;
            }
            break;
        };
        let glued = &word[digits.len()..];
        let unit = if glued.is_empty() {
            words.next().unwrap_or("")
        } else {
            glued
        };
        let unit = unit.trim_end_matches(|c: char| !c.is_ascii_alphabetic());
        let scale = match unit {
            "d" | "day" | "days" => 86_400,
            "h" | "hr" | "hrs" | "hour" | "hours" => 3_600,
            "m" | "min" | "mins" | "minute" | "minutes" => 60,
            "s" | "sec" | "secs" | "second" | "seconds" => 1,
            _ => break,
        };
        secs += n * scale;
        found = true;
    }
    found.then_some(now + secs)
}

/// Claude's `resets 6:50pm (Asia/Seoul)`, `resets 11am`, `resets Nov 21,
/// 9am`: the next such time on this Mac's clock. A zone that is not this
/// Mac's is left unread, as this binary has no zone table: the limit is then
/// tried again after [`RETRY_SECS`], not waited out at a wrong hour.
fn reset_at_clock(text: &str, now: i64) -> Option<i64> {
    let lower = text.to_ascii_lowercase();
    let rest = &lower[lower.find("resets ")? + "resets ".len()..];
    if let Some(open) = rest.find('(') {
        let zone = rest[open + 1..].split(')').next().unwrap_or("").trim();
        if !zone.is_empty() && !is_local_zone(zone) {
            return None;
        }
    }
    let mut words = rest
        .split(|c: char| c.is_whitespace() || c == ',')
        .filter(|w| !w.is_empty())
        .peekable();
    let mut word = words.next()?;
    let mut date = None;
    if let Some(month) = month_of(word) {
        let day: u8 = words.next()?.parse().ok()?;
        date = Some((month, day));
        word = words.next()?;
        if word == "at" {
            word = words.next()?;
        }
    }
    let word = word.trim_end_matches(|c: char| !c.is_ascii_alphanumeric());
    let (clock, mut half) = match word.strip_suffix("am").or_else(|| word.strip_suffix("pm")) {
        Some(c) => (c, Some(word.ends_with("pm"))),
        None => (word, None),
    };
    if half.is_none() {
        match words.peek().map(|w| w.trim_end_matches(|c: char| !c.is_ascii_alphanumeric())) {
            Some("am") => half = Some(false),
            Some("pm") => half = Some(true),
            _ => {}
        }
    }
    let (h, m) = match clock.split_once(':') {
        Some((h, m)) => (h.parse::<u8>().ok()?, m.parse::<u8>().ok()?),
        None => (clock.parse::<u8>().ok()?, 0),
    };
    let hour = match half {
        Some(pm) if (1..=12).contains(&h) => h % 12 + if pm { 12 } else { 0 },
        None if h < 24 => h,
        _ => return None,
    };
    if m > 59 {
        return None;
    }
    let today = crate::cron::local_at(now as libc::time_t).ok()?;
    match date {
        Some((month, day)) => {
            let at = local_unix(today.year, month, day, hour, m)?;
            // Written without a year: one well past is next year's.
            if at < now - 86_400 {
                local_unix(today.year + 1, month, day, hour, m)
            } else {
                Some(at)
            }
        }
        None => {
            let at = local_unix(today.year, today.month, today.day, hour, m)?;
            if at > now {
                Some(at)
            } else {
                local_unix(today.year, today.month, today.day + 1, hour, m)
            }
        }
    }
}

fn month_of(word: &str) -> Option<u8> {
    const MONTHS: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    MONTHS.iter().position(|m| word.starts_with(m)).map(|i| i as u8 + 1)
}

/// A local wall-clock time as unix seconds. `day` may run past the month's end.
fn local_unix(year: i32, month: u8, day: u8, hour: u8, minute: u8) -> Option<i64> {
    // SAFETY: `mktime` reads and normalises the `tm` it is given, nothing else.
    unsafe {
        let mut tm: libc::tm = std::mem::zeroed();
        tm.tm_year = year - 1900;
        tm.tm_mon = month as i32 - 1;
        tm.tm_mday = day as i32;
        tm.tm_hour = hour as i32;
        tm.tm_min = minute as i32;
        tm.tm_isdst = -1;
        let t = libc::mktime(&mut tm);
        (t != -1).then_some(t as i64)
    }
}

/// Whether `zone` (`asia/seoul`) is this Mac's: `TZ`, or where
/// `/etc/localtime` points. When neither says, it is taken as this Mac's.
fn is_local_zone(zone: &str) -> bool {
    let zone = zone.to_ascii_lowercase();
    if let Ok(tz) = std::env::var("TZ") {
        let tz = tz.trim_start_matches(':').to_ascii_lowercase();
        if !tz.is_empty() {
            return tz == zone || tz.ends_with(&format!("/{zone}"));
        }
    }
    match std::fs::read_link("/etc/localtime") {
        Ok(path) => path.to_string_lossy().to_ascii_lowercase().ends_with(&format!("zoneinfo/{zone}")),
        Err(_) => true,
    }
}

/// The name a note gives a CLI.
pub fn label(program: &str) -> String {
    match program {
        "grok" => "Grok".into(),
        "claude" => "Claude".into(),
        "codex" => "Codex".into(),
        "agy" => "Antigravity".into(),
        "gemini" => "Gemini".into(),
        "copilot" => "Copilot".into(),
        "opencode" => "OpenCode".into(),
        other => other.to_string(),
    }
}

/// `로` or `으로` after the name, read the way it is said in Korean.
fn ro(program: &str) -> &'static str {
    match program {
        // 그록, 코파일럿 end in a consonant.
        "grok" | "copilot" => "으로",
        _ => "로",
    }
}

/// `15:00` today, `11/14 09:00` on another day.
fn clock(at: i64, now: i64) -> Option<String> {
    let t = crate::cron::local_at(at as libc::time_t).ok()?;
    let today = crate::cron::local_at(now as libc::time_t).ok()?;
    let hm = format!("{:02}:{:02}", t.hour, t.minute);
    if (t.year, t.month, t.day) == (today.year, today.month, today.day) {
        Some(hm)
    } else {
        Some(format!("{}/{} {hm}", t.month, t.day))
    }
}

/// The line above a reply that another AI wrote.
pub fn ran_on_note(locale: &str, from: &str, to: &str, limit: Limit) -> String {
    let reset = limit
        .known
        .then(|| clock(limit.until, now()))
        .flatten();
    if locale == "en" {
        let tail = reset.map(|t| format!(" · resets at {t}")).unwrap_or_default();
        format!(
            "{} hit its usage limit, so this turn ran on {} instead{tail}",
            label(from),
            label(to)
        )
    } else {
        let tail = reset.map(|t| format!(" · {t}에 풀려요")).unwrap_or_default();
        format!(
            "{} 한도에 걸려 이 턴은 {}{} 대신 돌렸어요{tail}",
            label(from),
            label(to),
            ro(to)
        )
    }
}

/// What a turn says when its AI has no balance left and no other AI took it
/// over: what happened, and the two ways out.
pub fn balance_note(locale: &str, program: &str) -> String {
    if locale == "en" {
        format!(
            "{} is out of usage balance. Top it up, or switch this bot to another AI.",
            label(program)
        )
    } else {
        format!(
            "{} 사용 잔액이 다 떨어졌어요. 충전하거나 다른 AI로 바꿔 주세요.",
            label(program)
        )
    }
}

/// The line when every AI on the list is out too, or none is installed.
pub fn none_free_note(locale: &str, from: &str) -> String {
    if locale == "en" {
        format!("{} hit its usage limit, and no other AI on the list is free", label(from))
    } else {
        format!("{} 한도에 걸렸는데 대신 돌릴 AI가 없어요", label(from))
    }
}

fn since_path(agent: &str) -> PathBuf {
    crate::paths::home_dir().join("cli-fallback").join(agent)
}

/// The first turn another AI answered for this bot since its own CLI last
/// did, in milliseconds. Its session has not seen what came after.
pub fn since(agent: &str) -> Option<i64> {
    fs::read_to_string(since_path(agent)).ok()?.trim().parse().ok()
}

pub fn mark_since(agent: &str, ts_ms: i64) {
    if since(agent).is_some() {
        return;
    }
    let path = since_path(agent);
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let _ = fs::write(path, ts_ms.to_string());
}

pub fn clear_since(agent: &str) {
    let _ = fs::remove_file(since_path(agent));
}

/// Wraps the prompt with what the bot's own session missed while another AI
/// answered for it.
pub fn with_missed(missed: &str, prompt: &str) -> String {
    format!(
        "[crew] Your CLI was out of its usage limit for a while, and another AI answered \
         these messages for you. Your session has not seen them. Read them for context \
         only; do not answer them. Answer the message after them.\n<chat>\n{missed}\n</chat>\n\n{prompt}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn knows_each_cli_wording_of_a_limit() {
        for text in [
            "Claude AI usage limit reached|1793598600",
            "5-hour limit reached ∙ resets 3pm",
            "You've hit your limit · resets 3pm",
            "You've hit your usage limit. Upgrade to Pro or try again in 2 hours 5 minutes.",
            "stream error: usage_limit_reached",
            "Error: 429 Too Many Requests",
            "API Error: 429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\"}}",
            "[API Error: RESOURCE_EXHAUSTED: Quota exceeded for quota metric]",
            "You have run out of credits for this period",
            // Claude Code, as it says it today.
            "You've hit your 5-hour limit · resets 6:50pm (Asia/Seoul)",
            "You've hit your session limit · resets 11am (Asia/Seoul)",
            "You've hit your weekly limit · resets Nov 21, 9am (Asia/Seoul)",
            "You've hit your Opus limit · resets 3pm",
            // Out of balance, which Grok's ACP hands over as an internal error.
            "Internal error (API error (status 402 Payment Required): Grok Build usage balance exhausted)",
            "API Error: 402 {\"error\":{\"message\":\"Your credit balance is too low to access the Anthropic API\"}}",
            "You exceeded your current quota, please check your plan and billing details.",
        ] {
            assert!(is_limit_error(text), "{text}");
        }
    }

    #[test]
    fn tells_a_balance_that_ran_out_from_a_window_that_did() {
        for text in [
            "Internal error (API error (status 402 Payment Required): Grok Build usage balance exhausted)",
            "HTTP 402",
            "Error: Payment Required",
            "Credit balance is too low",
            "insufficient_quota",
        ] {
            assert!(is_balance_error(text), "{text}");
        }
        for text in [
            "Internal error",
            "Error: 429 Too Many Requests",
            "You've hit your 5-hour limit · resets 6:50pm (Asia/Seoul)",
            "No conversation found with session ID: 1402",
            "port 14020 in use",
            "Internal error (API error (status 503): overloaded)",
        ] {
            assert!(!is_balance_error(text), "{text}");
        }
    }

    #[test]
    fn the_balance_note_names_the_ai_and_the_way_out() {
        assert_eq!(
            balance_note("ko", "grok"),
            "Grok 사용 잔액이 다 떨어졌어요. 충전하거나 다른 AI로 바꿔 주세요."
        );
        assert_eq!(
            balance_note("en", "grok"),
            "Grok is out of usage balance. Top it up, or switch this bot to another AI."
        );
    }

    fn pick(cli: &str, model: &str, effort: &str) -> Candidate {
        Candidate { cli: cli.into(), model: model.into(), effort: effort.into(), cmd: String::new() }
    }

    #[test]
    fn a_bot_added_on_the_default_ai_takes_its_model_and_effort() {
        let list = [pick("claude", "opus", "high"), pick("grok", "", "")];
        let got = add_defaults(Some(AgentCli::Claude), None, None, &list);
        assert_eq!(got, (Some("opus".to_string()), Some(Effort::High)));
        // Another CLI than the default keeps its own default.
        assert_eq!(add_defaults(Some(AgentCli::Grok), None, None, &list), (None, None));
        // A flag given is the user's: neither is filled in beside it.
        assert_eq!(
            add_defaults(Some(AgentCli::Claude), Some("sonnet".into()), None, &list),
            (Some("sonnet".to_string()), None)
        );
        assert_eq!(
            add_defaults(Some(AgentCli::Claude), None, Some(Effort::Low), &list),
            (None, Some(Effort::Low))
        );
        // No CLI named (a typed command), no list, or a default with nothing set.
        assert_eq!(add_defaults(None, None, None, &list), (None, None));
        assert_eq!(add_defaults(Some(AgentCli::Claude), None, None, &[]), (None, None));
        assert_eq!(
            add_defaults(Some(AgentCli::Claude), None, None, &[pick("claude", "", "")]),
            (None, None)
        );
        // A typed command as the default is no CLI's default.
        let mut typed = pick("claude", "opus", "high");
        typed.cmd = "/opt/claude".into();
        assert_eq!(add_defaults(Some(AgentCli::Claude), None, None, &[typed]), (None, None));
    }

    #[test]
    fn leaves_other_failures_alone() {
        for text in [
            "No conversation found with session ID: 1429",
            "error: unexpected argument '--foo'",
            "spawn grok: No such file or directory",
            "port 14290 in use",
        ] {
            assert!(!is_limit_error(text), "{text}");
        }
    }

    #[test]
    fn reads_the_reset_a_message_gives() {
        assert_eq!(reset_in_error("Claude AI usage limit reached|1793598600", 0), Some(1793598600));
        assert_eq!(
            reset_in_error("Upgrade to Pro or try again in 2 hours 5 minutes.", 1000),
            Some(1000 + 2 * 3600 + 5 * 60)
        );
        assert_eq!(reset_in_error("try again in 1 day, 3h and 4m", 0), Some(86_400 + 3 * 3600 + 4 * 60));
        assert_eq!(reset_in_error("rate limit reached, please wait", 0), None);
    }

    #[test]
    fn reads_the_clock_claude_says_its_limit_resets_at() {
        let now = now();
        let at = reset_in_error("You've hit your 5-hour limit · resets 6:50pm", now).expect("reset");
        let t = crate::cron::local_at(at as libc::time_t).unwrap();
        assert_eq!((t.hour, t.minute), (18, 50));
        assert!(at > now && at - now <= 25 * 3600, "the next 6:50pm");

        let at = reset_in_error("You've hit your session limit · resets 11am", now).expect("reset");
        let t = crate::cron::local_at(at as libc::time_t).unwrap();
        assert_eq!((t.hour, t.minute), (11, 0));

        let at = reset_in_error("You've hit your weekly limit · resets Nov 21, 9am", now).expect("reset");
        let t = crate::cron::local_at(at as libc::time_t).unwrap();
        assert_eq!((t.month, t.day, t.hour), (11, 21, 9));
        assert!(at > now - 86_400);

        // The words Claude used, with this Mac's zone or another one.
        let said = "You've hit your 5-hour limit · resets 6:50pm (Asia/Seoul)";
        match reset_in_error(said, now) {
            Some(at) => {
                assert!(is_local_zone("Asia/Seoul"));
                let t = crate::cron::local_at(at as libc::time_t).unwrap();
                assert_eq!((t.hour, t.minute), (18, 50));
            }
            None => assert!(!is_local_zone("Asia/Seoul")),
        }
        if !is_local_zone("Pacific/Chatham") {
            assert_eq!(reset_in_error("resets 6:50pm (Pacific/Chatham)", now), None);
        }
        assert_eq!(reset_in_error("resets soon", now), None);
        assert_eq!(reset_in_error("resets 13pm", now), None);
    }

    #[test]
    fn a_limit_without_a_reset_is_retried_after_ten_minutes() {
        let l = note_limited("test-cli-a", None);
        assert!(!l.known);
        assert!(l.until - now() <= RETRY_SECS && l.until - now() >= RETRY_SECS - 2);
        clear_limited("test-cli-a");
    }

    #[test]
    fn a_known_reset_is_not_cut_short_by_a_guess() {
        let far = now() + 3 * 3600;
        note_limited("test-cli-b", Some(far));
        let l = note_limited("test-cli-b", None);
        assert_eq!(l, Limit { until: far, known: true });
        clear_limited("test-cli-b");
        assert!(limited("test-cli-b").is_none());
    }

    #[test]
    fn the_note_says_who_answered_and_when_the_limit_ends() {
        let limit = Limit { until: 0, known: false };
        assert_eq!(
            ran_on_note("ko", "grok", "claude", limit),
            "Grok 한도에 걸려 이 턴은 Claude로 대신 돌렸어요"
        );
        assert_eq!(
            ran_on_note("ko", "claude", "grok", limit),
            "Claude 한도에 걸려 이 턴은 Grok으로 대신 돌렸어요"
        );
        assert_eq!(
            ran_on_note("en", "codex", "agy", limit),
            "Codex hit its usage limit, so this turn ran on Antigravity instead"
        );
        let soon = Limit { until: now() + 60, known: true };
        assert!(ran_on_note("ko", "grok", "claude", soon).contains("에 풀려요"));
    }

    #[test]
    fn a_typed_command_never_stands_in() {
        let bot = AgentConfig {
            id: "b".into(),
            name: "b".into(),
            cmd: vec!["grok".into()],
            cwd: None,
            avatar: None,
            avatar_shape: None,
            avatar_color: None,
            title: None,
            description: None,
            role: None,
            model: Some("grok-4".into()),
            effort: None,
            headless: false,
            routines: vec![],
        };
        let custom = Candidate { cli: "custom".into(), model: String::new(), effort: String::new(), cmd: "my-ai".into() };
        assert!(config_for(&bot, &custom).is_none());
        let claude = Candidate { cli: "claude".into(), model: "opus".into(), effort: "high".into(), cmd: String::new() };
        let cfg = config_for(&bot, &claude).unwrap();
        assert_eq!(cfg.binary_name(), "claude");
        assert_eq!(cfg.model.as_deref(), Some("opus"));
        assert_eq!(cfg.effort, Some(Effort::High));
        assert_eq!(cfg.id, "b");
    }
}
