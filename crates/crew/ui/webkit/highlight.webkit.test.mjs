// The file panel's colors on JavaScriptCore, the engine the app's web view
// runs. Vitest runs on V8, which never had WebKit's regex bug, so on a Mac
// this bundles `src/highlight.ts` and runs it on the system's `jsc`. It lives
// outside `src` because it needs Node's APIs, which the app's types leave out.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { highlightLines } from "../src/highlight.ts";

const JSC = "/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc";
const SAMPLE = "const a = []; // see `x\nconst b = 2;";
const MODULE = fileURLToPath(new URL("../src/highlight.ts", import.meta.url));

describe.runIf(process.platform === "darwin" && existsSync(JSC))("highlight on JavaScriptCore", () => {
  it("colors a comment after code the way V8 does", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crew-jsc-"));
    const entry = join(dir, "entry.mjs");
    writeFileSync(
      entry,
      `import { highlightLines } from ${JSON.stringify(MODULE)};
const lines = await highlightLines(${JSON.stringify(SAMPLE)}, "typescript");
print(JSON.stringify(lines.map((line) => line.map((t) => [t.text, t.dark]))));`,
    );
    const out = join(dir, "out.mjs");
    await build({ entryPoints: [entry], bundle: true, format: "esm", outfile: out, logLevel: "silent" });
    const onJsc = JSON.parse(execFileSync(JSC, ["-m", out], { encoding: "utf8" }).trim());
    const onV8 = (await highlightLines(SAMPLE, "typescript")).map((line) => line.map((t) => [t.text, t.dark]));
    expect(onJsc).toEqual(onV8);
    expect(onJsc[0].at(-1)).toEqual(["// see `x", "#6A737D"]);
  }, 30_000);
});
