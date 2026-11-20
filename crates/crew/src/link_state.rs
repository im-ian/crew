//! Whether a GitHub pull request or issue a chat links to is open, merged or
//! closed, and its title, for the archive tab. Read through the `gh` CLI, and
//! only ever read: any link, on anyone's repository.
//!
//! A state that cannot be read is no state, never an error: `gh` missing,
//! offline, a rate limit, a private repository none of this Mac's `gh`
//! accounts can see. The archive then shows the link as it is.

use std::collections::HashMap;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

/// Most distinct links answered in one call. The rest come back without a state.
const MAX_LINKS: usize = 200;
/// Links asked of GitHub in one query.
const BATCH: usize = 40;
/// An open one may change any minute; a merged or closed one rarely does.
const OPEN_TTL: Duration = Duration::from_secs(3 * 60);
const DONE_TTL: Duration = Duration::from_secs(10 * 60);
/// A link with no state is not asked again at once: offline or rate limited
/// would otherwise start `gh` on every look.
const NONE_TTL: Duration = Duration::from_secs(60);
/// `gh` is given this long per call.
const GH_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LinkState {
    /// The link, as it was asked.
    pub url: String,
    /// "pr" or "issue".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// "open", "merged" or "closed".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

impl LinkState {
    fn none(url: &str) -> Self {
        Self { url: url.to_string(), kind: None, state: None, title: None }
    }
}

/// A pull request or issue on GitHub, from its web address.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct Ref {
    owner: String,
    repo: String,
    number: u64,
}

impl Ref {
    fn key(&self) -> String {
        format!("{}/{}#{}", self.owner, self.repo, self.number).to_ascii_lowercase()
    }
}

fn name_ok(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 100
        && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// `https://github.com/<owner>/<repo>/pull/<n>` or `/issues/<n>`, with any
/// path after, a query or a fragment. Anything else is not one.
fn parse(url: &str) -> Option<Ref> {
    let rest = url.trim();
    let rest = rest
        .strip_prefix("https://")
        .or_else(|| rest.strip_prefix("http://"))?;
    let rest = rest.split(['?', '#']).next()?;
    let mut parts = rest.split('/');
    let host = parts.next()?.to_ascii_lowercase();
    if host != "github.com" && host != "www.github.com" {
        return None;
    }
    let owner = parts.next()?;
    let repo = parts.next()?;
    let kind = parts.next()?;
    let number = parts.next()?;
    if !matches!(kind, "pull" | "issues") || !name_ok(owner) || !name_ok(repo) {
        return None;
    }
    if number.is_empty() || number.len() > 9 || !number.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some(Ref {
        owner: owner.to_string(),
        repo: repo.to_string(),
        number: number.parse().ok()?,
    })
}

/// One query for all of `refs`: each is an alias, so a repository that is not
/// there leaves its own answer empty and the others stand.
fn query(refs: &[&Ref]) -> String {
    let mut q = String::from("query {");
    for (i, r) in refs.iter().enumerate() {
        q.push_str(&format!(
            " r{i}: repository(owner: \"{}\", name: \"{}\") {{ issueOrPullRequest(number: {}) \
             {{ __typename ... on Issue {{ state title }} ... on PullRequest {{ state title }} }} }}",
            r.owner, r.repo, r.number
        ));
    }
    q.push_str(" }");
    q
}

/// What GitHub answered for each of the `n` aliases of `query`.
fn read_answer(raw: &str, n: usize) -> Vec<Option<(String, String, String)>> {
    let data = serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|v| v.get("data").cloned())
        .unwrap_or(Value::Null);
    (0..n)
        .map(|i| {
            let node = data.get(format!("r{i}"))?.get("issueOrPullRequest")?;
            let kind = match node.get("__typename")?.as_str()? {
                "PullRequest" => "pr",
                "Issue" => "issue",
                _ => return None,
            };
            let state = match node.get("state")?.as_str()? {
                "OPEN" => "open",
                "MERGED" => "merged",
                "CLOSED" => "closed",
                _ => return None,
            };
            let title = node.get("title").and_then(Value::as_str).unwrap_or("");
            Some((kind.to_string(), state.to_string(), title.to_string()))
        })
        .collect()
}

/// `gh`, as far as this module needs it. A fake stands in for it in tests.
trait Gh {
    /// The GraphQL answer for `query`, from `account`'s login or, with none,
    /// from whichever `gh` has active. Even a partial answer counts.
    fn graphql(&self, account: Option<&str>, query: &str) -> Option<String>;
    /// The other logins `gh` holds for github.com, to try when the active one
    /// cannot see a repository (this Mac keeps several).
    fn accounts(&self) -> Vec<String>;
}

struct RealGh;

fn gh_command() -> Command {
    let mut cmd = Command::new(crate::paths::resolve_program("gh"));
    cmd.env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::piped());
    cmd
}

/// stdout of `cmd`, whether or not it succeeded (`gh api` exits 1 on a partial
/// GraphQL answer and still prints it), or None when it did not start or ran
/// over `GH_TIMEOUT`.
fn run(mut cmd: Command) -> Option<String> {
    let mut child = cmd.spawn().ok()?;
    let mut out = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = out.read_to_string(&mut buf);
        buf
    });
    let deadline = Instant::now() + GH_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    reader.join().ok()
}

impl Gh for RealGh {
    fn graphql(&self, account: Option<&str>, query: &str) -> Option<String> {
        let mut cmd = gh_command();
        if let Some(account) = account {
            let token = run({
                let mut t = gh_command();
                t.args(["auth", "token", "--hostname", "github.com", "--user", account]);
                t
            })?;
            let token = token.trim();
            if token.is_empty() {
                return None;
            }
            cmd.env("GH_TOKEN", token);
        }
        cmd.args(["api", "graphql", "-f"]).arg(format!("query={query}"));
        run(cmd).filter(|s| !s.trim().is_empty())
    }

    fn accounts(&self) -> Vec<String> {
        let mut cmd = gh_command();
        cmd.args(["auth", "status", "--hostname", "github.com"]).stderr(Stdio::piped());
        // The login lines go to stdout or stderr by version; read both.
        let Ok(output) = cmd.output() else { return Vec::new() };
        let text = format!(
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        accounts_in(&text)
    }
}

/// The logins in `gh auth status`: "Logged in to github.com account <login> (…)".
/// The active one is left out, since it was tried first.
fn accounts_in(status: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut lines = status.lines().peekable();
    while let Some(line) = lines.next() {
        let Some((_, rest)) = line.split_once(" account ") else { continue };
        let login = rest.split_whitespace().next().unwrap_or("");
        if !name_ok(login) || !line.contains("Logged in") {
            continue;
        }
        let active = lines
            .clone()
            .take_while(|l| !l.contains(" account "))
            .any(|l| l.contains("Active account: true"));
        if !active {
            out.push(login.to_string());
        }
    }
    out
}

type Cache = HashMap<String, (Instant, LinkState)>;

fn cache() -> &'static Mutex<Cache> {
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The state of each link in `urls`, same length and order. A link that is not
/// a GitHub pull request or issue, or whose state could not be read, has none.
pub fn link_states(urls: &[String]) -> Vec<LinkState> {
    resolve(urls, &RealGh, cache(), Instant::now())
}

fn resolve(urls: &[String], gh: &dyn Gh, cache: &Mutex<Cache>, now: Instant) -> Vec<LinkState> {
    let refs: Vec<Option<Ref>> = urls.iter().map(|u| parse(u)).collect();

    // What is already known, and what is still to ask, each link once.
    let mut known: HashMap<String, LinkState> = HashMap::new();
    let mut ask: Vec<Ref> = Vec::new();
    {
        let held = cache.lock().unwrap_or_else(|e| e.into_inner());
        for r in refs.iter().flatten() {
            let key = r.key();
            if known.contains_key(&key) || ask.iter().any(|a| a.key() == key) {
                continue;
            }
            match held.get(&key) {
                Some((until, state)) if *until > now => {
                    known.insert(key, state.clone());
                }
                _ => {
                    if known.len() + ask.len() < MAX_LINKS {
                        ask.push(r.clone());
                    }
                }
            }
        }
    }

    let mut found: HashMap<String, (String, String, String)> = HashMap::new();
    if !ask.is_empty() {
        let mut accounts: Option<Vec<String>> = None;
        let mut rest: Vec<&Ref> = ask.iter().collect();
        // The active login first, then each other one for what it left over.
        let mut turn = 0;
        while !rest.is_empty() {
            let account = if turn == 0 {
                None
            } else {
                let list = accounts.get_or_insert_with(|| gh.accounts());
                match list.get(turn - 1) {
                    Some(a) => Some(a.clone()),
                    None => break,
                }
            };
            let mut left: Vec<&Ref> = Vec::new();
            let mut any_ok = false;
            for chunk in rest.chunks(BATCH) {
                match gh.graphql(account.as_deref(), &query(chunk)) {
                    None => left.extend(chunk.iter().copied()),
                    Some(raw) => {
                        any_ok = true;
                        for (r, answer) in chunk.iter().zip(read_answer(&raw, chunk.len())) {
                            match answer {
                                Some(a) => {
                                    found.insert(r.key(), a);
                                }
                                None => left.push(r),
                            }
                        }
                    }
                }
            }
            // `gh` that does not run on the first try will not on the next.
            if !any_ok && turn == 0 {
                break;
            }
            rest = left;
            turn += 1;
        }
    }

    {
        let mut held = cache.lock().unwrap_or_else(|e| e.into_inner());
        for r in &ask {
            let key = r.key();
            let (state, ttl) = match found.get(&key) {
                Some((kind, state, title)) => (
                    LinkState {
                        url: String::new(),
                        kind: Some(kind.clone()),
                        state: Some(state.clone()),
                        title: Some(title.clone()).filter(|t| !t.is_empty()),
                    },
                    if state == "open" { OPEN_TTL } else { DONE_TTL },
                ),
                None => (LinkState::none(""), NONE_TTL),
            };
            held.insert(key.clone(), (now + ttl, state.clone()));
            known.insert(key, state);
        }
        held.retain(|_, (until, _)| *until > now);
    }

    urls.iter()
        .zip(refs)
        .map(|(url, r)| match r.and_then(|r| known.get(&r.key()).cloned()) {
            Some(s) => LinkState { url: url.clone(), ..s },
            None => LinkState::none(url),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// A `gh` that answers from a table of repository → (kind, state, title),
    /// per login, and records which logins were asked.
    struct Fake {
        /// None = the active login.
        sees: HashMap<Option<&'static str>, Vec<(&'static str, u64, &'static str, &'static str, &'static str)>>,
        others: Vec<String>,
        calls: RefCell<Vec<Option<String>>>,
        down: bool,
    }

    impl Fake {
        fn new() -> Self {
            Self { sees: HashMap::new(), others: Vec::new(), calls: RefCell::new(Vec::new()), down: false }
        }
    }

    impl Gh for Fake {
        fn graphql(&self, account: Option<&str>, q: &str) -> Option<String> {
            self.calls.borrow_mut().push(account.map(str::to_string));
            if self.down {
                return None;
            }
            let table = self.sees.get(&account).cloned().unwrap_or_default();
            let mut data = serde_json::Map::new();
            // Aliases appear in order: r0, r1 …; find each one's repo and number.
            for (i, part) in q.split("repository(").skip(1).enumerate() {
                let repo = part.split("name: \"").nth(1).unwrap().split('"').next().unwrap();
                let owner = part.split("owner: \"").nth(1).unwrap().split('"').next().unwrap();
                let number: u64 = part
                    .split("number: ")
                    .nth(1)
                    .unwrap()
                    .split(')')
                    .next()
                    .unwrap()
                    .parse()
                    .unwrap();
                let hit = table
                    .iter()
                    .find(|(o, n, r, _, _)| *o == owner && *n == number && *r == repo);
                let value = match hit {
                    Some((_, _, _, kind, state)) => serde_json::json!({
                        "issueOrPullRequest": { "__typename": kind, "state": state, "title": format!("{repo}#{number}") }
                    }),
                    None => Value::Null,
                };
                data.insert(format!("r{i}"), value);
            }
            Some(serde_json::json!({ "data": data, "errors": [{"type": "NOT_FOUND"}] }).to_string())
        }
        fn accounts(&self) -> Vec<String> {
            self.others.clone()
        }
    }

    fn urls(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn fresh() -> Mutex<Cache> {
        Mutex::new(HashMap::new())
    }

    #[test]
    fn github_pull_and_issue_links_are_read_and_nothing_else() {
        let r = parse("https://github.com/im-ian/crew/pull/370/files?w=1#diff").unwrap();
        assert_eq!((r.owner.as_str(), r.repo.as_str(), r.number), ("im-ian", "crew", 370));
        assert!(parse("http://www.github.com/a/b/issues/7").is_some());
        for bad in [
            "https://github.com/a/b",
            "https://github.com/a/b/pulls",
            "https://github.com/a/b/pull/x",
            "https://github.com/a/b/pull/",
            "https://gitlab.com/a/b/pull/1",
            "https://github.com.evil.io/a/b/pull/1",
            "https://github.com/a\"b/c/pull/1",
            "ftp://github.com/a/b/pull/1",
            "github.com/a/b/pull/1",
            "",
        ] {
            assert!(parse(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn states_come_back_in_order_from_one_query() {
        let mut gh = Fake::new();
        gh.sees.insert(
            None,
            vec![
                ("o", 1, "r", "PullRequest", "MERGED"),
                ("o", 2, "r", "Issue", "OPEN"),
                ("p", 3, "s", "PullRequest", "CLOSED"),
            ],
        );
        let input = urls(&[
            "https://github.com/o/r/pull/1",
            "https://example.com/x",
            "https://github.com/o/r/issues/2",
            "https://github.com/p/s/pull/3",
            "https://github.com/o/r/pull/1/files",
        ]);
        let out = resolve(&input, &gh, &fresh(), Instant::now());
        assert_eq!(out.len(), input.len());
        let got: Vec<_> = out.iter().map(|s| (s.url.as_str(), s.kind.as_deref(), s.state.as_deref())).collect();
        assert_eq!(
            got,
            vec![
                ("https://github.com/o/r/pull/1", Some("pr"), Some("merged")),
                ("https://example.com/x", None, None),
                ("https://github.com/o/r/issues/2", Some("issue"), Some("open")),
                ("https://github.com/p/s/pull/3", Some("pr"), Some("closed")),
                ("https://github.com/o/r/pull/1/files", Some("pr"), Some("merged")),
            ]
        );
        assert_eq!(out[0].title.as_deref(), Some("r#1"));
        // Four distinct links, asked in a single call.
        assert_eq!(gh.calls.borrow().len(), 1);
    }

    #[test]
    fn a_repository_only_another_login_sees_is_tried_with_it() {
        let mut gh = Fake::new();
        gh.sees.insert(None, vec![("o", 1, "r", "PullRequest", "OPEN")]);
        gh.sees.insert(Some("work"), vec![("p", 9, "private", "PullRequest", "MERGED")]);
        gh.others = vec!["other".into(), "work".into()];
        let out = resolve(
            &urls(&["https://github.com/o/r/pull/1", "https://github.com/p/private/pull/9", "https://github.com/q/none/issues/5"]),
            &gh,
            &fresh(),
            Instant::now(),
        );
        assert_eq!(out[0].state.as_deref(), Some("open"));
        assert_eq!(out[1].state.as_deref(), Some("merged"));
        assert_eq!(out[2].state, None);
        // Active, then each other login for what was left.
        let calls: Vec<_> = gh.calls.borrow().clone();
        assert_eq!(calls, vec![None, Some("other".to_string()), Some("work".to_string())]);
    }

    #[test]
    fn gh_missing_or_offline_is_quietly_no_state() {
        let mut gh = Fake::new();
        gh.down = true;
        gh.others = vec!["work".into()];
        let input = urls(&["https://github.com/o/r/pull/1", "not a link"]);
        let out = resolve(&input, &gh, &fresh(), Instant::now());
        assert_eq!(out, vec![LinkState::none(&input[0]), LinkState::none(&input[1])]);
        // It did not run on past the first failure.
        assert_eq!(gh.calls.borrow().len(), 1);
    }

    #[test]
    fn an_answer_is_kept_a_few_minutes_and_a_miss_for_one() {
        let mut gh = Fake::new();
        gh.sees.insert(None, vec![("o", 1, "r", "PullRequest", "OPEN"), ("o", 2, "r", "PullRequest", "MERGED")]);
        let cache = fresh();
        let t0 = Instant::now();
        let input = urls(&[
            "https://github.com/o/r/pull/1",
            "https://github.com/o/r/pull/2",
            "https://github.com/o/r/pull/3",
        ]);
        resolve(&input, &gh, &cache, t0);
        assert_eq!(gh.calls.borrow().len(), 1);
        // Within a minute nothing is asked again, the miss included.
        resolve(&input, &gh, &cache, t0 + Duration::from_secs(30));
        assert_eq!(gh.calls.borrow().len(), 1);
        // After a minute only the miss is asked again; the others still stand.
        let out = resolve(&input, &gh, &cache, t0 + Duration::from_secs(90));
        assert_eq!(out[0].state.as_deref(), Some("open"));
        assert_eq!(out[1].state.as_deref(), Some("merged"));
        let n = gh.calls.borrow().len();
        assert!(n > 1, "the miss was not asked again");
        // An open one is asked again after its own time, a merged one later.
        resolve(&input, &gh, &cache, t0 + Duration::from_secs(4 * 60));
        let after_open = gh.calls.borrow().len();
        assert!(after_open > n);
        resolve(&input, &gh, &cache, t0 + Duration::from_secs(11 * 60));
        assert!(gh.calls.borrow().len() > after_open);
    }

    #[test]
    fn more_than_a_batch_is_asked_in_pieces() {
        let gh = Fake::new();
        let input: Vec<String> = (1..=95).map(|n| format!("https://github.com/o/r/pull/{n}")).collect();
        let out = resolve(&input, &gh, &fresh(), Instant::now());
        assert_eq!(out.len(), 95);
        // 95 links at 40 a query: three calls, and no other login to try.
        assert_eq!(gh.calls.borrow().len(), 3);
    }

    #[test]
    fn the_logins_are_read_from_gh_auth_status() {
        let status = "github.com\n  ✓ Logged in to github.com account jtf-ian (keyring)\n  - Active account: true\n  - Git operations protocol: https\n\n  ✓ Logged in to github.com account im-ian (keyring)\n  - Active account: false\n  - Git operations protocol: https\n";
        assert_eq!(accounts_in(status), vec!["im-ian".to_string()]);
        assert!(accounts_in("You are not logged into any GitHub hosts.").is_empty());
    }

    #[test]
    fn what_github_says_is_mapped_and_a_bad_answer_is_nothing() {
        let raw = r#"{"data":{"r0":{"issueOrPullRequest":{"__typename":"PullRequest","state":"MERGED","title":"x"}},"r1":null}}"#;
        let got = read_answer(raw, 2);
        assert_eq!(got[0], Some(("pr".into(), "merged".into(), "x".into())));
        assert_eq!(got[1], None);
        assert_eq!(read_answer("not json", 2), vec![None, None]);
        assert_eq!(read_answer(r#"{"errors":[{"message":"API rate limit exceeded"}]}"#, 1), vec![None]);
    }
}
