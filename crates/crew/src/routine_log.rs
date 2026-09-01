use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};

use serde::{Deserialize, Serialize};

use crate::paths;

pub const MAX_RUNS: usize = 20;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoutineRun {
    pub ts: u64,
    pub ok: bool,
    pub detail: String,
}

fn path(agent: &str, key: &str) -> std::path::PathBuf {
    paths::home_dir()
        .join("routine_runs")
        .join(paths::safe_agent_id(agent))
        .join(format!("{}.jsonl", paths::safe_agent_id(key)))
}

pub fn record(agent: &str, key: &str, ok: bool, detail: &str) -> anyhow::Result<()> {
    let mut runs = list(agent, key);
    runs.push(RoutineRun {
        ts: now_ms(),
        ok,
        detail: detail.chars().take(240).collect(),
    });
    runs = cap_runs(runs);
    let path = path(agent, key);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&path)?;
    for run in &runs {
        writeln!(file, "{}", serde_json::to_string(run)?)?;
    }
    Ok(())
}

pub fn list(agent: &str, key: &str) -> Vec<RoutineRun> {
    let path = path(agent, key);
    let file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(run) = serde_json::from_str::<RoutineRun>(line) {
            out.push(run);
        }
    }
    cap_runs(out)
}

pub fn cap_runs(mut runs: Vec<RoutineRun>) -> Vec<RoutineRun> {
    if runs.len() > MAX_RUNS {
        let skip = runs.len() - MAX_RUNS;
        runs = runs[skip..].to_vec();
    }
    runs
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(i: u64, ok: bool) -> RoutineRun {
        RoutineRun {
            ts: i,
            ok,
            detail: format!("run {i}"),
        }
    }

    #[test]
    fn cap_runs_keeps_last_twenty() {
        let runs: Vec<_> = (0..25).map(|i| run(i, i % 2 == 0)).collect();
        let kept = cap_runs(runs);
        assert_eq!(kept.len(), MAX_RUNS);
        assert_eq!(kept.first().unwrap().detail, "run 5");
        assert_eq!(kept.last().unwrap().detail, "run 24");
        assert!(kept.last().unwrap().ok);
    }

    #[test]
    fn json_roundtrip_run() {
        let run = RoutineRun {
            ts: 9,
            ok: false,
            detail: "boom".into(),
        };
        let line = serde_json::to_string(&run).unwrap();
        let back: RoutineRun = serde_json::from_str(&line).unwrap();
        assert!(!back.ok);
        assert_eq!(back.detail, "boom");
        assert_eq!(back.ts, 9);
    }
}
