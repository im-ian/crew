/**
 * @vitest-environment happy-dom
 */
import { readFileSync } from "node:fs";
import { createRef, act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { translate } from "../i18n";
import { CloseButton } from "./CloseButton";
import { ConfirmDialog } from "./ConfirmDialog";
import { Modal } from "./Modal";

vi.mock("../LocaleContext", () => {
  const t = (key: Parameters<typeof translate>[1], vars?: Parameters<typeof translate>[2]) =>
    translate("ko", key, vars);
  return { useLocale: () => ({ locale: "ko", t }), useT: () => t };
});

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

describe("the close control", () => {
  it("is one button: the X icon, named for a screen reader and a tooltip, and it closes", () => {
    const onClick = vi.fn();
    const ref = createRef<HTMLButtonElement>();
    mount(<CloseButton ref={ref} className="img-preview-close" label="닫기" onClick={onClick} />);
    const button = document.querySelector("button.close-btn");
    expect(button).toBe(ref.current);
    expect(button?.className).toBe("close-btn img-preview-close");
    expect(button?.getAttribute("type")).toBe("button");
    expect(button?.getAttribute("aria-label")).toBe("닫기");
    expect(button?.getAttribute("title")).toBe("닫기");
    // The X is two strokes of the shared icon, at its default size.
    expect(button?.querySelectorAll("svg path")).toHaveLength(2);
    expect(button?.querySelector("svg")?.getAttribute("width")).toBe("16");
    act(() => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("is in every dialog's title bar for a phone, and closes it", () => {
    const onClose = vi.fn();
    mount(
      <Modal open title="설정" onClose={onClose}>
        <p>내용</p>
      </Modal>,
    );
    const button = document.querySelector(".dialog-head .close-btn.dialog-close");
    expect(button?.getAttribute("aria-label")).toBe("닫기");
    // The title and the button share the bar.
    expect(document.querySelector(".dialog-head h3")?.textContent).toBe("설정");
    act(() => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("sits against a control beside the title, both at the right: title, then [control][X]", () => {
    mount(
      <Modal
        open
        title="템플릿"
        onClose={() => {}}
        aside={
          <button type="button" className="primary sm">
            새 템플릿
          </button>
        }
      >
        <p>내용</p>
      </Modal>,
    );
    const head = document.querySelector(".dialog-head");
    // The bar holds the title and one group, so the group is what goes to the right edge.
    expect([...(head?.children ?? [])].map((c) => c.tagName + "." + c.className)).toEqual([
      "H3.",
      "DIV.dialog-head-end",
    ]);
    const end = head?.querySelector(".dialog-head-end");
    expect([...(end?.children ?? [])].map((c) => c.className)).toEqual([
      "primary sm",
      "close-btn dialog-close",
    ]);
  });

  it("keeps the right-hand group at the right and out of the way when empty", () => {
    const css = readFileSync("src/styles.css", "utf8");
    expect(css).toMatch(/\.dialog-head-end\s*\{[^}]*margin-left:\s*auto/);
    expect(css).toMatch(/\.dialog-head-end\s*\{[^}]*display:\s*flex/);
    expect(css).toMatch(/\.dialog-head-end:empty\s*\{[^}]*display:\s*none/);
  });

  it("is left out of a dialog whose own buttons are the choice", () => {
    mount(
      <ConfirmDialog open kind="remove" onCancel={() => {}} onConfirm={() => {}} />,
    );
    expect(document.querySelector(".close-btn")).toBeNull();
    mount(
      <Modal open title="선택" onClose={() => {}} closeButton={false}>
        <p>내용</p>
      </Modal>,
    );
    expect(document.querySelectorAll(".dialog-close")).toHaveLength(0);
  });

  it("is the only close control an overlay draws: panels, the bot sheet and the picture overlay use it", () => {
    for (const name of ["LeadGroupPane", "FileView", "PeekRoom", "AgentPane", "MediaPreview", "Modal"]) {
      const source = readFileSync(`src/components/${name}.tsx`, "utf8");
      expect(source, name).toContain("<CloseButton");
      expect(source, name).not.toContain("sheet-close");
      expect(source, name).not.toMatch(/className="head-action"[^>]*\n[^>]*\n[^>]*onClose/);
    }
  });
});
