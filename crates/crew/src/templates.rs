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
                "여러 영역에 걸친 큰 일을 조사·설계·구현·검토·검증·배포로 나눠 8명이 맡아요.",
                "Eight bots split large work across areas: research, design, build, review, QA and deploy.",
            ),
            bots: vec![
                bot(
                    ("리드", "Lead"),
                    ("목표와 범위를 쪼개 팀원에게 맡기고, 팀원의 질문을 모아 사용자에게 물어요. 결과를 합쳐 최종 확인해요.", "Breaks the goal and scope into work for the team, gathers the team's questions for the user, and puts the results together for a final check."),
                    "claude", Strong, "high", S::Crown,
                ),
                bot(
                    ("리서처", "Researcher"),
                    ("착수 전에 기존 코드·문서·자료를 조사해 근거와 선택지를 정리해요.", "Before work starts, looks through the existing code, docs and material, and lays out the evidence and the options."),
                    "grok", Normal, "medium", S::Bulb,
                ),
                bot(
                    ("디자이너", "Designer"),
                    ("화면과 흐름의 시안을 만들고, 구현 전에 HTML 미리보기로 맞춰요.", "Draws the screens and flows and settles them in an HTML preview before they are built."),
                    "claude", Normal, "high", S::Palette,
                ),
                bot(
                    ("프론트엔드 개발자", "Frontend developer"),
                    ("화면을 구현하고 테스트까지 돌려요.", "Builds the screens and runs the tests."),
                    "claude", Strong, "medium", S::RoundedSquare,
                ),
                bot(
                    ("백엔드 개발자", "Backend developer"),
                    ("서버와 데이터 쪽을 구현하고 테스트까지 돌려요.", "Builds the server and data side and runs the tests."),
                    "codex", Strong, "medium", S::Hexagon,
                ),
                bot(
                    ("리뷰어", "Reviewer"),
                    ("다른 팀원의 변경을 독립된 눈으로 검토해 버그와 위험을 짚어요. 직접 고치지 않고 근거와 함께 돌려줘요.", "Reviews the others' changes with fresh eyes and points out bugs and risks. It does not fix them itself; it hands them back with the evidence."),
                    "claude", Strong, "high", S::Gem,
                ),
                bot(
                    ("QA", "QA"),
                    ("시나리오를 세워 실제 동작을 검증하고, 재현 방법과 결과를 근거와 함께 보고해요.", "Sets up scenarios, checks how things really behave, and reports the steps and results with the evidence."),
                    "grok", Normal, "medium", S::Shield,
                ),
                bot(
                    ("인프라·배포 담당", "Infra & deploys"),
                    ("빌드·배포·환경 설정을 맡고, 배포 뒤 상태를 확인해요.", "Looks after builds, deploys and environment settings, and checks things after each deploy."),
                    "codex", Fast, "medium", S::Cloud,
                ),
            ],
            lead: 0,
            memory: (
                "작업은 헤드리스로 한다. 앱·창은 띄우지 않고 확인이 필요하면 '앱 확인 필요'로 남긴다.\n보고에는 근거(파일·로그·PR)를 함께 단다.\n구현이 끝나면 리뷰어 검토와 QA 검증을 거쳐 리드에게 보고한다.\n배포와 데이터 변경은 리드가 확인한 뒤에 한다.",
                "Work headless. Do not open apps or windows; when something needs a look in the app, say \"needs a check in the app\".\nEvery report carries its evidence: files, logs, PRs.\nFinished work goes through the reviewer and QA before it is reported to the lead.\nDeploys and data changes wait for the lead's go.",
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
            let names: Vec<&str> = ops.bots.iter().map(|b| b.name.as_str()).collect();
            assert_eq!(
                names,
                [
                    "리드",
                    "리서처",
                    "디자이너",
                    "프론트엔드 개발자",
                    "백엔드 개발자",
                    "리뷰어",
                    "QA",
                    "인프라·배포 담당"
                ]
            );
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
