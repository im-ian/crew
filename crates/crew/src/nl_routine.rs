use anyhow::{bail, Context};

use crate::cron;

/// A routine parsed from a chat-like sentence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedRoutine {
    pub name: String,
    pub schedule: String,
    pub prompt: String,
}

pub fn parse_nl_routine(text: &str) -> anyhow::Result<ParsedRoutine> {
    let raw = text.trim();
    if raw.is_empty() {
        bail!("routine text is empty");
    }
    if cron::validate(raw).is_ok() {
        bail!("expected natural language, got cron");
    }
    let lower = raw.to_lowercase();
    let hourly = is_hourly(&lower);
    let (hour, minute) = if hourly {
        (0, 0)
    } else {
        parse_clock(&lower).unwrap_or((8, 0))
    };
    if !hourly && parse_clock(&lower).is_none() && !has_briefing(&lower) {
        // still allow default 08:00 when the sentence is clearly a briefing
        if !looks_like_schedule(&lower) {
            bail!("could not find a time in `{raw}`");
        }
    }
    let dow = parse_dow(&lower);
    let schedule = if hourly {
        "0 * * * *".to_string()
    } else {
        format!("{minute} {hour} * * {dow}")
    };
    cron::validate(&schedule).with_context(|| format!("built invalid cron `{schedule}`"))?;
    let name = infer_name(raw, &lower);
    let prompt = infer_prompt(raw);
    Ok(ParsedRoutine {
        name,
        schedule,
        prompt,
    })
}

fn looks_like_schedule(lower: &str) -> bool {
    lower.contains("weekday")
        || lower.contains("daily")
        || lower.contains("every")
        || lower.contains("평일")
        || lower.contains("매일")
        || lower.contains("매주")
        || lower.contains("주중")
        || has_briefing(lower)
}

fn has_briefing(lower: &str) -> bool {
    lower.contains("briefing") || lower.contains("브리핑")
}

fn is_hourly(lower: &str) -> bool {
    lower.contains("hourly")
        || lower.contains("every hour")
        || lower.contains("매시")
        || lower.contains("한 시간마다")
        || lower.contains("매시간")
}

fn parse_dow(lower: &str) -> &'static str {
    if lower.contains("weekend") || lower.contains("주말") {
        return "0,6";
    }
    if lower.contains("weekday")
        || lower.contains("평일")
        || lower.contains("주중")
        || lower.contains("월-금")
        || lower.contains("월~금")
    {
        return "1-5";
    }
    const DAYS: &[(&[&str], &str)] = &[
        (&["sunday", "일요일"], "0"),
        (&["monday", "월요일"], "1"),
        (&["tuesday", "화요일"], "2"),
        (&["wednesday", "수요일"], "3"),
        (&["thursday", "목요일"], "4"),
        (&["friday", "금요일"], "5"),
        (&["saturday", "토요일"], "6"),
    ];
    let mut hits = Vec::new();
    for (keys, n) in DAYS {
        if keys.iter().any(|k| lower.contains(k)) {
            hits.push(*n);
        }
    }
    if hits.len() == 1 {
        return match hits[0] {
            "0" => "0",
            "1" => "1",
            "2" => "2",
            "3" => "3",
            "4" => "4",
            "5" => "5",
            "6" => "6",
            _ => "*",
        };
    }
    if !hits.is_empty() {
        // multiple named days: join in order 0-6
        // return a static-incompatible string — use daily fallback via leak
    }
    if lower.contains("daily")
        || lower.contains("every day")
        || lower.contains("매일")
        || lower.contains("날마다")
    {
        return "*";
    }
    if has_briefing(lower) {
        return "1-5";
    }
    "*"
}

fn parse_clock(lower: &str) -> Option<(u8, u8)> {
    let bytes = lower.as_bytes();
    // HH:MM
    for i in 0..bytes.len() {
        if let Some((h, m)) = colon_clock(lower, i) {
            return Some((h, m));
        }
    }
    // 오전/오후 N시 [M분]
    if let Some(idx) = lower.find("오전") {
        if let Some((h, m)) = korean_hour(&lower[idx + "오전".len()..], false) {
            return Some((h, m));
        }
    }
    if let Some(idx) = lower.find("오후") {
        if let Some((h, m)) = korean_hour(&lower[idx + "오후".len()..], true) {
            return Some((h, m));
        }
    }
    // 8am / 8 pm
    if let Some(h) = ampm_hour(lower) {
        return Some(h);
    }
    // N시 M분
    korean_hour(lower, false)
}

fn colon_clock(s: &str, i: usize) -> Option<(u8, u8)> {
    let rest = s.get(i..)?;
    let mut chars = rest.chars();
    let a = chars.next()?;
    if !a.is_ascii_digit() {
        return None;
    }
    let mut hour = a.to_digit(10)? as u8;
    let b = chars.next()?;
    let after_hour: String;
    if b.is_ascii_digit() {
        hour = hour * 10 + b.to_digit(10)? as u8;
        after_hour = chars.collect();
    } else if b == ':' {
        after_hour = std::iter::once(b).chain(chars).collect();
    } else {
        return None;
    }
    let after_hour = after_hour.strip_prefix(':')?;
    let mut mchars = after_hour.chars();
    let d1 = mchars.next()?.to_digit(10)? as u8;
    let d2 = mchars.next()?.to_digit(10)? as u8;
    let minute = d1 * 10 + d2;
    if hour > 23 || minute > 59 {
        return None;
    }
    Some((hour, minute))
}

fn ampm_hour(lower: &str) -> Option<(u8, u8)> {
    let re = ["am", "pm"];
    for tag in re {
        if let Some(idx) = lower.find(tag) {
            let before = lower[..idx].trim_end();
            let mut n = String::new();
            for c in before.chars().rev() {
                if c.is_ascii_digit() {
                    n.insert(0, c);
                } else if !n.is_empty() {
                    break;
                } else if c.is_whitespace() {
                    continue;
                } else {
                    break;
                }
            }
            if n.is_empty() {
                continue;
            }
            let mut h: u8 = n.parse().ok()?;
            if tag == "am" {
                if h == 12 {
                    h = 0;
                }
            } else if h < 12 {
                h += 12;
            }
            if h > 23 {
                continue;
            }
            return Some((h, 0));
        }
    }
    None
}

fn korean_hour(s: &str, pm: bool) -> Option<(u8, u8)> {
    let idx = s.find('시')?;
    let before = s[..idx].trim_end();
    let mut n = String::new();
    for c in before.chars().rev() {
        if c.is_ascii_digit() {
            n.insert(0, c);
        } else if !n.is_empty() {
            break;
        } else if c.is_whitespace() {
            continue;
        } else {
            break;
        }
    }
    if n.is_empty() {
        return None;
    }
    let mut h: u8 = n.parse().ok()?;
    if pm && h < 12 {
        h += 12;
    }
    if h > 23 {
        return None;
    }
    let after = s[idx + '시'.len_utf8()..].trim_start();
    let mut minute = 0u8;
    if let Some(midx) = after.find('분') {
        let mbefore = after[..midx].trim();
        if let Ok(m) = mbefore.parse::<u8>() {
            if m < 60 {
                minute = m;
            }
        }
    }
    Some((h, minute))
}

fn infer_name(raw: &str, lower: &str) -> String {
    if lower.contains("브리핑") {
        return "브리핑".into();
    }
    if lower.contains("briefing") {
        return "briefing".into();
    }
    raw.split_whitespace()
        .take(3)
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(24)
        .collect()
}

fn infer_prompt(raw: &str) -> String {
    let t = raw.trim();
    if t.is_empty() {
        "Run the scheduled job.".into()
    } else {
        t.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weekday_0800_briefing() {
        let p = parse_nl_routine("Every weekday at 8:00 AM, post a briefing").unwrap();
        assert_eq!(p.schedule, "0 8 * * 1-5");
        assert_eq!(p.name, "briefing");
        assert!(p.prompt.to_lowercase().contains("briefing"));
        cron::validate(&p.schedule).unwrap();
    }

    #[test]
    fn korean_weekday_briefing() {
        let p = parse_nl_routine("평일 8시에 브리핑").unwrap();
        assert_eq!(p.schedule, "0 8 * * 1-5");
        assert_eq!(p.name, "브리핑");
        cron::validate(&p.schedule).unwrap();
    }

    #[test]
    fn daily_time() {
        let p = parse_nl_routine("매일 09:30 메일 확인").unwrap();
        assert_eq!(p.schedule, "30 9 * * *");
        assert!(p.prompt.contains("메일"));
    }

    #[test]
    fn afternoon_korean() {
        let p = parse_nl_routine("매일 오후 3시 30분 스탠드업").unwrap();
        assert_eq!(p.schedule, "30 15 * * *");
    }

    #[test]
    fn hourly() {
        let p = parse_nl_routine("매시 정각에 상태 보고").unwrap();
        assert_eq!(p.schedule, "0 * * * *");
    }

    #[test]
    fn empty_fails() {
        assert!(parse_nl_routine("   ").is_err());
    }
}
