import { describe, expect, it } from "vitest";
import { translate, type TFn } from "./i18n";
import { modelRows } from "./options";

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
