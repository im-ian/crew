import { describe, expect, it } from "vitest";
import { routineSwitchName } from "./routineNote";

describe("routineSwitchName", () => {
  it("reads the routine name from a switch note", () => {
    expect(routineSwitchName("‘노션 이슈 처리’ 루틴을 껐습니다.")).toBe(
      "노션 이슈 처리",
    );
    expect(routineSwitchName("‘아침’ 루틴을 켰습니다.")).toBe("아침");
    expect(routineSwitchName("Turned off the “Notion issues” routine.")).toBe(
      "Notion issues",
    );
    expect(routineSwitchName("Turned on the “brief” routine.")).toBe("brief");
  });

  it("ignores other crew notes", () => {
    expect(routineSwitchName("삭제할까요?")).toBeNull();
    expect(routineSwitchName("‘아침’ 루틴을 삭제했습니다.")).toBeNull();
    expect(routineSwitchName("")).toBeNull();
  });
});
