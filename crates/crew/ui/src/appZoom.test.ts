import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appZoomKey,
  decideAppZoom,
  imagePreviewOwnsZoom,
  loadAppZoom,
  nextAppZoom,
  parseAppZoom,
  saveAppZoom,
  ZOOM_MAX,
  ZOOM_MIN,
} from "./appZoom";

describe("appZoomKey", () => {
  it("zooms in on ⌘= and ⌘+", () => {
    expect(appZoomKey({ key: "=", metaKey: true })).toBe("in");
    expect(appZoomKey({ key: "+", metaKey: true })).toBe("in");
    expect(appZoomKey({ key: "=", ctrlKey: true })).toBe("in");
  });

  it("zooms out on ⌘− and resets on ⌘0", () => {
    expect(appZoomKey({ key: "-", metaKey: true })).toBe("out");
    expect(appZoomKey({ key: "_", metaKey: true })).toBe("out");
    expect(appZoomKey({ key: "0", metaKey: true })).toBe("reset");
  });

  it("leaves bare + − 0, and ⌘ with alt, alone", () => {
    expect(appZoomKey({ key: "+" })).toBeNull();
    expect(appZoomKey({ key: "-" })).toBeNull();
    expect(appZoomKey({ key: "0" })).toBeNull();
    expect(appZoomKey({ key: "=", metaKey: true, altKey: true })).toBeNull();
    expect(appZoomKey({ key: "ArrowLeft", metaKey: true })).toBeNull();
    expect(appZoomKey({ key: "=", metaKey: true, isComposing: true })).toBeNull();
  });
});

describe("nextAppZoom", () => {
  it("steps 10% between 50% and 200% and stops at the ends", () => {
    expect(ZOOM_MIN).toBe(0.5);
    expect(ZOOM_MAX).toBe(2);
    let scale = 1;
    const up: number[] = [];
    for (let i = 0; i < 12; i++) {
      scale = nextAppZoom(scale, "in");
      up.push(scale);
    }
    expect(up.slice(0, 10)).toEqual([1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2]);
    expect(up[11]).toBe(2);

    scale = 1;
    const down: number[] = [];
    for (let i = 0; i < 7; i++) {
      scale = nextAppZoom(scale, "out");
      down.push(scale);
    }
    expect(down).toEqual([0.9, 0.8, 0.7, 0.6, 0.5, 0.5, 0.5]);
    expect(nextAppZoom(1.7, "reset")).toBe(1);
  });
});

describe("parseAppZoom", () => {
  it("keeps a saved step and drops junk", () => {
    expect(parseAppZoom(null)).toBe(1);
    expect(parseAppZoom("")).toBe(1);
    expect(parseAppZoom("nope")).toBe(1);
    expect(parseAppZoom("1.5")).toBe(1.5);
    expect(parseAppZoom("3")).toBe(2);
    expect(parseAppZoom("0.2")).toBe(0.5);
  });
});

describe("app zoom storage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("remembers the scale", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    });
    expect(loadAppZoom()).toBe(1);
    saveAppZoom(1.3);
    expect(loadAppZoom()).toBe(1.3);
    expect(store.get("crew.zoom")).toBe("1.3");
  });
});

describe("decideAppZoom", () => {
  it("gives an open picture the zoom keys", () => {
    expect(decideAppZoom({ key: "=", metaKey: true }, 1, true)).toBeNull();
    expect(decideAppZoom({ key: "+", metaKey: true }, 1, true)).toBeNull();
    expect(decideAppZoom({ key: "-", metaKey: true }, 1, true)).toBeNull();
    expect(decideAppZoom({ key: "0", metaKey: true }, 1.4, true)).toBeNull();
  });

  it("changes the window when no picture is open, even at the ends", () => {
    expect(decideAppZoom({ key: "=", metaKey: true }, 1, false)).toBe(1.1);
    expect(decideAppZoom({ key: "+", metaKey: true }, 1, false)).toBe(1.1);
    expect(decideAppZoom({ key: "-", metaKey: true }, 1, false)).toBe(0.9);
    expect(decideAppZoom({ key: "0", metaKey: true }, 1.4, false)).toBe(1);
    expect(decideAppZoom({ key: "=", metaKey: true }, 2, false)).toBe(2);
    expect(decideAppZoom({ key: "+" }, 1, false)).toBeNull();
  });
});

describe("imagePreviewOwnsZoom", () => {
  it("is true only while the preview is showing a picture", () => {
    const empty = { querySelector: () => null };
    const picture = {
      querySelector: (sel: string) => (sel === ".img-preview img" ? {} : null),
    };
    expect(imagePreviewOwnsZoom(empty)).toBe(false);
    expect(imagePreviewOwnsZoom(picture)).toBe(true);
  });
});
