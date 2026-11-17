import { describe, expect, it } from "vitest";
import { baseName, droppedAttaches } from "./dropAttach";

describe("droppedAttaches", () => {
  it("keeps each file where it sits, by its name", () => {
    expect(droppedAttaches(["/Users/me/Downloads/13_쿠폰팩.png"], ["file"])).toEqual([
      { name: "13_쿠폰팩.png", path: "/Users/me/Downloads/13_쿠폰팩.png", image: true },
    ]);
  });

  it("tells pictures, clips and other files apart", () => {
    const got = droppedAttaches(
      ["/a/Shot 1.PNG", "/a/clip.mov", "/a/voice.m4a", "/a/notes.md", "/a/Makefile"],
      ["file", "file", "file", "file", "file"],
    );
    expect(got.map((a) => [a.name, a.image, a.media])).toEqual([
      ["Shot 1.PNG", true, undefined],
      ["clip.mov", false, "video"],
      ["voice.m4a", false, "audio"],
      ["notes.md", false, undefined],
      ["Makefile", false, undefined],
    ]);
  });

  it("attaches a folder as a folder at its own path", () => {
    expect(droppedAttaches(["/Users/me/proj.v2/"], ["dir"])).toEqual([
      { name: "proj.v2", path: "/Users/me/proj.v2/", image: false, dir: true },
    ]);
  });

  it("leaves out what is gone, empty, a repeat, or already attached", () => {
    const got = droppedAttaches(
      ["/a/gone.txt", "", "/a/x.txt", "/a/x.txt", "/a/y.txt"],
      ["missing", "file", "file", "file", "file"],
      ["/a/y.txt"],
    );
    expect(got.map((a) => a.path)).toEqual(["/a/x.txt"]);
  });

  it("takes a path it could not ask about as a file", () => {
    expect(droppedAttaches(["/a/b.txt"], [])).toEqual([{ name: "b.txt", path: "/a/b.txt", image: false }]);
  });
});

describe("baseName", () => {
  it("is the last part of the path", () => {
    expect(baseName("/a/b/c.txt")).toBe("c.txt");
    expect(baseName("/a/b/")).toBe("b");
    expect(baseName("C:\\x\\y.png")).toBe("y.png");
  });
});
