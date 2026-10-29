import { describe, expect, it } from "vitest";
import { answeredOptionView, otherBadge } from "./choiceView";
import type { ChoiceOption } from "./types";

const options: ChoiceOption[] = [
  { id: "A", label: "PR 생성까지만 하고, 머지·배포는 내 허락 후" },
  { id: "B", label: "머지 + develop 배포 + 실제 화면 확인까지 자동" },
  { id: "C", label: "원인 분석·개발팀 메모 작성까지만 (코드 수정 없음)" },
];

describe("answeredOptionView", () => {
  it("keeps the stored option's letter after the other rows are hidden", () => {
    const saved = options.filter((o) => o.id === "B");
    const view = answeredOptionView(options, saved[0]);
    expect(view.badge).toBe("B");
    expect(view.title).toBe("머지 + develop 배포 + 실제 화면 확인까지 자동");
  });

  it("uses a short label as the badge", () => {
    const short: ChoiceOption[] = [
      { id: "A", label: "가" },
      { id: "B", label: "나" },
    ];
    const view = answeredOptionView(short, short[1]);
    expect(view.badge).toBe("나");
  });
});

describe("otherBadge", () => {
  it("takes the letter after the options", () => {
    expect(otherBadge(options)).toBe("D");
  });

  it("skips a letter a short label already shows", () => {
    const short: ChoiceOption[] = ["C", "D", "E"].map((label) => ({ id: label, label }));
    expect(otherBadge(short)).toBe("F");
  });
});
