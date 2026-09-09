import { describe, expect, it } from "vitest";
import { numberDuplicateNames } from "./rail";

function items(...pairs: Array<[string, string, string?]>) {
  return pairs.map(
    ([id, name, kind = "agent"]) =>
      ({ id, name, kind }) as { id: string; name: string; kind: string; ordinal?: number },
  );
}

describe("numberDuplicateNames", () => {
  it("leaves a name that appears once alone", () => {
    const list = items(["bot-a", "춘식이"], ["bot-b", "죠르디"]);
    numberDuplicateNames(list);
    expect(list.map((i) => i.ordinal)).toEqual([undefined, undefined]);
  });

  it("numbers every row of a repeated name, not just the later ones", () => {
    const list = items(["bot-a", "춘식이"], ["bot-b", "춘식이"], ["bot-c", "죠르디"]);
    numberDuplicateNames(list);
    expect(list.map((i) => i.ordinal)).toEqual([1, 2, undefined]);
  });

  it("numbers by id, so list order does not renumber the rows", () => {
    const listed = items(["bot-b", "춘식이"], ["bot-a", "춘식이"]);
    numberDuplicateNames(listed);
    expect(listed.map((i) => [i.id, i.ordinal])).toEqual([
      ["bot-b", 2],
      ["bot-a", 1],
    ]);
  });

  it("does not number a bot because a room shares its name", () => {
    const list = items(["room-a", "출시", "channel"], ["bot-a", "출시", "agent"]);
    numberDuplicateNames(list);
    expect(list.map((i) => i.ordinal)).toEqual([undefined, undefined]);
  });

  it("numbers two rooms of one name", () => {
    const list = items(["room-b", "출시", "channel"], ["room-a", "출시", "channel"]);
    numberDuplicateNames(list);
    expect(list.map((i) => i.ordinal)).toEqual([2, 1]);
  });
});
