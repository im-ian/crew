import { describe, expect, it } from "vitest";
import { FIT_MAX, caretScrollDelta, fitInput, type CaretSpot } from "./composerFit";

describe("caretScrollDelta", () => {
  const view = { top: 100, bottom: 220 };
  it("leaves a caret inside the view where it is", () => {
    expect(caretScrollDelta({ top: 150, bottom: 170 }, view)).toBe(0);
    expect(caretScrollDelta({ top: 100, bottom: 120 }, view)).toBe(0);
    expect(caretScrollDelta({ top: 200, bottom: 220 }, view)).toBe(0);
  });
  it("scrolls down by what hangs below, and up by what hangs above", () => {
    expect(caretScrollDelta({ top: 210, bottom: 232 }, view)).toBe(12);
    expect(caretScrollDelta({ top: 90, bottom: 110 }, view)).toBe(-10);
  });
  it("keeps the bottom, where the typing is, when the view is shorter than the caret", () => {
    expect(caretScrollDelta({ top: 120, bottom: 150 }, { top: 100, bottom: 110 })).toBe(40);
  });
});

/**
 * A box as a browser has it: `height: auto` makes it as tall as its content,
 * so nothing is left to scroll and `scrollTop` is 0 when the height is set back.
 */
function fakeBox(opts: { contentHeight: number; scrollTop: number; rect?: { top: number; bottom: number } }) {
  const el = {
    scrollTop: opts.scrollTop,
    scrollHeight: opts.contentHeight,
    heights: [] as string[],
    getBoundingClientRect: () => opts.rect ?? { top: 0, bottom: FIT_MAX },
    style: {
      set height(v: string) {
        el.heights.push(v);
        if (v === "auto") el.scrollTop = 0;
      },
    },
  };
  return el as typeof el & HTMLElement;
}

const max = () => FIT_MAX;

describe("fitInput", () => {
  it("keeps where the box was scrolled to, which `height: auto` would have sent to the top", () => {
    const el = fakeBox({ contentHeight: 300, scrollTop: 180 });
    fitInput(el, { caretOf: () => null, maxOf: max });
    expect(el.heights).toEqual(["auto", "120px"]);
    expect(el.scrollTop).toBe(180);
  });

  it("brings a caret below the box into view: the line a Shift+Enter just added", () => {
    // The box is 0..120 on the page; the new line's caret sits at 118..140.
    const el = fakeBox({ contentHeight: 300, scrollTop: 180 });
    fitInput(el, { caretOf: () => ({ top: 118, bottom: 140 }), maxOf: max });
    expect(el.scrollTop).toBe(180 + 20);
  });

  it("goes to the bottom when the caret is on an empty last line, which has no rectangle", () => {
    const el = fakeBox({ contentHeight: 300, scrollTop: 0 });
    fitInput(el, { caretOf: () => "end" as CaretSpot, maxOf: max });
    expect(el.scrollTop).toBe(300);
  });

  it("goes to the top when the caret is at the very start", () => {
    const el = fakeBox({ contentHeight: 300, scrollTop: 90 });
    fitInput(el, { caretOf: () => "start" as CaretSpot, maxOf: max });
    expect(el.scrollTop).toBe(0);
  });

  it("scrolls up to a caret in the middle that is above the box", () => {
    const el = fakeBox({ contentHeight: 300, scrollTop: 150, rect: { top: 50, bottom: 170 } });
    fitInput(el, { caretOf: () => ({ top: 40, bottom: 60 }), maxOf: max });
    expect(el.scrollTop).toBe(140);
  });

  it("grows to the content up to the limit, and not past it", () => {
    const small = fakeBox({ contentHeight: 56, scrollTop: 0 });
    fitInput(small, { caretOf: () => null, maxOf: max });
    expect(small.heights).toEqual(["auto", "56px"]);
    // The limit is the stylesheet's, which follows the chat's text size.
    const big = fakeBox({ contentHeight: 500, scrollTop: 0 });
    fitInput(big, { caretOf: () => null, maxOf: () => 168 });
    expect(big.heights).toEqual(["auto", "168px"]);
  });
});
