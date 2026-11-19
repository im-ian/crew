import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchViewport } from "./mobile";

/**
 * iOS moves the visual viewport down to keep a focused field above the
 * keyboard. When the keyboard goes, it can put `offsetTop` back to 0 without
 * a `scroll` event; the app then stayed pushed down by the old offset.
 */

class FakeElement {}
class FakeInput extends FakeElement {
  type = "text";
}

function events() {
  const map = new Map<string, Set<() => void>>();
  return {
    addEventListener: (k: string, fn: () => void) => {
      if (!map.has(k)) map.set(k, new Set());
      map.get(k)!.add(fn);
    },
    removeEventListener: (k: string, fn: () => void) => map.get(k)?.delete(fn),
    fire: (k: string) => map.get(k)?.forEach((fn) => fn()),
  };
}

function setup() {
  const vv = { width: 390, height: 844, offsetTop: 0, scale: 1, ...events() };
  const doc = { activeElement: null as FakeElement | null, ...events() };
  const win = { visualViewport: vv, scrollY: 0, scrollTo: vi.fn(), ...events() };
  const props = new Map<string, string>();
  const classes = new Set<string>();
  const root = {
    style: {
      setProperty: (k: string, v: string) => props.set(k, v),
      removeProperty: (k: string) => props.delete(k),
    },
    classList: {
      toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)),
      remove: (c: string) => classes.delete(c),
    },
  };
  vi.stubGlobal("window", Object.assign(win, { setTimeout, clearTimeout }));
  vi.stubGlobal("document", doc);
  vi.stubGlobal("HTMLTextAreaElement", class {});
  vi.stubGlobal("HTMLInputElement", FakeInput);
  vi.stubGlobal("HTMLElement", class {});
  const stop = watchViewport(root as unknown as HTMLElement);
  return { vv, doc, win, props, classes, stop };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the phone layout after the keyboard", () => {
  it("is back at the top once the keyboard is gone, even with no event for it", () => {
    const { vv, doc, props, classes, stop } = setup();
    // Tap the composer: the keyboard comes up and iOS slides the view down.
    doc.activeElement = new FakeInput();
    doc.fire("focusin");
    vv.height = 480;
    vv.fire("resize");
    vv.offsetTop = 120;
    vv.fire("scroll");
    expect(props.get("--vv-top")).toBe("120px");
    expect(classes.has("kb-open")).toBe(true);
    // The keyboard goes. The resize comes while the offset is still 120;
    // iOS puts it back to 0 a moment later and says nothing.
    doc.activeElement = null;
    doc.fire("focusout");
    vv.height = 844;
    vv.fire("resize");
    vv.offsetTop = 0;
    vi.advanceTimersByTime(1000);
    expect(classes.has("kb-open")).toBe(false);
    expect(props.get("--vv-top")).toBe("0px");
    stop();
  });

  it("scrolls the page back to the top that iOS left scrolled", () => {
    const { vv, doc, win, stop } = setup();
    doc.activeElement = new FakeInput();
    doc.fire("focusin");
    vv.height = 480;
    vv.fire("resize");
    win.scrollY = 64;
    doc.activeElement = null;
    doc.fire("focusout");
    vv.height = 844;
    vv.fire("resize");
    vi.advanceTimersByTime(1000);
    expect(win.scrollTo).toHaveBeenCalledWith(0, 0);
    stop();
  });

  it("reads the view again when the page comes back from the background", () => {
    const { vv, doc, props, classes, stop } = setup();
    doc.activeElement = new FakeInput();
    doc.fire("focusin");
    vv.height = 480;
    vv.fire("resize");
    vv.offsetTop = 290;
    vv.fire("scroll");
    // Away with the keyboard up. Back, iOS has put the view right while
    // the page slept, and no viewport or focus event says so.
    vv.height = 844;
    vv.offsetTop = 0;
    doc.fire("visibilitychange");
    expect(props.get("--vv-top")).toBe("0px");
    expect(classes.has("kb-open")).toBe(false);
    stop();
  });

  it("does not pin the app to a pinched-in page", () => {
    const { vv, props, stop } = setup();
    vv.scale = 2;
    vv.offsetTop = 300;
    vv.fire("scroll");
    expect(props.get("--vv-top")).toBe("0px");
    stop();
  });

  it("leaves the page where it is while the keyboard is up", () => {
    const { vv, doc, win, stop } = setup();
    doc.activeElement = new FakeInput();
    doc.fire("focusin");
    vv.height = 480;
    vv.fire("resize");
    win.scrollY = 64;
    vi.advanceTimersByTime(1000);
    expect(win.scrollTo).not.toHaveBeenCalled();
    stop();
  });
});
