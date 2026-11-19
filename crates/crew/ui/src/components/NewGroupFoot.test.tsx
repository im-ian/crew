import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { makeT } from "../i18n";
import { NewGroupFoot } from "./NewGroupModal";

const t = makeT("ko");
const foot = (props: Partial<Parameters<typeof NewGroupFoot>[0]>) =>
  renderToStaticMarkup(
    <NewGroupFoot t={t} making={null} failure={null} canCreate onClose={() => {}} onCreate={() => {}} {...props} />,
  );

describe("the New group dialog's foot", () => {
  it("offers to create", () => {
    const html = foot({});
    expect(html).toContain("만들기");
    expect(html).not.toContain("disabled");
  });

  it("shows how many bots are made, and locks both buttons", () => {
    const html = foot({ making: { done: 2, total: 8 } });
    expect(html).toContain("만드는 중 2/8");
    expect(html).toContain('aria-busy="true"');
    expect(html.match(/disabled=""/g)?.length).toBe(2);
  });

  it("says what was left when a bot failed, and only closes", () => {
    const html = foot({
      failure: { ok: false, stage: "add", error: "claude 없음", made: ["a", "b"], total: 8, groupName: "팀" },
    });
    expect(html).toContain("봇 8개 중 2개를 만들고 멈췄어요: claude 없음");
    expect(html).toContain("팀");
    expect(html).toContain("그룹에 남겨 뒀고");
    expect(html).toContain("닫기");
    expect(html).not.toContain("만들기<");
  });

  it("lets the user try again when nothing was made", () => {
    const html = foot({
      failure: { ok: false, stage: "reserve", error: "데몬 없음", made: [], total: 8, groupName: "팀" },
    });
    expect(html).toContain("아무것도 만들지 않았으니 다시 눌러도 돼요");
    expect(html).toContain("만들기");
    expect(html).toContain("취소");
  });
});
