/**
 * @vitest-environment happy-dom
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { translate } from "../i18n";
import { NewBotModal, type NewBotProblem } from "./NewBotModal";

vi.mock("../LocaleContext", () => {
  const t = (key: Parameters<typeof translate>[1], vars?: Parameters<typeof translate>[2]) =>
    translate("ko", key, vars);
  return { useLocale: () => ({ locale: "ko", t }), useT: () => t };
});

vi.mock("../api", () => ({
  api: {
    listModels: vi.fn(async () => ({ installed: true, models: [], default: null })),
  },
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

function typeName(value: string) {
  const input = document.getElementById("new-name");
  if (!(input instanceof HTMLInputElement)) throw new Error("no name field");
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!set) throw new Error("no value setter");
  act(() => {
    set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function pressCreate() {
  const button = [...document.querySelectorAll("button")].find((b) => b.textContent === "만들기");
  if (!(button instanceof HTMLButtonElement)) throw new Error("no create button");
  await act(async () => {
    button.click();
    await new Promise((r) => setTimeout(r, 0));
  });
}

function fieldError(id: string): string | undefined {
  const input = document.getElementById(id);
  return input?.closest(".field-block")?.querySelector(".field-error")?.textContent ?? undefined;
}

describe("NewBotModal field errors", () => {
  it("shows an empty name under the name field", async () => {
    let seen = "";
    const onCreate = vi.fn(async (args: { name: string }): Promise<NewBotProblem | null> => {
      seen = args.name;
      return { field: "name", message: "이름을 입력하세요" };
    });
    mount(<NewBotModal open groups={[]} onClose={() => {}} onCreate={onCreate} />);
    await pressCreate();
    expect(onCreate).toHaveBeenCalledOnce();
    expect(seen).toBe("");
    expect(fieldError("new-name")).toBe("이름을 입력하세요");
  });

  it("shows a missing command under the AI field", async () => {
    let seen = "";
    const onCreate = vi.fn(async (args: { name: string }): Promise<NewBotProblem | null> => {
      seen = args.name;
      return { field: "cmd", message: "명령을 입력하세요" };
    });
    mount(<NewBotModal open groups={[]} onClose={() => {}} onCreate={onCreate} />);
    typeName("하나");
    await pressCreate();
    expect(seen).toBe("하나");
    const ai = [...document.querySelectorAll(".field-block")].find((el) =>
      el.querySelector(".model-pick"),
    );
    expect(ai?.querySelector(".field-error")?.textContent).toBe("명령을 입력하세요");
    expect(fieldError("new-name")).toBeUndefined();
  });

  it("clears the name error once a name is typed", async () => {
    const onCreate = vi.fn(
      async (): Promise<NewBotProblem | null> => ({ field: "name", message: "이름을 입력하세요" }),
    );
    mount(<NewBotModal open groups={[]} onClose={() => {}} onCreate={onCreate} />);
    await pressCreate();
    typeName("하나");
    expect(document.querySelector(".field-error")).toBeNull();
  });
});
