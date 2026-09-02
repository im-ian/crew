import { describe, expect, it } from "vitest";
import { interpolate, translate } from "./i18n";
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
