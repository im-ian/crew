import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../transport", async (real) => ({
  ...(await real<typeof import("../transport")>()),
  fileSrc: (path: string) => `asset://localhost${path}`,
}));
import { LocaleProvider } from "../LocaleContext";
import { FileView, fileMedia } from "./FileView";

function draw(path: string) {
  return renderToStaticMarkup(
    <LocaleProvider>
      <FileView files={[{ path }]} at={0} onPick={() => {}} onCloseTab={() => {}} onClose={() => {}} />
    </LocaleProvider>,
  );
}

describe("fileMedia", () => {
  it("knows a picture and a video by the name, an svg being neither", () => {
    expect(fileMedia("/tmp/qab/a.png")).toBe("image");
    expect(fileMedia("/tmp/qab/a.JPEG")).toBe("image");
    expect(fileMedia("/tmp/qab/a.webp")).toBe("image");
    expect(fileMedia("/tmp/qab/run.mp4")).toBe("video");
    expect(fileMedia("/tmp/qab/run.webm")).toBe("video");
    expect(fileMedia("/tmp/qab/run.mov")).toBe("video");
    expect(fileMedia("/tmp/qab/a.svg")).toBeNull();
    expect(fileMedia("/tmp/qab/a.ts")).toBeNull();
  });
});

describe("FileView", () => {
  it("shows a picture `crew show` opened, not its bytes", () => {
    const html = draw("/tmp/qab/rail.png");
    expect(html).toContain('<img class="file-media" src="asset://localhost/tmp/qab/rail.png" alt="rail.png"/>');
    expect(html).toContain("file-body is-media");
    expect(html).not.toContain("불러오는 중");
  });

  it("gives a video a player at its first frame that does not start on its own", () => {
    const html = draw("/tmp/qab/run.mp4");
    expect(html).toContain('<video class="file-media" src="asset://localhost/tmp/qab/run.mp4#t=0.1" controls=""');
    expect(html).not.toContain("autoplay");
  });

  it("still reads a code file as text", () => {
    const html = draw("/tmp/qab/main.rs");
    expect(html).toContain("불러오는 중");
    expect(html).not.toContain("file-media");
  });
});
