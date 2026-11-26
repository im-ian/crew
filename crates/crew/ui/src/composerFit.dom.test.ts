/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { FIT_MAX, caretSpot, fitInput, maxInputHeight } from "./composerFit";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

/** An editor with `text` in it and the caret at `offset` characters in. */
function editor(text: string, offset: number): HTMLDivElement {
  const el = document.createElement("div");
  el.contentEditable = "true";
  el.textContent = text;
  document.body.appendChild(el);
  const sel = document.getSelection()!;
  sel.collapse(el.firstChild, offset);
  return el;
}

const noBox = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }) as DOMRect;

describe("caretSpot", () => {
  it("is the caret's rectangle on the page when the browser has one", () => {
    const el = editor("hello", 5);
    vi.spyOn(Range.prototype, "getClientRects").mockReturnValue([
      { top: 40, bottom: 58, height: 18 } as DOMRect,
    ] as unknown as DOMRectList);
    expect(caretSpot(el)).toEqual({ top: 40, bottom: 58 });
  });

  it("is the end of the text for a caret with no box of its own at the end (after a line break)", () => {
    const el = editor("one\ntwo\n", 8);
    vi.spyOn(Range.prototype, "getClientRects").mockReturnValue([] as unknown as DOMRectList);
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue(noBox());
    expect(caretSpot(el)).toBe("end");
  });

  it("is the start of the text for a caret with no box at the start, and nothing in the middle", () => {
    vi.spyOn(Range.prototype, "getClientRects").mockReturnValue([] as unknown as DOMRectList);
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue(noBox());
    expect(caretSpot(editor("one two", 0))).toBe("start");
    expect(caretSpot(editor("one two", 3))).toBeNull();
  });

  it("counts the line break a browser keeps after the last line as the end, and a chip after the caret as the middle", () => {
    vi.spyOn(Range.prototype, "getClientRects").mockReturnValue([] as unknown as DOMRectList);
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue(noBox());
    // "one", a line break, and the second one that holds the empty last line open.
    const lines = document.createElement("div");
    lines.contentEditable = "true";
    lines.innerHTML = "one<br><br>";
    document.body.appendChild(lines);
    document.getSelection()!.collapse(lines, 2);
    expect(caretSpot(lines)).toBe("end");
    // A mention chip after the caret is more text, not the end.
    const chip = document.createElement("div");
    chip.contentEditable = "true";
    chip.innerHTML = 'one <span class="mention-chip" contenteditable="false">@dev</span>';
    document.body.appendChild(chip);
    document.getSelection()!.collapse(chip.firstChild, 4);
    expect(caretSpot(chip)).toBeNull();
  });

  it("is nothing when the caret is not in this editor", () => {
    const el = editor("hello", 2);
    const other = document.createElement("div");
    other.textContent = "elsewhere";
    document.body.appendChild(other);
    document.getSelection()!.collapse(other.firstChild, 3);
    expect(caretSpot(el)).toBeNull();
  });
});

describe("maxInputHeight", () => {
  it("is the stylesheet's max-height, which follows the chat's text size, or the default", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    expect(maxInputHeight(el)).toBe(FIT_MAX);
    el.style.maxHeight = "168px";
    expect(maxInputHeight(el)).toBe(168);
    el.style.maxHeight = "none";
    expect(maxInputHeight(el)).toBe(FIT_MAX);
  });
});

describe("fitInput in a page", () => {
  it("sizes a real box to its content and leaves a caret that is in view alone", () => {
    const el = editor("one\ntwo", 7);
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => 90 });
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue({ top: 0, bottom: 120 } as DOMRect);
    vi.spyOn(Range.prototype, "getClientRects").mockReturnValue([
      { top: 70, bottom: 88, height: 18 } as DOMRect,
    ] as unknown as DOMRectList);
    el.scrollTop = 0;
    fitInput(el);
    expect(el.style.height).toBe("90px");
    expect(el.scrollTop).toBe(0);
  });
});
