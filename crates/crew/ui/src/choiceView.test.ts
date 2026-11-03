import { describe, expect, it } from "vitest";
import {
  answerSummary,
  answeredOptionView,
  blankDraft,
  draftTouched,
  dropChoiceDraft,
  keepChoiceDraft,
  otherBadge,
  questionDone,
  readChoiceDraft,
} from "./choiceView";
import type { ChoiceOption, ChoiceQuestion } from "./types";

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

describe("questionDone", () => {
  const pick = { question: "머지할까요?", options: [{ id: "A", label: "네" }, { id: "B", label: "아니요" }] };
  const form = {
    question: "로그인",
    options: [],
    fields: [
      { id: "a", label: "아이디", value: "" },
      { id: "b", label: "메모", value: "" },
    ],
  };

  it("counts a pick or a typed answer", () => {
    expect(questionDone(pick)).toBe(false);
    expect(questionDone(pick, ["A"])).toBe(true);
    expect(questionDone(pick, [], [], "  나중에  ")).toBe(true);
    expect(questionDone(pick, [], [], "   ")).toBe(false);
  });

  it("counts any filled box, since none is required", () => {
    expect(questionDone(form)).toBe(false);
    expect(questionDone(form, [], ["", "메모만"])).toBe(true);
    expect(questionDone(form, [], ["ian", ""])).toBe(true);
  });
});

describe("answerSummary", () => {
  it("lists picks, then what was typed, and hides secrets", () => {
    const q = {
      question: "스키마",
      multi: true,
      options: [{ id: "A", label: "48" }, { id: "B", label: "36" }, { id: "C", label: "56" }],
    };
    expect(answerSummary(q, ["C", "A"], [], " 36은 나중에 ")).toBe("48, 56, 36은 나중에");
    const login = {
      question: "로그인",
      options: [],
      fields: [
        { id: "a", label: "아이디", value: "" },
        { id: "b", label: "비밀번호", value: "", secret: true },
      ],
    };
    expect(answerSummary(login, [], ["ian", "pw"])).toBe("아이디: ian, 비밀번호: ••••••");
  });
});

describe("choice drafts", () => {
  const questions: ChoiceQuestion[] = [
    { question: "어느 쪽?", options },
    { question: "로그인", options: [], fields: [{ id: "u", label: "아이디", value: "ian" }] },
  ];

  it("starts from what the bot sent", () => {
    expect(blankDraft(questions)).toEqual({
      picks: [[], []],
      values: [[], ["ian"]],
      others: ["", ""],
      step: 0,
    });
    expect(draftTouched(questions, blankDraft(questions))).toBe(false);
  });

  it("sees a pick, a field or a typed answer as touched", () => {
    const blank = blankDraft(questions);
    expect(draftTouched(questions, { ...blank, picks: [["B"], []] })).toBe(true);
    expect(draftTouched(questions, { ...blank, values: [[], ["kim"]] })).toBe(true);
    expect(draftTouched(questions, { ...blank, others: ["직접", ""] })).toBe(true);
    expect(draftTouched(questions, { ...blank, step: 2 })).toBe(false);
  });

  it("keeps a draft until it is dropped, and forgets a blank one", () => {
    const touched = { ...blankDraft(questions), picks: [["A"], []] };
    keepChoiceDraft("card-1", questions, touched);
    expect(readChoiceDraft("card-1")).toEqual(touched);
    keepChoiceDraft("card-1", questions, { ...blankDraft(questions), step: 1 });
    expect(readChoiceDraft("card-1")?.step).toBe(1);
    keepChoiceDraft("card-1", questions, blankDraft(questions));
    expect(readChoiceDraft("card-1")).toBeUndefined();
    keepChoiceDraft("card-1", questions, touched);
    dropChoiceDraft("card-1");
    expect(readChoiceDraft("card-1")).toBeUndefined();
  });
});
