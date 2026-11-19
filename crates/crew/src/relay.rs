//! When a bot's `crew tell` is stopped. Bots pass work along as long as they
//! like, the same two back and forth included: a lead and a worker do that in
//! real work. A tell stops only on a bot sending a teammate what it already
//! sent in the chain, or on a chain grown past a large cap.
//!
//! A chain is what one user message set off. Each turn the user started gets
//! a new chain id, and every tell and wake under it keeps that id. The tells
//! in each chain are kept here, in memory: a restart starts the count over,
//! and the cap (hops, which the tells carry) still holds.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use crate::targeting::{self, TurnOrigin};

/// Chains kept at once. The oldest goes first.
const MAX_CHAINS: usize = 512;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Stop {
    /// The sender already sent the receiver this in the chain.
    Repeat,
    /// `targeting::MAX_RELAY_HOPS` tells since the user last spoke.
    Cap,
}

struct Sent {
    from: String,
    to: String,
    text: String,
}

struct Chain {
    touched: Instant,
    sent: Vec<Sent>,
}

fn ledger() -> &'static Mutex<HashMap<u64, Chain>> {
    static LEDGER: OnceLock<Mutex<HashMap<u64, Chain>>> = OnceLock::new();
    LEDGER.get_or_init(|| Mutex::new(HashMap::new()))
}

/// A chain id not used before, here or by an earlier daemon.
pub fn new_chain() -> u64 {
    static NEXT: OnceLock<AtomicU64> = OnceLock::new();
    let next = NEXT.get_or_init(|| {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(1);
        AtomicU64::new(now.max(1))
    });
    next.fetch_add(1, Ordering::Relaxed)
}

/// Two tells are the same when they differ only in spacing or case. Numbers
/// count: "2단계 끝, 3단계 시작" and "3단계 끝, 4단계 시작" are new work.
pub fn normalize(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// Why `from`'s tell to `to` must not go, in the chain `origin` carries.
/// `origin` is the tell's own: its hops already count it.
pub fn stop(origin: &TurnOrigin, from: &str, to: &str, text: &str) -> Option<Stop> {
    if origin.chain != 0 {
        if let Ok(map) = ledger().lock() {
            if let Some(chain) = map.get(&origin.chain) {
                let text = normalize(text);
                if chain
                    .sent
                    .iter()
                    .any(|s| s.from == from && s.to == to && s.text == text)
                {
                    return Some(Stop::Repeat);
                }
            }
        }
    }
    targeting::relay_exhausted(origin).then_some(Stop::Cap)
}

/// `from`'s tell to `to` went out in `chain`.
pub fn note(chain: u64, from: &str, to: &str, text: &str) {
    if chain == 0 {
        return;
    }
    let Ok(mut map) = ledger().lock() else {
        return;
    };
    if !map.contains_key(&chain) && map.len() >= MAX_CHAINS {
        if let Some(oldest) = map.iter().min_by_key(|(_, c)| c.touched).map(|(k, _)| *k) {
            map.remove(&oldest);
        }
    }
    let entry = map.entry(chain).or_insert_with(|| Chain {
        touched: Instant::now(),
        sent: Vec::new(),
    });
    entry.touched = Instant::now();
    entry.sent.push(Sent {
        from: from.to_string(),
        to: to.to_string(),
        text: normalize(text),
    });
}

/// The chain `a` and `b` last told each other in. A tell from another PC does
/// not carry the chain (the router passes hops only), so it joins the one
/// its two bots are already in.
pub fn latest_between(a: &str, b: &str) -> Option<u64> {
    let map = ledger().lock().ok()?;
    map.iter()
        .filter(|(_, c)| {
            c.sent
                .iter()
                .any(|s| (s.from == a && s.to == b) || (s.from == b && s.to == a))
        })
        .max_by_key(|(_, c)| c.touched)
        .map(|(k, _)| *k)
}

/// The note in both chats: why, who, and what did not go.
pub fn chat_line(locale: &str, stop: &Stop, from: &str, to: &str, text: &str) -> String {
    let mut said: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if said.chars().count() > 80 {
        said = said.chars().take(80).collect::<String>() + "…";
    }
    if locale == "en" {
        let why = match stop {
            Stop::Repeat => "it was the same as one already sent in this exchange".to_string(),
            Stop::Cap => format!(
                "bots passed this on over {} times since you last spoke",
                targeting::MAX_RELAY_HOPS
            ),
        };
        format!("{from} → {to}: not sent, because {why}. It said: “{said}”")
    } else {
        let why = match stop {
            Stop::Repeat => "이 흐름에서 이미 보낸 글과 같아요(되풀이)".to_string(),
            Stop::Cap => format!(
                "사람이 마지막으로 말한 뒤 봇끼리 {}번 넘게 넘겼어요(상한)",
                targeting::MAX_RELAY_HOPS
            ),
        };
        format!("{from} → {to} 요청을 보내지 않았어요. {why}. 못 보낸 글: “{said}”")
    }
}

/// What the sending bot's `crew tell` prints. It starts with "relay limit",
/// which the router path reads as that error.
pub fn error_text(stop: &Stop, to: &str) -> String {
    let why = match stop {
        Stop::Repeat => format!("you already told {to} the same thing since the user last spoke"),
        Stop::Cap => format!(
            "bots passed this on {} times since the user last spoke",
            targeting::MAX_RELAY_HOPS
        ),
    };
    format!(
        "relay limit: {why}. {to} did not get this tell. Tell the user what you wanted to send; \
         it can go once they ask again."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn told(chain: u64, hops: u32) -> TurnOrigin {
        TurnOrigin {
            from: "x".into(),
            chain,
            hops,
            ..TurnOrigin::default()
        }
    }

    #[test]
    fn same_text_but_for_spacing_and_case() {
        assert_eq!(
            normalize("  PR #160  머지했어요\n"),
            normalize("pr #160 머지했어요")
        );
        assert_ne!(
            normalize("2단계 끝, 3단계 시작"),
            normalize("3단계 끝, 4단계 시작")
        );
    }

    #[test]
    fn a_lead_handing_out_new_work_is_not_a_loop() {
        let chain = new_chain();
        for n in 0..12 {
            let text = format!("작업 {} 맡아 주세요: {}", n, "가나다".repeat(n + 1));
            assert_eq!(
                stop(&told(chain, 1), "lead", "worker", &text),
                None,
                "tell {n}"
            );
            note(chain, "lead", "worker", &text);
        }
    }

    /// A lead and a worker telling each other new work and reports is real
    /// work, however many times they go back and forth.
    #[test]
    fn two_bots_going_back_and_forth_go_on() {
        let chain = new_chain();
        for n in 0..30 {
            let ask = format!("{n}단계 맡아 주세요");
            let report = format!("{n}단계 끝났어요");
            assert_eq!(
                stop(&told(chain, 1), "lead", "worker", &ask),
                None,
                "ask {n}"
            );
            note(chain, "lead", "worker", &ask);
            assert_eq!(
                stop(&told(chain, 1), "worker", "lead", &report),
                None,
                "report {n}"
            );
            note(chain, "worker", "lead", &report);
        }
        // Saying the same thing again is still a loop.
        assert_eq!(
            stop(&told(chain, 1), "worker", "lead", "3단계 끝났어요"),
            Some(Stop::Repeat)
        );
    }

    #[test]
    fn the_same_tell_twice_stops() {
        let chain = new_chain();
        note(chain, "a", "b", "CI 통과했어요. 머지해 주세요");
        assert_eq!(
            stop(&told(chain, 1), "a", "b", "CI  통과했어요.\n머지해 주세요"),
            Some(Stop::Repeat)
        );
        assert_eq!(
            stop(&told(chain, 1), "a", "c", "CI 통과했어요. 머지해 주세요"),
            None
        );
    }

    #[test]
    fn the_cap_holds_without_a_chain() {
        assert_eq!(
            stop(&told(0, targeting::MAX_RELAY_HOPS), "a", "b", "x"),
            None
        );
        assert_eq!(
            stop(&told(0, targeting::MAX_RELAY_HOPS + 1), "a", "b", "x"),
            Some(Stop::Cap)
        );
    }

    #[test]
    fn a_tell_from_another_pc_joins_its_pair_chain() {
        let chain = new_chain();
        let (a, b) = (format!("a-{chain}"), format!("team/b-{chain}"));
        note(chain, &a, &b, "부탁해요");
        assert_eq!(latest_between(&b, &a), Some(chain));
        assert_eq!(latest_between(&a, "nobody"), None);
    }
}
