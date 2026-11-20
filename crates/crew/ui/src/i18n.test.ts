import { describe, expect, it } from "vitest";
import { dropShortcut, interpolate, makeT, translate } from "./i18n";
import { EN, KO } from "./locales";

describe("interpolate", () => {
  it("fills named slots and leaves unknown ones visible", () => {
    expect(interpolate("{name} 작업 중", { name: "봇" })).toBe("봇 작업 중");
    expect(interpolate("{a}-{b}", { a: 1, b: 2 })).toBe("1-2");
    expect(interpolate("{name} 작업 중")).toBe("{name} 작업 중");
    expect(interpolate("{missing}", { name: "봇" })).toBe("{missing}");
  });
});

describe("translate", () => {
  it("reads from the table for the chosen language", () => {
    expect(translate("ko", "settings.title")).toBe("설정");
    expect(translate("en", "settings.title")).toBe("Settings");
  });

  it("falls back to Korean for an unknown language", () => {
    // @ts-expect-error - a stored preference could be anything
    expect(translate("fr", "settings.title")).toBe("설정");
  });
});

describe("the user's name", () => {
  it("is 나 / You when unset", () => {
    expect(makeT("ko")("thread.you")).toBe("나");
    expect(makeT("en", "")("thread.you")).toBe("You");
  });

  it("replaces 나 / You in both languages and nothing else", () => {
    expect(makeT("ko", "민수")("thread.you")).toBe("민수");
    expect(makeT("en", "민수")("thread.you")).toBe("민수");
    expect(makeT("ko", "민수")("settings.title")).toBe("설정");
  });
});

describe("locale tables", () => {
  it("carry the same keys", () => {
    expect(Object.keys(EN).sort()).toEqual(Object.keys(KO).sort());
  });

  it("leave no entry empty", () => {
    for (const [key, value] of Object.entries({ ...KO })) {
      expect(value.trim(), `ko ${key}`).not.toBe("");
    }
    for (const [key, value] of Object.entries({ ...EN })) {
      expect(value.trim(), `en ${key}`).not.toBe("");
    }
  });

  it("use the same slots on both sides", () => {
    const slots = (s: string) => (s.match(/\{\w+\}/g) || []).sort();
    for (const key of Object.keys(KO) as (keyof typeof KO)[]) {
      expect(slots(EN[key]), key).toEqual(slots(KO[key]));
    }
  });
});

describe("dropShortcut", () => {
  it("drops a shortcut at the end of a label, for touch", () => {
    expect(dropShortcut("검색 ⌘F")).toBe("검색");
    expect(dropShortcut("멈추고 바로 보내기 ⌘⇧↩")).toBe("멈추고 바로 보내기");
    expect(dropShortcut("중지 ⌘.")).toBe("중지");
    expect(dropShortcut("Bot info ⌘I")).toBe("Bot info");
  });

  it("leaves text that only mentions a shortcut", () => {
    const note = "창 전체를 키우거나 줄이려면 ⌘+ / ⌘−를 누르세요.";
    expect(dropShortcut(note)).toBe(note);
    expect(dropShortcut("메시지")).toBe("메시지");
  });

  it("is what a touch t() gives", () => {
    expect(makeT("ko", "", true)("header.botInfo")).toBe("봇 정보");
    expect(makeT("ko")("header.botInfo")).toBe("봇 정보 ⌘I");
  });
});
