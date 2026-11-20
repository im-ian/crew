import { describe, expect, it } from "vitest";
import { collectArchive, dayOf, linkItem, looksSecret, matches, mergeArchives, shownKind } from "./archive";
import type { ChatMessage } from "./types";

const at = (id: string, role: ChatMessage["role"], text: string, ts: number, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id, role, from: role === "user" ? "user" : "bot-a", text, ts, ...extra,
});

describe("collectArchive", () => {
  const chat = [
    at("1", "user", "이거 봐 줘\n\n![image.png](</Users/me/Library/Application Support/crew/uploads/2026-11-20-image_png.png>)", 10),
    at("2", "assistant", "PR을 열었어요: https://github.com/im-ian/crew/pull/377. 문서는 https://v2.tauri.app/security/scope/ 에 있어요.", 20),
    at("3", "assistant", "다시 링크: https://github.com/im-ian/crew/pull/377#issuecomment-1 그리고 `/tmp/bo-shots/handle.png` 와 `src/app.ts:12`", 30),
    at("4", "system", "/Users/me/docs/mobile.md:40", 40, { kind: "file", from: "crew" }),
    at("5", "assistant", "```sh\ncurl https://api.example.com/x?token=abc\n```\n그리고 https://example.com/reset?token=abc123", 50),
  ];
  const items = collectArchive(chat, "bot-a");
  const keys = items.map((i) => i.key);

  it("keeps one entry per address, at the first line that said it", () => {
    expect(keys.filter((k) => k.includes("/pull/377"))).toEqual(["https://github.com/im-ian/crew/pull/377"]);
    expect(items.find((i) => i.kind === "pr")).toMatchObject({ msgId: "2", ts: 20, where: "im-ian/crew", num: "377", agent: "bot-a" });
  });

  it("names a docs page by its last part, under its host", () => {
    expect(items.find((i) => i.key === "https://v2.tauri.app/security/scope")).toMatchObject({ kind: "link", title: "scope", where: "v2.tauri.app/security" });
  });

  it("calls a docs site a document", () => {
    expect(linkItem("https://docs.github.com/en/rest")).toMatchObject({ kind: "doc", title: "rest" });
  });

  it("finds files: attached, named in a reply, and shown with crew show", () => {
    expect(items.find((i) => i.key.endsWith("image_png.png"))).toMatchObject({ section: "files", kind: "image", from: "attached" });
    expect(items.find((i) => i.key === "/tmp/bo-shots/handle.png")).toMatchObject({ kind: "image", from: "named", title: "handle.png", where: "/tmp/bo-shots" });
    expect(items.find((i) => i.key === "/Users/me/docs/mobile.md")).toMatchObject({ kind: "text", from: "shown", msgId: "4" });
  });

  it("leaves out relative paths, code fences, and links that may carry a secret", () => {
    expect(keys.some((k) => k.includes("app.ts"))).toBe(false);
    expect(keys.some((k) => k.includes("token"))).toBe(false);
  });

  it("does not read a user's own words for links", () => {
    const own = collectArchive([at("9", "user", "https://example.com/mine", 1)], "bot-a");
    expect(own).toEqual([]);
  });
});

describe("links", () => {
  it("knows issues and releases on GitHub", () => {
    expect(linkItem("https://github.com/im-ian/crew/issues/375")).toMatchObject({ kind: "issue", title: "im-ian/crew #375" });
    expect(linkItem("https://github.com/im-ian/crew/releases/tag/v0.13.0")).toMatchObject({ kind: "release", title: "v0.13.0" });
  });

  it("ends a link at a backslash a reply wrote as text", () => {
    const [item] = collectArchive([at("1", "assistant", "PR: https://github.com/a/b/pull/3\\n이슈", 1)], "bot-a");
    expect(item.key).toBe("https://github.com/a/b/pull/3");
  });

  it("calls a link with a credential in it secret", () => {
    expect(looksSecret(new URL("https://u:p@example.com/"))).toBe(true);
    expect(looksSecret(new URL("https://example.com/cb?access_token=1"))).toBe(true);
    expect(looksSecret(new URL("https://example.com/s/ghp_aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5zA7b"))).toBe(true);
    expect(looksSecret(new URL("https://github.com/im-ian/crew/pull/377"))).toBe(false);
  });
});

describe("together", () => {
  it("keeps the earliest of the bots that said the same thing", () => {
    const a = collectArchive([at("1", "assistant", "https://x.dev/a", 50)], "bot-a");
    const b = collectArchive([{ ...at("2", "assistant", "https://x.dev/a", 20), from: "bot-b" }], "bot-b");
    expect(mergeArchives([a, b])).toMatchObject([{ agent: "bot-b", ts: 20 }]);
  });

  it("puts a time in today, this week, or before", () => {
    const now = new Date(2026, 10, 20, 15).getTime();
    expect(dayOf(new Date(2026, 10, 20, 1).getTime(), now)).toBe("today");
    expect(dayOf(new Date(2026, 10, 16).getTime(), now)).toBe("week");
    expect(dayOf(new Date(2026, 10, 1).getTime(), now)).toBe("older");
  });

  it("finds by title, place, or address", () => {
    const [item] = collectArchive([at("1", "assistant", "https://github.com/im-ian/crew/pull/12", 1)], "bot-a");
    expect(matches(item, "pr #12")).toBe(true);
    expect(matches(item, "im-ian")).toBe(true);
    expect(matches(item, "nothing")).toBe(false);
  });
});

describe("shownKind", () => {
  it("follows GitHub when an issue address is a PR", () => {
    const [item] = collectArchive([at("1", "assistant", "https://github.com/im-ian/crew/issues/375", 1)], "bot-a");
    expect(item.kind).toBe("issue");
    expect(shownKind(item, { kind: "pr" })).toBe("pr");
    expect(shownKind(item, undefined)).toBe("issue");
    const [doc] = collectArchive([at("2", "assistant", "https://docs.github.com/en/rest", 1)], "bot-a");
    expect(shownKind(doc, { kind: "pr" })).toBe("doc");
  });
});
