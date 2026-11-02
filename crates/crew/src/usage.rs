//! How much of each CLI's plan is used, for the sidebar. Claude reports it on
//! every turn (`rate_limit_event`), so the daemon keeps the last one it saw.
//! Grok writes its weekly credits to its own log, which is read as is.

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
            let out = snapshot(&["codex".into(), "grok".into(), "grok".into()]);
            std::env::remove_var("GROK_HOME");
            assert!(out.is_empty(), "{out:?}");
        });
    }
}
