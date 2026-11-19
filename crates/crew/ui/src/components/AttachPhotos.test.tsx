/**
 * @vitest-environment happy-dom
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { translate } from "../i18n";
import type { AgentInfo } from "../types";
import { AttachPhotos, type AttachPhoto } from "./AttachPhotos";
import { attachMarkdown } from "./Composer";
import { MdBody } from "./MdBody";

vi.mock("../LocaleContext", () => {
  const t = (key: Parameters<typeof translate>[1], vars?: Parameters<typeof translate>[2]) =>
    translate("ko", key, vars);
  return { useLocale: () => ({ locale: "ko", t }), useT: () => t };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => `asset://localhost${encodeURI(path)}`,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function mount(node: ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(node));
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  document.body.innerHTML = "";
});

const photos: AttachPhoto[] = [
  { id: "1", name: "a.png", path: "/tmp/a.png", preview: "data:image/png;base64,aaa" },
  { id: "2", name: "b.mp4", path: "/tmp/b.mp4", preview: "blob:bbb", media: "video" },
  { id: "3", name: "c.png", path: "/tmp/c.png", preview: "data:image/png;base64,ccc" },
];

function frame(name: string): HTMLButtonElement {
  const el = document.querySelector(`button.attach-photo-frame[aria-label="${name}"]`);
  if (!(el instanceof HTMLButtonElement)) throw new Error(`no thumbnail ${name}`);
  return el;
}

function press(key: string) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

describe("attachment thumbnails", () => {
  it("opens the preview on a click and steps through photos and clips", () => {
    mount(<AttachPhotos photos={photos} onRemove={() => {}} />);
    act(() => frame("a.png").click());
    const img = document.querySelector(".img-preview img");
    expect(img?.getAttribute("src")).toBe(photos[0].preview);
    expect(document.querySelector(".img-preview-count")?.textContent).toBe("1 / 3");

    press("ArrowRight");
    expect(document.querySelector(".img-preview video")?.getAttribute("src")).toBe(photos[1].preview);
    expect(document.querySelector(".img-preview img")).toBeNull();
    expect(document.querySelector(".img-preview-count")?.textContent).toBe("2 / 3");

    press("ArrowRight");
    expect(document.querySelector(".img-preview img")?.getAttribute("src")).toBe(photos[2].preview);
    expect(document.querySelector(".img-preview-count")?.textContent).toBe("3 / 3");

    press("ArrowLeft");
    expect(document.querySelector(".img-preview video")?.getAttribute("src")).toBe(photos[1].preview);
  });

  it("opens the same preview from the keyboard", () => {
    mount(<AttachPhotos photos={photos} onRemove={() => {}} />);
    act(() => {
      frame("c.png").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(document.querySelector(".img-preview img")?.getAttribute("src")).toBe(photos[2].preview);
    expect(document.querySelector(".img-preview-count")?.textContent).toBe("3 / 3");
  });

  it("does not open the preview when the attachment is removed", () => {
    const onRemove = vi.fn();
    mount(<AttachPhotos photos={photos} onRemove={onRemove} />);
    const remove = document.querySelector('[aria-label="a.png 첨부 빼기"]');
    if (!(remove instanceof HTMLButtonElement)) throw new Error("no remove button");
    expect(remove.closest(".attach-photo-frame")).toBeNull();
    act(() => remove.click());
    expect(onRemove).toHaveBeenCalledOnce();
    expect(onRemove).toHaveBeenCalledWith("1");
    expect(document.querySelector(".img-preview")).toBeNull();
  });
});

const agents: AgentInfo[] = [];

function openShot(label: string) {
  const el = document.querySelector(`[aria-label="${label}"]`);
  if (!(el instanceof HTMLElement)) throw new Error(`no shot ${label}`);
  act(() => el.click());
}

describe("sent attachments", () => {
  // Paste and the attach button both save a copy under uploads. A Finder drop
  // keeps the file where it sits. Each becomes the same picture markdown.
  const cases = [
    { name: "shot.png", path: "/Users/me/Library/Application Support/crew/uploads/1-shotpng" },
    { name: "pick.png", path: "/Users/me/Library/Application Support/crew/uploads/1-pickpng" },
    { name: "My Photo.png", path: "/Users/me/Desktop/My Photo.png" },
  ];

  it("opens a pasted upload, a picked file, and a Finder path", () => {
    for (const item of cases) {
      const text = attachMarkdown({ name: item.name, path: item.path, image: true });
      mount(<MdBody text={text} agents={agents} />);
      openShot(item.name);
      const src = document.querySelector(".img-preview img")?.getAttribute("src") || "";
      expect(decodeURI(src)).toContain(item.path);
      act(() => root?.unmount());
      host?.remove();
      root = undefined;
      document.body.innerHTML = "";
    }
  });

  it("opens a clip that was attached without an extension", () => {
    const path = "/Users/me/Library/Application Support/crew/uploads/1-clipmp4";
    const text = attachMarkdown({ name: "clip.mp4", path, image: false, media: "video" });
    mount(<MdBody text={text} agents={agents} />);
    openShot("재생: clip.mp4");
    expect(document.querySelector(".img-preview video")?.getAttribute("src")).toContain("1-clipmp4");
  });
});
