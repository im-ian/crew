//! 5-field cron (minute hour day-of-month month day-of-week) in local time.

use anyhow::{bail, Context};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocalTime {
    pub year: i32,
    pub month: u8,
    pub day: u8,
    pub hour: u8,
    pub minute: u8,
    /// 0 = Sunday … 6 = Saturday
    pub wday: u8,
}

impl LocalTime {
    pub fn minute_key(&self) -> String {
        format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}",
            self.year, self.month, self.day, self.hour, self.minute
        )
    }
}

pub fn now_local() -> anyhow::Result<LocalTime> {
    local_at(unix_now()?)
}

pub fn unix_now() -> anyhow::Result<libc::time_t> {
    let mut t: libc::time_t = 0;
    if unsafe { libc::time(&mut t) } == -1 {
        bail!("time() failed");
    }
    Ok(t)
}

/// The first minute after `after` (unix seconds) that `expr` fires, looking a
/// year ahead. `None` for a schedule that never comes round, like `0 0 31 2 *`.
// ponytail: walks minute by minute, half a million steps for a schedule that
// never fires; skip whole hours and days if a listing ever feels slow.
pub fn next_after(expr: &str, after: libc::time_t) -> anyhow::Result<Option<LocalTime>> {
    validate(expr)?;
    let mut t = after - after.rem_euclid(60) + 60;
    for _ in 0..366 * 24 * 60 {
        let local = local_at(t)?;
        if matches(expr, &local)? {
            return Ok(Some(local));
        }
        t += 60;
    }
    Ok(None)
}

fn local_at(t: libc::time_t) -> anyhow::Result<LocalTime> {
    unsafe {
        let mut tm: libc::tm = std::mem::zeroed();
        if libc::localtime_r(&t, &mut tm).is_null() {
            bail!("localtime_r failed");
        }
        Ok(LocalTime {
            year: tm.tm_year + 1900,
            month: (tm.tm_mon + 1) as u8,
            day: tm.tm_mday as u8,
            hour: tm.tm_hour as u8,
            minute: tm.tm_min as u8,
            wday: tm.tm_wday as u8,
        })
    }
}

/// Parses every field. Running `matches` at one instant stopped at the first
/// field that missed, so `0 9 * * MON-FRI` passed and then never fired.
pub fn validate(expr: &str) -> anyhow::Result<()> {
    let check = || -> anyhow::Result<()> {
        let parts: Vec<&str> = expr.split_whitespace().collect();
        if parts.len() != 5 {
            bail!("schedule must be 5-field cron (got {} fields)", parts.len());
        }
        let ranges = [(0, 59), (0, 23), (1, 31), (1, 12), (0, 7)];
        for (field, (min, max)) in parts.into_iter().zip(ranges) {
            for part in field.split(',') {
                part_matches(part, min, min, max)?;
            }
        }
        Ok(())
    };
    check().with_context(|| format!("invalid cron schedule `{expr}`"))
}

/// Written as cron rather than as a sentence: `@daily`, or five or more fields
/// that open with a minute and an hour. A sentence never does.
pub fn looks_like(expr: &str) -> bool {
    let expr = expr.trim();
    if expr.starts_with('@') {
        return true;
    }
    let parts: Vec<&str> = expr.split_whitespace().collect();
    parts.len() >= 5
        && parts[..2]
            .iter()
            .all(|p| p.chars().all(|c| c.is_ascii_digit() || "*/,-".contains(c)))
}

/// A cron this engine cannot read is a mistake to report. Read as a sentence
/// instead, `@daily` found no clock and saved 08:00.
pub fn reject_unreadable(expr: &str) -> anyhow::Result<()> {
    if looks_like(expr) {
        validate(expr).context("write 5 numeric fields: minute hour day month weekday (0 = Sunday)")?;
    }
    Ok(())
}

/// True if `expr` matches `t`. 5 whitespace-separated fields.
pub fn matches(expr: &str, t: &LocalTime) -> anyhow::Result<bool> {
    let parts: Vec<&str> = expr.split_whitespace().collect();
    if parts.len() != 5 {
        bail!("schedule must be 5-field cron (got {} fields)", parts.len());
    }
    Ok(field_matches(parts[0], t.minute, 0, 59)?
        && field_matches(parts[1], t.hour, 0, 23)?
        && field_matches(parts[2], t.day, 1, 31)?
        && field_matches(parts[3], t.month, 1, 12)?
        && dow_matches(parts[4], t.wday)?)
}

fn field_matches(expr: &str, value: u8, min: u8, max: u8) -> anyhow::Result<bool> {
    if expr.is_empty() {
        bail!("empty cron field");
    }
    for part in expr.split(',') {
        if part_matches(part, value, min, max)? {
            return Ok(true);
        }
    }
    Ok(false)
}

fn dow_matches(expr: &str, wday: u8) -> anyhow::Result<bool> {
    // cron Sunday is 0 or 7
    if field_matches(expr, wday, 0, 7)? {
        return Ok(true);
    }
    if wday == 0 {
        return field_matches(expr, 7, 0, 7);
    }
    Ok(false)
}

fn part_matches(part: &str, value: u8, min: u8, max: u8) -> anyhow::Result<bool> {
    let part = part.trim();
    if part.is_empty() {
        bail!("empty cron field");
    }
    let (range, step) = match part.split_once('/') {
        Some((r, s)) => (r, parse_step(s)?),
        None => (part, 1u8),
    };
    if step == 0 {
        bail!("cron step cannot be 0");
    }
    let (lo, hi) = if range.is_empty() || range == "*" {
        (min, max)
    } else if let Some((a, b)) = range.split_once('-') {
        let lo = parse_bounded(a, min, max)?;
        let hi = parse_bounded(b, min, max)?;
        if lo > hi {
            bail!("cron range {lo}-{hi} is inverted");
        }
        (lo, hi)
    } else {
        let n = parse_bounded(range, min, max)?;
        (n, n)
    };
    if value < lo || value > hi {
        return Ok(false);
    }
    Ok((value - lo) % step == 0)
}

fn parse_step(s: &str) -> anyhow::Result<u8> {
    s.parse::<u8>()
        .with_context(|| format!("invalid cron step `{s}`"))
}

fn parse_bounded(s: &str, min: u8, max: u8) -> anyhow::Result<u8> {
    let n: u8 = s
        .parse()
        .with_context(|| format!("invalid cron number `{s}`"))?;
    if n < min || n > max {
        bail!("cron value {n} out of range {min}-{max}");
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(minute: u8, hour: u8, day: u8, month: u8, wday: u8) -> LocalTime {
        LocalTime {
            year: 2026,
            month,
            day,
            hour,
            minute,
            wday,
        }
    }

    #[test]
    fn every_minute() {
        let expr = "* * * * *";
        assert!(matches(expr, &t(0, 0, 1, 1, 4)).unwrap());
        assert!(matches(expr, &t(59, 23, 31, 12, 0)).unwrap());
    }

    #[test]
    fn exact_and_step() {
        assert!(matches("0 9 * * *", &t(0, 9, 12, 8, 3)).unwrap());
        assert!(!matches("0 9 * * *", &t(1, 9, 12, 8, 3)).unwrap());
        assert!(matches("*/5 * * * *", &t(0, 1, 1, 1, 4)).unwrap());
        assert!(matches("*/5 * * * *", &t(25, 1, 1, 1, 4)).unwrap());
        assert!(!matches("*/5 * * * *", &t(3, 1, 1, 1, 4)).unwrap());
    }

    #[test]
    fn lists_ranges_and_dow_sunday() {
        assert!(matches("0,30 9-17 * * 1-5", &t(30, 10, 1, 1, 1)).unwrap());
        assert!(!matches("0,30 9-17 * * 1-5", &t(30, 10, 1, 1, 0)).unwrap());
        assert!(matches("0 0 * * 0", &t(0, 0, 1, 1, 0)).unwrap());
        assert!(matches("0 0 * * 7", &t(0, 0, 1, 1, 0)).unwrap());
        assert!(!matches("0 0 * * 7", &t(0, 0, 1, 1, 1)).unwrap());
    }

    #[test]
    fn rejects_bad_expr() {
        assert!(validate("").is_err());
        assert!(validate("* * * *").is_err());
        assert!(validate("* * * * * *").is_err());
        assert!(validate("60 * * * *").is_err());
        assert!(validate("*/0 * * * *").is_err());
        // Fields past the first miss at 1970-01-01 00:00 are checked too.
        assert!(validate("0 9 * * MON-FRI").is_err());
        assert!(validate("0 9 * 13 *").is_err());
        assert!(validate("0 9 * * 1,X").is_err());
        assert!(validate("30 9 1-15 */2 0,6").is_ok());
    }

    #[test]
    fn next_after_lands_on_a_matching_minute_after_the_start() {
        let start: libc::time_t = 1_790_000_000;
        let every = next_after("* * * * *", start).unwrap().unwrap();
        assert_eq!(every, local_at(start - start % 60 + 60).unwrap());
        for expr in ["0 9 * * 1-5", "30 18 * * 0", "0 0 1 * *"] {
            let next = next_after(expr, start).unwrap().unwrap();
            assert!(matches(expr, &next).unwrap(), "{expr}");
        }
        assert_eq!(next_after("0 0 31 2 *", start).unwrap(), None);
        assert!(next_after("nope", start).is_err());
    }

    #[test]
    fn tells_cron_from_a_sentence() {
        for expr in ["0 9 * * MON-FRI", "@daily", "0 0 9 * * *", "*/5 * * * *"] {
            assert!(looks_like(expr), "{expr}");
        }
        for text in ["평일 8시에 브리핑", "every weekday at 8 am briefing", "9 30"] {
            assert!(!looks_like(text), "{text}");
        }
        assert!(reject_unreadable("0 9 * * MON-FRI").is_err());
        assert!(reject_unreadable("0 9 * * 1-5").is_ok());
        assert!(reject_unreadable("평일 9시").is_ok());
    }

    #[test]
    fn minute_key_format() {
        assert_eq!(t(3, 14, 28, 8, 5).minute_key(), "2026-08-28T14:03");
    }
}
