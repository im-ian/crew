//! How much of each CLI's plan is used, for the sidebar. Claude reports it on
//! every turn (`rate_limit_event`), so the daemon keeps the last one it saw.
//! Grok writes its weekly credits to its own log, and Codex its windows to
//! each session file, which are read as is. Antigravity prints a report on
//! `agy -p /usage`, which is run at most every few minutes.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// One limit window: how much of it is used, and when it starts over.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Window {
    pub used_percent: f64,
    /// Unix seconds.
    pub resets_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanUsage {
    pub cli: String,
    /// Absent while the plan has no five-hour window, as during some promotions.
    pub five_hour: Option<Window>,
    pub weekly: Option<Window>,
    /// Unix seconds when the numbers were read from the CLI.
    pub captured_at: Option<i64>,
    /// Separate pools within one plan, as Antigravity has per model family.
    /// `weekly` is then the fullest of them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub groups: Vec<NamedWindow>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedWindow {
    pub name: String,
    pub window: Window,
}

/// The CLIs the sidebar asks about, each with what is known of its plan.
/// One with nothing known is left out.
pub fn snapshot(clis: &[String]) -> Vec<PlanUsage> {
    let mut seen: Vec<&str> = Vec::new();
    let mut out = Vec::new();
    for cli in clis {
        let cli = cli.trim();
        if cli.is_empty() || seen.contains(&cli) {
            continue;
        }
        seen.push(cli);
        let usage = match cli {
            "claude" => claude_usage(),
            "grok" => grok_usage(),
            "codex" => codex_usage(),
            "agy" => agy_usage(),
            _ => None,
        };
        out.extend(usage);
    }
    out
}

fn claude_store() -> PathBuf {
    crate::paths::home_dir().join("plan-usage-claude.json")
}

/// A Claude stream line. A `rate_limit_event` replaces what was kept.
pub fn note_claude_event(v: &Value) {
    if v.get("type").and_then(Value::as_str) != Some("rate_limit_event") {
        return;
    }
    let Some(usage) = parse_claude_event(v, now()) else {
        return;
    };
    let Ok(text) = serde_json::to_string(&usage) else {
        return;
    };
    let path = claude_store();
    let tmp = path.with_extension("json.tmp");
    if fs::write(&tmp, text).is_ok() {
        let _ = fs::rename(&tmp, &path);
    }
}

fn parse_claude_event(v: &Value, now: i64) -> Option<PlanUsage> {
    let windows = v.pointer("/rate_limit_info/unifiedWindows")?;
    let window = |key: &str| {
        let w = windows.get(key)?;
        let used = w.get("utilization").and_then(Value::as_f64)?;
        Some(Window {
            used_percent: used * 100.0,
            resets_at: w.get("resetsAt").and_then(Value::as_i64),
        })
    };
    let usage = PlanUsage {
        cli: "claude".into(),
        five_hour: window("five_hour"),
        weekly: window("seven_day"),
        captured_at: Some(now),
        groups: Vec::new(),
    };
    (usage.five_hour.is_some() || usage.weekly.is_some()).then_some(usage)
}

/// What Crew kept, or the status-line capture some setups write, whichever
/// was taken last.
fn claude_usage() -> Option<PlanUsage> {
    let kept = fs::read_to_string(claude_store())
        .ok()
        .and_then(|text| serde_json::from_str::<PlanUsage>(&text).ok());
    let widget = claude_config_dir()
        .map(|dir| dir.join("token-widget").join("claude-rate-limits.json"))
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|v| parse_claude_widget(&v));
    match (kept, widget) {
        (Some(a), Some(b)) => Some(if b.captured_at > a.captured_at { b } else { a }),
        (a, b) => a.or(b),
    }
}

fn parse_claude_widget(v: &Value) -> Option<PlanUsage> {
    let limits = v.get("rate_limits")?;
    let window = |key: &str| {
        let w = limits.get(key)?;
        Some(Window {
            used_percent: w.get("used_percentage").and_then(Value::as_f64)?,
            resets_at: w.get("resets_at").and_then(Value::as_f64).map(|s| s as i64),
        })
    };
    let usage = PlanUsage {
        cli: "claude".into(),
        five_hour: window("five_hour"),
        weekly: window("seven_day"),
        captured_at: v
            .get("captured_at")
            .and_then(Value::as_f64)
            .map(|s| s as i64),
        groups: Vec::new(),
    };
    (usage.five_hour.is_some() || usage.weekly.is_some()).then_some(usage)
}

fn claude_config_dir() -> Option<PathBuf> {
    env_dir("CLAUDE_CONFIG_DIR").or_else(|| user_home().map(|h| h.join(".claude")))
}

/// Grok logs its weekly credits each time it fetches them.
fn grok_usage() -> Option<PlanUsage> {
    let root = env_dir("GROK_HOME").or_else(|| user_home().map(|h| h.join(".grok")))?;
    let text = read_tail(&root.join("logs").join("unified.jsonl"), GROK_TAIL_BYTES)?;
    text.lines()
        .rev()
        .filter(|line| line.contains("billing: fetched credits config"))
        .find_map(|line| parse_grok_line(&serde_json::from_str(line).ok()?))
}

/// The log grows by megabytes; the last fetch is near its end.
const GROK_TAIL_BYTES: u64 = 2 * 1024 * 1024;

fn parse_grok_line(v: &Value) -> Option<PlanUsage> {
    let config = v.pointer("/ctx/config")?;
    let used = config.get("creditUsagePercent").and_then(Value::as_f64)?;
    let period = config.get("currentPeriod");
    if period
        .and_then(|p| p.get("type"))
        .and_then(Value::as_str)
        .is_some_and(|ty| ty != "USAGE_PERIOD_TYPE_WEEKLY")
    {
        return None;
    }
    let end = period
        .and_then(|p| p.get("end"))
        .or_else(|| config.get("billingPeriodEnd"))
        .and_then(Value::as_str);
    Some(PlanUsage {
        cli: "grok".into(),
        five_hour: None,
        weekly: Some(Window {
            used_percent: used,
            resets_at: end.and_then(parse_utc),
        }),
        captured_at: v.get("ts").and_then(Value::as_str).and_then(parse_utc),
        groups: Vec::new(),
    })
}

/// Codex writes its windows into each session's `token_count` events. The
/// newest session that has them is the latest reading.
fn codex_usage() -> Option<PlanUsage> {
    let root = env_dir("CODEX_HOME").or_else(|| user_home().map(|h| h.join(".codex")))?;
    let mut files = Vec::new();
    collect_jsonl(&root.join("sessions"), 4, &mut files);
    files.sort_by(|a, b| b.0.cmp(&a.0));
    files.into_iter().take(CODEX_FILES).find_map(|(_, path)| {
        let text = read_tail(&path, CODEX_TAIL_BYTES)?;
        text.lines()
            .rev()
            .filter(|line| line.contains("\"rate_limits\""))
            .find_map(|line| parse_codex_line(&serde_json::from_str(line).ok()?))
    })
}

/// Sessions without a reading (an API key, an old CLI) are skipped, but only so far back.
const CODEX_FILES: usize = 40;
const CODEX_TAIL_BYTES: u64 = 1024 * 1024;

/// `sessions/YYYY/MM/DD/*.jsonl`, with each file's modified time.
fn collect_jsonl(dir: &Path, depth: u32, out: &mut Vec<(std::time::SystemTime, PathBuf)>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if meta.is_dir() && depth > 0 {
            collect_jsonl(&path, depth - 1, out);
        } else if meta.is_file() && path.extension().is_some_and(|e| e == "jsonl") {
            if let Ok(modified) = meta.modified() {
                out.push((modified, path));
            }
        }
    }
}

fn parse_codex_line(v: &Value) -> Option<PlanUsage> {
    let limits = v.pointer("/payload/rate_limits")?;
    let mut usage = PlanUsage {
        cli: "codex".into(),
        five_hour: None,
        weekly: None,
        captured_at: v
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(parse_utc),
        groups: Vec::new(),
    };
    // `primary` is usually the five-hour window and `secondary` the weekly
    // one, but a plan with only a weekly window reports it as `primary`.
    for (key, five_hour_by_default) in [("primary", true), ("secondary", false)] {
        let Some(w) = limits.get(key).filter(|w| w.is_object()) else {
            continue;
        };
        let Some(used) = w.get("used_percent").and_then(Value::as_f64) else {
            continue;
        };
        let window = Window {
            used_percent: used,
            resets_at: w
                .get("resets_at")
                .or_else(|| w.get("reset_at"))
                .and_then(Value::as_f64)
                .map(|s| s as i64),
        };
        let five_hour = match w.get("window_minutes").and_then(Value::as_f64) {
            Some(m) if m == 300.0 => true,
            Some(m) if m == 10_080.0 => false,
            _ => five_hour_by_default,
        };
        if five_hour {
            usage.five_hour = Some(window);
        } else {
            usage.weekly = Some(window);
        }
    }
    (usage.five_hour.is_some() || usage.weekly.is_some()).then_some(usage)
}

fn agy_store() -> PathBuf {
    crate::paths::home_dir().join("plan-usage-agy.json")
}

/// Running `agy` starts its servers, so a reading this fresh is reused.
const AGY_FRESH_SECS: i64 = 5 * 60;
const AGY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(90);

fn agy_usage() -> Option<PlanUsage> {
    let kept = fs::read_to_string(agy_store())
        .ok()
        .and_then(|text| serde_json::from_str::<PlanUsage>(&text).ok());
    if let Some(k) = &kept {
        if k.captured_at.is_some_and(|at| now() - at < AGY_FRESH_SECS) {
            return kept;
        }
    }
    match run_agy_usage().and_then(|v| parse_agy_report(&v, now())) {
        Some(fresh) => {
            if let Ok(text) = serde_json::to_string(&fresh) {
                let tmp = agy_store().with_extension("json.tmp");
                if fs::write(&tmp, text).is_ok() {
                    let _ = fs::rename(&tmp, agy_store());
                }
            }
            Some(fresh)
        }
        None => kept,
    }
}

/// `agy -p /usage` reports the plan without a model prompt. It runs in a
/// throwaway folder, never updates itself, and cannot open a browser to sign in.
fn run_agy_usage() -> Option<Value> {
    use std::process::{Command, Stdio};
    let dir = std::env::temp_dir().join(format!("crew-agy-usage-{}", std::process::id()));
    fs::create_dir_all(&dir).ok()?;
    let mut child = Command::new(crate::paths::resolve_program("agy"))
        .args(["--output-format", "json", "-p", "/usage"])
        .current_dir(&dir)
        .env("PATH", crate::paths::enriched_path())
        .env("AGY_CLI_DISABLE_AUTO_UPDATE", "true")
        .env("BROWSER", "/usr/bin/false")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = stdout.read_to_string(&mut buf);
        buf
    });
    let deadline = std::time::Instant::now() + AGY_TIMEOUT;
    let ok = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(100))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
        }
    };
    let out = reader.join().unwrap_or_default();
    let _ = fs::remove_dir_all(&dir);
    if !ok {
        return None;
    }
    serde_json::from_str(out.trim()).ok()
}

fn parse_agy_report(v: &Value, now: i64) -> Option<PlanUsage> {
    if v.get("status").and_then(Value::as_str) != Some("SUCCESS") {
        return None;
    }
    let mut groups = Vec::new();
    for group in v.pointer("/command/data/groups")?.as_array()? {
        let name = group.get("name").and_then(Value::as_str).unwrap_or("");
        for bucket in group
            .get("buckets")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if bucket.get("window").and_then(Value::as_str) != Some("weekly") {
                continue;
            }
            let Some(left) = bucket.get("remaining_fraction").and_then(Value::as_f64) else {
                continue;
            };
            groups.push(NamedWindow {
                name: name.to_string(),
                window: Window {
                    used_percent: ((1.0 - left) * 100.0).clamp(0.0, 100.0),
                    resets_at: bucket
                        .get("reset_time")
                        .and_then(Value::as_str)
                        .and_then(parse_utc),
                },
            });
        }
    }
    let fullest = groups
        .iter()
        .max_by(|a, b| a.window.used_percent.total_cmp(&b.window.used_percent))?
        .window
        .clone();
    Some(PlanUsage {
        cli: "agy".into(),
        five_hour: None,
        weekly: Some(fullest),
        captured_at: Some(now),
        groups,
    })
}

fn read_tail(path: &Path, max: u64) -> Option<String> {
    let mut file = fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(len.saturating_sub(max))).ok()?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// `2026-11-02T00:33:32.018044+00:00` or `…Z`, to Unix seconds. Only UTC
/// offsets of whole hours and minutes are read, which is all these logs write.
fn parse_utc(s: &str) -> Option<i64> {
    let s = s.trim();
    let (date, rest) = s.split_once('T')?;
    let mut d = date.split('-').map(|p| p.parse::<i64>());
    let (y, m, day) = (d.next()?.ok()?, d.next()?.ok()?, d.next()?.ok()?);
    let (clock, offset) = match rest.find(['Z', '+', '-']) {
        Some(at) => rest.split_at(at),
        None => (rest, "Z"),
    };
    let mut c = clock.split(':');
    let h = c.next()?.parse::<i64>().ok()?;
    let mi = c.next()?.parse::<i64>().ok()?;
    let sec = c
        .next()
        .unwrap_or("0")
        .split('.')
        .next()?
        .parse::<i64>()
        .ok()?;
    let off = match offset.chars().next() {
        Some('+') | Some('-') => {
            let sign = if offset.starts_with('-') { -1 } else { 1 };
            let mut o = offset[1..].split(':');
            let oh = o.next()?.parse::<i64>().ok()?;
            let om = o.next().unwrap_or("0").parse::<i64>().ok()?;
            sign * (oh * 3600 + om * 60)
        }
        _ => 0,
    };
    Some(days_from_civil(y, m, day) * 86_400 + h * 3600 + mi * 60 + sec - off)
}

/// Days since 1970-01-01 for a proleptic Gregorian date.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn env_dir(key: &str) -> Option<PathBuf> {
    std::env::var_os(key)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

fn user_home() -> Option<PathBuf> {
    env_dir("HOME")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_claude_event_keeps_both_windows() {
        let v = json!({"type": "rate_limit_event", "rate_limit_info": {"unifiedWindows": {
            "five_hour": {"utilization": 0.37, "resetsAt": 1793598600},
            "seven_day": {"utilization": 0.3, "resetsAt": 1793840400}}}});
        let u = parse_claude_event(&v, 100).unwrap();
        assert_eq!(u.five_hour.unwrap().resets_at, Some(1793598600));
        assert!((u.weekly.as_ref().unwrap().used_percent - 30.0).abs() < 1e-9);
        assert_eq!(u.captured_at, Some(100));
    }

    /// Some promotions lift the five-hour cap; the event then has no such window.
    #[test]
    fn a_claude_event_without_five_hours_has_none() {
        let v = json!({"type": "rate_limit_event", "rate_limit_info": {"unifiedWindows": {
            "seven_day": {"utilization": 0.92, "resetsAt": 1793235600}}}});
        let u = parse_claude_event(&v, 1).unwrap();
        assert!(u.five_hour.is_none());
        assert!(u.weekly.is_some());
    }

    #[test]
    fn the_claude_status_line_capture_reads_the_same_way() {
        let v = json!({"captured_at": 1793182801.3, "rate_limits": {
            "seven_day": {"used_percentage": 92.0, "resets_at": 1793235600.0}}});
        let u = parse_claude_widget(&v).unwrap();
        assert!(u.five_hour.is_none());
        assert_eq!(u.weekly.unwrap().resets_at, Some(1793235600));
        assert_eq!(u.captured_at, Some(1793182801));
    }

    #[test]
    fn a_grok_credits_line_is_the_weekly_window() {
        let v = json!({"ts": "2026-10-29T03:18:22.175Z", "msg": "billing: fetched credits config",
            "ctx": {"config": {"creditUsagePercent": 99.0, "currentPeriod": {
                "type": "USAGE_PERIOD_TYPE_WEEKLY", "end": "2026-11-02T00:33:32.018044+00:00"}}}});
        let u = parse_grok_line(&v).unwrap();
        assert!(u.five_hour.is_none());
        let w = u.weekly.unwrap();
        assert_eq!(w.used_percent, 99.0);
        assert_eq!(w.resets_at, Some(1793579612));
        assert_eq!(u.captured_at, Some(1793243902));
    }

    #[test]
    fn a_grok_period_that_is_not_weekly_is_skipped() {
        let v = json!({"ctx": {"config": {"creditUsagePercent": 5.0,
            "currentPeriod": {"type": "USAGE_PERIOD_TYPE_MONTHLY"}}}});
        assert!(parse_grok_line(&v).is_none());
    }

    #[test]
    fn a_codex_reading_maps_windows_by_their_length() {
        let v = json!({"timestamp": "2026-08-19T09:18:07.531Z", "payload": {"type": "token_count",
            "rate_limits": {"primary": {"used_percent": 43.0, "window_minutes": 10080, "resets_at": 1787612904},
                "secondary": null}}});
        let u = parse_codex_line(&v).unwrap();
        assert!(u.five_hour.is_none());
        assert_eq!(u.weekly.unwrap().resets_at, Some(1787612904));
        let both = json!({"payload": {"rate_limits": {
            "primary": {"used_percent": 12.0, "window_minutes": 300},
            "secondary": {"used_percent": 64.0, "window_minutes": 10080}}}});
        let u = parse_codex_line(&both).unwrap();
        assert_eq!(u.five_hour.unwrap().used_percent, 12.0);
        assert_eq!(u.weekly.unwrap().used_percent, 64.0);
    }

    #[test]
    fn an_agy_report_keeps_each_model_pool_and_shows_the_fullest() {
        let v = json!({"status": "SUCCESS", "command": {"name": "usage", "data": {"groups": [
            {"name": "Gemini Models", "buckets": [{"window": "weekly", "remaining_fraction": 0.75,
                "reset_time": "2026-11-05T06:09:27Z"}]},
            {"name": "Claude and GPT models", "buckets": [{"window": "weekly", "remaining_fraction": 1}]}]}}});
        let u = parse_agy_report(&v, 7).unwrap();
        assert_eq!(u.groups.len(), 2);
        assert_eq!(u.groups[0].name, "Gemini Models");
        assert_eq!(u.weekly.unwrap().used_percent, 25.0);
        assert!(u.five_hour.is_none());
        assert!(parse_agy_report(&json!({"status": "ERROR"}), 7).is_none());
    }

    #[test]
    fn utc_times_read_with_and_without_an_offset() {
        assert_eq!(parse_utc("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(
            parse_utc("2026-11-02T09:33:32+09:00"),
            parse_utc("2026-11-02T00:33:32Z")
        );
    }

    #[test]
    fn a_cli_asked_twice_or_unknown_is_left_out() {
        crate::paths::testing::with_home("usage-snap", || {
            std::env::set_var("GROK_HOME", crate::paths::home_dir().join("no-grok"));
            let out = snapshot(&["gemini".into(), "grok".into(), "grok".into()]);
            std::env::remove_var("GROK_HOME");
            assert!(out.is_empty(), "{out:?}");
        });
    }
}
