//! Templates: a group's bots, its lead, its memory and its worktree switch,
//! to make a group from in one go. Crew's own are in this file and cannot be
//! removed; a copy of one is the user's to change. The user's live in
//! `templates.json` in the Crew home.
//!
//! A template keeps no face color: each bot gets one at random when a group
//! is made from it. Its shape is the template's.

use std::fs;
use std::path::PathBuf;

use anyhow::{bail, Context};
use serde::{Deserialize, Serialize};

use crate::config::AvatarShape;

/// How much model a bot needs. When its own CLI cannot run here, the app
/// picks the model of the same tier on a CLI that can.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    Strong,
    #[default]
    Normal,
    Fast,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TemplateBot {
    pub name: String,
    /// What the bot does. It goes in the bot's instructions.
    #[serde(default)]
    pub role: String,
    /// The CLI it wants: `claude`, `codex`, `grok`, …
    pub cli: String,
    /// A model on that CLI. Empty picks the tier's model.
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub tier: Tier,
    /// `low`, `medium`, `high`, or empty for the CLI's own.
    #[serde(default)]
    pub effort: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shape: Option<AvatarShape>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Template {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub bots: Vec<TemplateBot>,
    /// Index into `bots` of the group's lead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lead: Option<usize>,
    /// The group memory the group starts with.
    #[serde(default)]
    pub memory: String,
    /// Each bot works in a worktree of its own.
    #[serde(default = "yes")]
    pub worktree: bool,
    /// Crew's own: shown, copied, never written or removed.
    #[serde(default)]
    pub builtin: bool,
}

fn yes() -> bool {
    true
}

fn path() -> PathBuf {
    crate::paths::home_dir().join("templates.json")
}

/// Crew's templates, then the user's.
pub fn list(english: bool) -> Vec<Template> {
    let mut out = builtins(english);
    out.extend(load_mine());
    out
}

fn load_mine() -> Vec<Template> {
    let Ok(text) = fs::read_to_string(path()) else {
        return Vec::new();
    };
    let mut mine: Vec<Template> = serde_json::from_str(&text).unwrap_or_default();
    // A hand-edited file cannot pass one off as Crew's.
    for t in &mut mine {
        t.builtin = false;
    }
    mine.retain(|t| !is_builtin_id(&t.id));
    mine
}

fn write_mine(mine: &[Template]) -> anyhow::Result<()> {
    crate::paths::ensure_home()?;
    let bytes = serde_json::to_vec_pretty(mine)?;
    crate::paths::write_atomic(&path(), &bytes).context("write templates.json")?;
    Ok(())
}

fn is_builtin_id(id: &str) -> bool {
    BUILTINS.iter().any(|b| b.id == id)
}

/// Adds the template, or replaces the user's one with its id. One with no id
/// is new and gets one. Crew's own cannot be written: copy it first.
pub fn save(mut t: Template) -> anyhow::Result<Template> {
    t.id = t.id.trim().to_string();
    if is_builtin_id(&t.id) {
        bail!("Crew's templates cannot be changed. Copy one to change it.");
    }
    t.name = t.name.trim().to_string();
    if t.name.is_empty() {
        bail!("a template needs a name");
    }
    t.description = t.description.trim().to_string();
    for bot in &mut t.bots {
        bot.name = bot.name.trim().to_string();
        bot.role = bot.role.trim().to_string();
        bot.cli = bot.cli.trim().to_string();
        bot.model = bot.model.trim().to_string();
        bot.effort = bot.effort.trim().to_string();
        if bot.name.is_empty() {
            bail!("every bot in a template needs a name");
        }
        if bot.cli.is_empty() {
            bail!("{} has no AI", bot.name);
        }
    }
    if t.lead.is_some_and(|i| i >= t.bots.len()) {
        t.lead = None;
    }
    t.builtin = false;
    let mut mine = load_mine();
    if t.id.is_empty() {
        t.id = new_id(&mine);
        mine.push(t.clone());
    } else if let Some(slot) = mine.iter_mut().find(|m| m.id == t.id) {
        *slot = t.clone();
    } else {
        mine.push(t.clone());
    }
    write_mine(&mine)?;
    Ok(t)
}

pub fn remove(id: &str) -> anyhow::Result<()> {
    if is_builtin_id(id) {
        bail!("Crew's templates cannot be removed.");
    }
    let mut mine = load_mine();
    mine.retain(|t| t.id != id);
    write_mine(&mine)
}

fn new_id(mine: &[Template]) -> String {
    let n = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let mut id = format!("tpl-{n:x}");
    let mut i = 2;
    while mine.iter().any(|t| t.id == id) {
        id = format!("tpl-{n:x}-{i}");
        i += 1;
    }
    id
}

/// One line of a built-in, in Korean and in English.
type Text = (&'static str, &'static str);

struct BuiltinBot {
    name: Text,
    role: Text,
    cli: &'static str,
    tier: Tier,
    effort: &'static str,
    shape: AvatarShape,
}

struct Builtin {
    id: &'static str,
    name: Text,
    description: Text,
    bots: Vec<BuiltinBot>,
    lead: usize,
    memory: Text,
    worktree: bool,
}

const HEADLESS: Text = (
    "작업은 헤드리스로 한다. 앱·창은 띄우지 않고 확인이 필요하면 '앱 확인 필요'로 남긴다.",
    "Work headless. Do not open apps or windows; when something needs a look in the app, say \"needs a check in the app\".",
);

fn bot(
    name: Text,
    role: Text,
    cli: &'static str,
    tier: Tier,
    effort: &'static str,
    shape: AvatarShape,
) -> BuiltinBot {
    BuiltinBot {
        name,
        role,
        cli,
        tier,
        effort,
        shape,
    }
}

// The lead's reporting rules are not in these memories: a group with a lead
// gets them on its own (`lead_guidance`).
static BUILTINS: std::sync::LazyLock<Vec<Builtin>> = std::sync::LazyLock::new(|| {
    use AvatarShape as S;
    use Tier::*;
    vec![
        Builtin {
            id: "crew-dev",
            name: ("개발 팀", "Dev team"),
            description: (
                "대표가 일을 나눠 맡기고, 개발·디버깅을 각자 맡아 보고해요.",
                "The lead hands out the work; development and debugging each report back.",
            ),
            bots: vec![
                bot(
                    ("설계자", "Architect"),
                    ("일을 나눠 맡기고 보고를 받아 정리해요.", "Splits the work, hands it out, and pulls the reports together."),
                    "claude", Strong, "high", S::Crown,
                ),
                bot(
                    ("개발자", "Developer"),
                    ("맡은 기능을 구현하고 테스트까지 돌려요.", "Builds the feature it is given and runs the tests."),
                    "claude", Strong, "high", S::Hexagon,
                ),
                bot(
                    ("주니어 개발자", "Junior developer"),
                    ("작고 분명한 일을 빠르게 처리해요.", "Takes small, clear tasks and finishes them fast."),
                    "grok", Normal, "medium", S::Cookie,
                ),
                bot(
                    ("디버거", "Debugger"),
                    ("버그의 원인을 찾아 재현과 근거를 남겨요.", "Finds the cause of a bug and leaves a repro and the evidence."),
                    "claude", Strong, "high", S::Burst,
                ),
            ],
            lead: 0,
            memory: HEADLESS,
            worktree: true,
        },
        Builtin {
            id: "crew-product",
            name: ("제품·디자인 팀", "Product & design team"),
            description: (
                "기획에서 시안, 구현, QA까지 한 흐름으로 이어요.",
                "Planning, mockups, building and QA in one flow.",
            ),
            bots: vec![
                bot(
                    ("기획자", "Planner"),
                    ("요구를 화면·기능 단위로 나눠 맡기고 결과를 확인해요.", "Breaks the request into screens and features, hands them out, and checks the result."),
                    "claude", Strong, "high", S::Bulb,
                ),
                bot(
                    ("디자이너", "Designer"),
                    ("화면 시안을 만들고, 구현 전에 HTML 미리보기로 맞춰요.", "Draws the screens and settles them in an HTML preview before they are built."),
                    "claude", Normal, "medium", S::Palette,
                ),
                bot(
                    ("프론트엔드 개발자", "Frontend developer"),
                    ("시안대로 화면을 구현하고 테스트까지 돌려요.", "Builds the screens to the mockup and runs the tests."),
                    "codex", Strong, "high", S::RoundedSquare,
                ),
                bot(
                    ("QA", "QA"),
                    ("시나리오대로 확인하고, 확인한 것과 못 한 것을 근거와 함께 보고해요.", "Checks each scenario and reports what was and was not checked, with the evidence."),
                    "grok", Normal, "medium", S::Shield,
                ),
            ],
            lead: 0,
            memory: (
                "작업은 헤드리스로 한다. 앱·창은 띄우지 않고 확인이 필요하면 '앱 확인 필요'로 남긴다.\n화면 작업은 구현 전에 디자이너의 HTML 시안으로 먼저 맞춘다.\nQA는 확인한 것과 못 한 것을 나눠 근거와 함께 보고한다.",
                "Work headless. Do not open apps or windows; when something needs a look in the app, say \"needs a check in the app\".\nScreens are settled in the designer's HTML mockup before they are built.\nQA reports what was checked and what was not, with the evidence.",
            ),
            worktree: true,
        },
        Builtin {
            id: "crew-research",
            name: ("리서치·문서 팀", "Research & docs team"),
            description: (
                "자료를 모으고 출처를 달아 문서로 정리해요.",
                "Gathers material, cites the sources, and writes it up.",
            ),
            bots: vec![
                bot(
                    ("리서처", "Researcher"),
                    ("질문을 나눠 맡기고, 찾은 내용을 결론으로 묶어요.", "Splits the question, hands it out, and ties the findings into a conclusion."),
                    "claude", Strong, "high", S::Crystal,
                ),
                bot(
                    ("조사원", "Investigator"),
                    ("자료를 찾아 출처와 함께 요약해요.", "Finds material and sums it up with its sources."),
                    "grok", Normal, "medium", S::Clover,
                ),
                bot(
                    ("문서 작성자", "Writer"),
                    ("조사 결과를 읽기 쉬운 문서로 정리해요.", "Turns the findings into a document that reads easily."),
                    "claude", Normal, "medium", S::Cup,
                ),
            ],
            lead: 0,
            memory: (
                "모든 주장에 출처(링크·문서 위치)를 붙인다.\n확인된 사실과 추측을 나눠 적는다.\n결과 문서는 그룹 폴더에 남기고 경로를 보고한다.",
                "Every claim carries its source (a link or where in a document).\nKeep what is confirmed apart from what is a guess.\nLeave the finished document in the group folder and report its path.",
            ),
            worktree: false,
        },
        Builtin {
            id: "crew-ops",
            name: ("복잡한 업무", "Complex work"),
            description: (
                "실제 서비스를 운영하듯 이슈 확인부터 구현·QA·배포까지 8명이 나눠 맡아요.",
                "Eight bots run a live service: from triaging issues to building, QA and deploys.",
            ),
            bots: vec![
                bot(
                    ("PM", "PM"),
                    ("기획·정책 문서를 근거로 일을 나눠 맡기고, 팀원의 질문을 모아 사용자에게 물어요. 결과는 근거를 보고 확인해요.", "Hands out the work based on the planning and policy docs, gathers the team's questions for the user, and checks results against their evidence."),
                    "claude", Strong, "high", S::Crown,
                ),
                bot(
                    ("이슈 담당", "Issue triage"),
                    ("이슈 트래커와 제보를 확인해 재현하고 분류해요. 맡을 봇을 정해 PM에게 올려요.", "Reads the issue tracker and reports, reproduces and sorts them, and brings them to the PM with who should take each."),
                    "grok", Normal, "medium", S::Bell,
                ),
                bot(
                    ("프론트엔드 개발자", "Frontend developer"),
                    ("사용자 화면을 구현하고 PR·리뷰 반영·CI 통과까지 맡아요.", "Builds the user-facing screens and sees each PR through review and CI."),
                    "claude", Strong, "high", S::RoundedSquare,
                ),
                bot(
                    ("백엔드 개발자", "Backend developer"),
                    ("API·데이터·서버 로직을 구현하고 PR·리뷰 반영·CI 통과까지 맡아요.", "Builds the APIs, data and server logic and sees each PR through review and CI."),
                    "codex", Strong, "high", S::Hexagon,
                ),
                bot(
                    ("백오피스 개발자", "Back-office developer"),
                    ("관리자 화면을 구현하고 PR·리뷰 반영·CI 통과까지 맡아요.", "Builds the admin screens and sees each PR through review and CI."),
                    "codex", Normal, "medium", S::Octagon,
                ),
                bot(
                    ("디자이너", "Designer"),
                    ("화면 시안을 만들고, 구현 전에 HTML 미리보기로 맞춰요.", "Draws the screens and settles them in an HTML preview before they are built."),
                    "claude", Normal, "medium", S::Palette,
                ),
                bot(
                    ("QA", "QA"),
                    ("테스트 데이터를 준비하고 시나리오대로 검증해요. 결과는 근거와 함께 보고해요.", "Prepares test data, checks each scenario, and reports the result with the evidence."),
                    "grok", Normal, "medium", S::Shield,
                ),
                bot(
                    ("인프라·배포 담당", "Infra & deploys"),
                    ("서버·배포·환경 설정을 맡고, 배포 뒤 상태를 확인해요.", "Looks after servers, deploys and environment settings, and checks the service after each deploy."),
                    "codex", Strong, "high", S::Cloud,
                ),
            ],
            lead: 0,
            memory: (
                "작업은 헤드리스로 한다. 앱·창은 띄우지 않고 확인이 필요하면 '앱 확인 필요'로 남긴다.\n보고에는 근거(문서·로그·PR 링크)를 같이 붙인다.\n배포와 DB 변경은 PM이 확인한 뒤에 한다.\n기획·정책 문서가 있으면 그것을 근거로 일하고, 문서와 다르게 해야 하면 PM에게 먼저 알린다.",
                "Work headless. Do not open apps or windows; when something needs a look in the app, say \"needs a check in the app\".\nEvery report carries its evidence: docs, logs, PR links.\nDeploys and database changes wait for the PM's go.\nWork from the planning and policy docs where they exist; tell the PM first before doing anything they do not say.",
            ),
            worktree: true,
        },
    ]
});

fn pick(text: Text, english: bool) -> String {
    (if english { text.1 } else { text.0 }).to_string()
}

pub fn builtins(english: bool) -> Vec<Template> {
    BUILTINS
        .iter()
        .map(|b| Template {
            id: b.id.to_string(),
            name: pick(b.name, english),
            description: pick(b.description, english),
            bots: b
                .bots
                .iter()
                .map(|bot| TemplateBot {
                    name: pick(bot.name, english),
                    role: pick(bot.role, english),
                    cli: bot.cli.to_string(),
                    model: String::new(),
                    tier: bot.tier,
                    effort: bot.effort.to_string(),
                    shape: Some(bot.shape),
                })
                .collect(),
            lead: Some(b.lead),
            memory: pick(b.memory, english),
            worktree: b.worktree,
            builtin: true,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths;

    fn mine(name: &str) -> Template {
        Template {
            id: String::new(),
            name: name.into(),
            description: "둘이 리뷰".into(),
            bots: vec![TemplateBot {
                name: "리뷰어".into(),
                role: "PR을 읽어요".into(),
                cli: "claude".into(),
                model: "opus".into(),
                tier: Tier::Strong,
                effort: "high".into(),
                shape: Some(AvatarShape::Star),
            }],
            lead: Some(0),
            memory: "규칙".into(),
            worktree: true,
            builtin: false,
        }
    }

    #[test]
    fn crew_has_four_templates_that_stay() {
        paths::testing::with_home("templates-builtin", || {
            let ko = builtins(false);
            let ids: Vec<&str> = ko.iter().map(|t| t.id.as_str()).collect();
            assert_eq!(
                ids,
                ["crew-dev", "crew-product", "crew-research", "crew-ops"]
            );
            let ops = &ko[3];
            assert_eq!(ops.bots.len(), 8);
            assert_eq!(ops.lead, Some(0));
            assert_eq!(ops.bots[0].name, "PM");
            assert!(ops.worktree);
            assert!(!ko[2].worktree, "research works in one folder");
            for t in &ko {
                assert!(t.builtin);
                assert!(t.lead.is_some_and(|i| i < t.bots.len()), "{}", t.id);
                assert!(t.bots.iter().all(|b| b.shape.is_some()), "{}", t.id);
                // The lead's reporting rules come on their own.
                assert!(!t.memory.contains("crew tell"), "{}", t.id);
            }
            let en = builtins(true);
            assert_eq!(en[0].name, "Dev team");
            assert_eq!(en[3].bots.len(), 8);

            assert!(save(Template {
                id: "crew-dev".into(),
                ..mine("x")
            })
            .is_err());
            assert!(remove("crew-ops").is_err());
            assert_eq!(list(false).len(), 4);
        });
    }

    #[test]
    fn the_users_templates_are_saved_changed_and_removed() {
        paths::testing::with_home("templates-mine", || {
            let saved = save(mine(" 리뷰 둘 ")).unwrap();
            assert!(saved.id.starts_with("tpl-"));
            assert_eq!(saved.name, "리뷰 둘");
            assert_eq!(list(false).len(), 5);

            let changed = save(Template {
                description: "바뀜".into(),
                lead: Some(9),
                ..saved.clone()
            })
            .unwrap();
            assert_eq!(changed.lead, None, "a lead past the end is no lead");
            let all = list(false);
            assert_eq!(all.len(), 5, "same id, replaced");
            assert_eq!(all[4].description, "바뀜");
            assert!(!all[4].builtin);

            assert!(save(mine("  ")).is_err(), "a name is needed");
            let mut nameless = mine("이름 없는 봇");
            nameless.bots[0].name = " ".into();
            assert!(save(nameless).is_err());

            remove(&saved.id).unwrap();
            assert_eq!(list(false).len(), 4);
        });
    }

    /// No face color is kept, and a file that says builtin is not believed.
    #[test]
    fn the_file_holds_shapes_not_colors() {
        paths::testing::with_home("templates-file", || {
            save(mine("얼굴")).unwrap();
            let text = fs::read_to_string(path()).unwrap();
            assert!(text.contains("\"shape\": \"star\""), "{text}");
            assert!(!text.contains("color"), "{text}");
            let forged = text.replace("\"builtin\": false", "\"builtin\": true");
            fs::write(path(), forged).unwrap();
            assert!(list(false).iter().filter(|t| t.builtin).count() == 4);
        });
    }
}
