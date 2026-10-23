import { describe, expect, it } from "vitest";
import { translate, type TFn } from "./i18n";
import { cliFromCmd, formatCmd, modelLine, modelRows, pinnedDefault } from "./options";

const t: TFn = (key, vars) => translate("ko", key, vars);

describe("modelRows", () => {
  it("leads with the default and names it when the CLI reports one", () => {
    const rows = modelRows({ models: ["gpt-5.4"], default: "gpt-5.6-sol", installed: true }, "", t);
    expect(rows.map((r) => [r.value, r.hint])).toEqual([
      ["", "gpt-5.6-sol"],
      ["gpt-5.4", undefined],
    ]);
  });

  it("says what each Claude alias is for", () => {
    const rows = modelRows({ models: ["sonnet", "fable"], installed: true }, "", t);
    expect(rows.map((r) => r.hint)).toEqual(["CLI 설정", "균형", undefined]);
  });

  it("keeps a saved model the CLI no longer lists, once", () => {
    const list = { models: ["opus"], installed: true };
    expect(modelRows(list, "old-model", t).map((r) => r.value)).toEqual(["", "opus", "old-model"]);
    expect(modelRows(list, "opus", t).map((r) => r.value)).toEqual(["", "opus"]);
    expect(modelRows(undefined, "", t).map((r) => r.value)).toEqual([""]);
  });
});

describe("modelLine", () => {
  it("names the CLI, the chosen model, and how hard it thinks", () => {
    expect(
      modelLine({ cmd: ["claude"], model: "opus", effort: "high" }, null, t),
    ).toBe("Claude · opus · 생각 꼼꼼하게");
  });

  it("uses the CLI's reported default when the bot left the model empty", () => {
    expect(
      modelLine({ cmd: ["/opt/grok"], model: null, effort: "low" }, "grok-4.6", t),
    ).toBe("Grok · grok-4.6 · 생각 가볍게");
  });

  it("says default until a model id is known, and for an unset effort", () => {
    expect(modelLine({ cmd: ["codex"], model: "  ", effort: "" }, "  ", t)).toBe(
      "Codex · 기본값 · 생각 기본",
    );
  });

  it("stays quiet for a terminal command", () => {
    expect(modelLine({ cmd: ["python"], model: "opus", effort: "high" }, null, t)).toBe(
      null,
    );
  });

  it("names a prompt-mode CLI without a think level it does not take", () => {
    expect(modelLine({ cmd: ["gemini"], model: "", effort: "high" }, null, t)).toBe(
      "Gemini · 기본값",
    );
    expect(
      modelLine({ cmd: ["agy"], model: "gemini-3.8-flash-low", effort: "low" }, null, t),
    ).toBe("Antigravity · gemini-3.8-flash-low · 생각 가볍게");
  });

  it("names a headless command by its program", () => {
    expect(
      modelLine({ cmd: ["my-ai", "--print"], headless: true, model: "", effort: "" }, null, t),
    ).toBe("명령 · my-ai");
  });
});

describe("cliFromCmd", () => {
  it("knows the preset binaries and leaves a terminal alone", () => {
    expect(cliFromCmd(["/opt/homebrew/bin/agy"])).toBe("agy");
    expect(cliFromCmd(["opencode"])).toBe("opencode");
    expect(cliFromCmd(["cat"])).toBeNull();
    expect(cliFromCmd(["my-ai"], true)).toBe("custom");
    expect(formatCmd(["my-ai", "say hi"])).toBe('my-ai "say hi"');
    expect(formatCmd(["my-ai", "C:\\tools\\ai"])).toBe('my-ai "C:\\\\tools\\\\ai"');
  });
});

describe("pinnedDefault", () => {
  it("pins an installed CLI's default id, or null when it has none", () => {
    expect(pinnedDefault({ installed: true, default: " grok-4.6 " })).toBe("grok-4.6");
    expect(pinnedDefault({ installed: true, default: "  " })).toBe(null);
    expect(pinnedDefault({ installed: true })).toBe(null);
  });

  it("leaves a missing CLI unknown even when a default string came back", () => {
    expect(pinnedDefault({ installed: false, default: "gpt-5.4" })).toBeUndefined();
  });
});
