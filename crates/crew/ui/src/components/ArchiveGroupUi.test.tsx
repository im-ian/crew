/**
 * @vitest-environment happy-dom
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { translate } from "../i18n";
import type { ArchivedGroup } from "../types";
import { ArchivedGroups } from "./ArchivedGroups";
import { ConfirmDialog } from "./ConfirmDialog";

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

const click = (el: Element | null | undefined) => {
  if (!el) throw new Error("nothing to click");
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};
const button = (label: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);

function held(id: string, name: string, bots: number, at = Date.UTC(2026, 10, 23, 3)): ArchivedGroup {
  return {
    id,
    name,
    archived_at: at,
    slot: null,
    routines: 2,
    bots: Array.from({ length: bots }, (_, i) => ({ id: `${id}-b${i}`, name: `봇${i}` })),
  };
}

describe("the confirm window for putting a group away", () => {
  const archive = (working: number) => (
    <ConfirmDialog
      open
      kind="archive-group"
      archiving={{ name: "Destia", bots: 4, routines: 3, working }}
      onCancel={() => {}}
      onConfirm={() => {}}
    />
  );

  it("says how many bots and routines go, and that chats stay", () => {
    mount(archive(0));
    const text = document.body.textContent ?? "";
    expect(text).toContain("그룹을 보관할까요?");
    expect(text).toContain("Destia의 봇 4개와 루틴 3개를 보관해요");
    expect(text).toContain("대화·메모리·작업 폴더는 그대로 남고");
    expect(text).not.toContain("작업 중이에요");
    expect(button("보관")).toBeTruthy();
    expect(button("삭제")).toBeUndefined();
  });

  it("asks again about the bots at work", () => {
    mount(archive(2));
    expect(document.body.textContent).toContain("봇 2개가 작업 중이에요. 멈추고 보관할까요?");
    expect(document.querySelector(".confirm-working")?.getAttribute("role")).toBe("alert");
  });

  it("makes deleting an archived group a danger button that says it is for good", () => {
    mount(
      <ConfirmDialog
        open
        kind="delete-archived"
        deleting={{ name: "Destia", bots: 4 }}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );
    const text = document.body.textContent ?? "";
    expect(text).toContain("보관된 그룹을 영구 삭제할까요?");
    expect(text).toContain("Destia의 봇 4개와 그 대화·메모리가 지워지고 되돌릴 수 없어요");
    expect(button("영구 삭제")?.className).toContain("danger");
  });
});

describe("the archived groups under the rail", () => {
  it("shows nothing when none is archived", () => {
    mount(<ArchivedGroups groups={[]} onRestore={() => {}} onDelete={() => {}} />);
    expect(document.body.innerHTML).toBe("<div></div>");
  });

  it("is a folded count until opened, then lists each group", () => {
    mount(
      <ArchivedGroups
        groups={[held("g1", "Destia", 5), held("g2", "Labs", 1)]}
        onRestore={() => {}}
        onDelete={() => {}}
      />,
    );
    const head = document.querySelector(".archived-head");
    expect(head?.textContent).toContain("보관된 그룹");
    expect(head?.textContent).toContain("2");
    expect(document.querySelector(".archived-list")).toBeNull();
    click(head);
    const rows = [...document.querySelectorAll(".archived-row")];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Destia");
    expect(rows[0].textContent).toContain("봇 5개");
    expect(rows[0].textContent).toContain("11월 23일 보관");
    // Three faces and the count of the rest.
    expect(rows[0].querySelectorAll(".archived-face")).toHaveLength(3);
    expect(rows[0].querySelector(".archived-more")?.textContent).toBe("+2");
    expect(rows[1].querySelector(".archived-more")).toBeNull();
    click(head);
    expect(document.querySelector(".archived-list")).toBeNull();
  });

  it("restores or deletes the group of the row it is pressed in", () => {
    const onRestore = vi.fn();
    const onDelete = vi.fn();
    mount(
      <ArchivedGroups
        groups={[held("g1", "Destia", 2), held("g2", "Labs", 1)]}
        onRestore={onRestore}
        onDelete={onDelete}
      />,
    );
    click(document.querySelector(".archived-head"));
    const second = document.querySelectorAll(".archived-row")[1];
    click([...second.querySelectorAll("button")].find((b) => b.textContent === "복구"));
    expect(onRestore).toHaveBeenCalledWith("g2");
    click([...second.querySelectorAll("button")].find((b) => b.textContent === "영구 삭제"));
    expect(onDelete).toHaveBeenCalledWith("g2");
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});
